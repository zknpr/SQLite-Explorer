/**
 * JSON Merge Patch Generator (RFC 7396)
 *
 * Generates a patch P such that MergePatch(Original, P) approx Modified.
 * Note: RFC 7396 Merge Patch is lossy for null values (it uses null to delete keys).
 * If the modified value contains null, it will be treated as deletion if used in a patch.
 * SQLite's json_patch works this way.
 */

import type { CellUpdateOperation, CellValue } from './types';

const MAX_DEPTH = 1000;

/**
 * Derive the value and operation to store from the database value observed in
 * the same transaction. Pre-built patches used by history replay are retained.
 */
export function prepareCellUpdateForStorage(
    value: CellValue,
    priorValue: CellValue | undefined,
    requestedOperation: CellUpdateOperation = 'set'
): { value: CellValue; operation: CellUpdateOperation } {
    if (requestedOperation === 'json_patch') {
        return { value, operation: 'json_patch' };
    }
    if (
        typeof value !== 'string' ||
        typeof priorValue !== 'string' ||
        !(value.startsWith('{') || value.startsWith('[')) ||
        !(priorValue.startsWith('{') || priorValue.startsWith('['))
    ) {
        return { value, operation: 'set' };
    }
    try {
        const originalObject = JSON.parse(priorValue);
        const newObject = JSON.parse(value);
        if (
            !originalObject || typeof originalObject !== 'object' || Array.isArray(originalObject) ||
            !newObject || typeof newObject !== 'object' || Array.isArray(newObject)
        ) {
            return { value, operation: 'set' };
        }
        const patch = generateMergePatch(originalObject, newObject);
        // Applying a patch that carries null would delete keys instead of
        // storing the user's explicit null (RFC 7396) — store the full value.
        return patch === undefined || mergePatchContainsNull(patch)
            ? { value, operation: 'set' }
            : { value: JSON.stringify(patch), operation: 'json_patch' };
    } catch {
        return { value, operation: 'set' };
    }
}

/**
 * True when a merge patch holds null as an object member at any depth. Arrays
 * are exempt: RFC 7396 copies them verbatim (both SQLite's json_patch and
 * applyMergePatch), so nulls inside them are data, not delete markers.
 * Depth is bounded because generateMergePatch already enforced MAX_DEPTH.
 */
function mergePatchContainsNull(patch: unknown): boolean {
    if (patch === null) return true;
    if (!isObject(patch)) return false;
    return Object.values(patch).some(mergePatchContainsNull);
}

export function generateMergePatch(original: unknown, modified: unknown, depth = 0): unknown {
    if (depth > MAX_DEPTH) {
        throw new Error('JSON merge patch depth limit exceeded');
    }

    if (original === modified) {
        return undefined; // No change
    }

    // If either is not an object or is an array, we cannot patch (replace/overwrite)
    // RFC 7396 says arrays are replaced whole.
    if (
        !isObject(original) || !isObject(modified) ||
        Array.isArray(original) || Array.isArray(modified)
    ) {
        return modified;
    }

    // Null-prototype accumulator: on a plain object, patch["__proto__"] = x hits
    // the legacy prototype setter and creates NO own property, so the key would
    // silently vanish from the emitted patch (cf. restoreInto).
    const patch: Record<string, unknown> = Object.create(null);
    let hasChanges = false;

    // Check for modifications and additions. Reads must be own-property reads:
    // obj["__proto__"]/"constructor"/... on a key the object does NOT carry
    // returns the inherited Object.prototype member instead of undefined, which
    // would misclassify additions and mask deletions of such keys.
    for (const key of Object.keys(modified)) {
        const originalVal = Object.prototype.hasOwnProperty.call(original, key)
            ? original[key]
            : undefined;
        const modifiedVal = modified[key];

        if (originalVal === undefined) {
            // Addition
            patch[key] = modifiedVal;
            hasChanges = true;
        } else if (originalVal !== modifiedVal) {
            // Modification
            const subPatch = generateMergePatch(originalVal, modifiedVal, depth + 1);
            if (subPatch !== undefined) {
                patch[key] = subPatch;
                hasChanges = true;
            }
        }
    }

    // Check for deletions
    for (const key of Object.keys(original)) {
        if (!Object.prototype.hasOwnProperty.call(modified, key)) {
            patch[key] = null; // Deletion indicator in Merge Patch
            hasChanges = true;
        }
    }

    return hasChanges ? patch : undefined;
}

/**
 * Apply a JSON Merge Patch (RFC 7396) to a target object.
 *
 * @param target - The original object (will be mutated or cloned? RFC implies transformation)
 * @param patch - The patch to apply
 * @returns The modified object (new instance or mutated)
 */
export function applyMergePatch(target: unknown, patch: unknown, depth = 0): unknown {
    if (depth > MAX_DEPTH) {
        throw new Error('JSON apply merge patch depth limit exceeded');
    }

    if (patch === null) {
        // If patch is null, it typically means deletion in a parent context,
        // but at the root level, it means the result is null.
        return null;
    }

    if (typeof patch !== 'object' || Array.isArray(patch)) {
        // If patch is a primitive or array, it replaces the target.
        return patch;
    }

    let targetObj: Record<string, unknown>;
    if (typeof target !== 'object' || target === null || Array.isArray(target)) {
        // If target is not an object (or is null/array), it is treated as empty object for patching.
        targetObj = Object.create(null);
    } else {
        // Shallow null-prototype clone (cf. restoreInto): keeps "__proto__" and
        // friends as ordinary own data keys, so the reads, writes and deletes
        // below cannot fall through to (or write through) Object.prototype —
        // on a plain clone, targetObj["__proto__"] = x would silently swap the
        // prototype instead of storing the patched key.
        targetObj = Object.assign(Object.create(null), target);
    }

    const patchObj = patch as Record<string, unknown>;
    for (const key in patchObj) {
        if (Object.prototype.hasOwnProperty.call(patchObj, key)) {
            const val = patchObj[key];
            if (val === null) {
                delete targetObj[key];
            } else {
                targetObj[key] = applyMergePatch(targetObj[key], val, depth + 1);
            }
        }
    }

    return targetObj;
}

export function parseJsonValueForPatching(val: unknown, context: string): Record<string, unknown> {
    if (typeof val === 'string') {
        try {
            return JSON.parse(val);
        } catch (e) {
            console.warn(`Failed to parse current JSON value for patching (${context})`, e);
        }
    } else if (typeof val === 'object' && val !== null && !(val instanceof Uint8Array)) {
        return val as Record<string, unknown>;
    }
    return {};
}

export type JsonUndoPlan =
    | { kind: 'restore'; value: string }
    | { kind: 'replace' };

export type JsonPatchHistoryReplayDirection = 'undo' | 'redo';

export type JsonPatchHistoryReplayPlan =
    | { kind: 'write'; value: CellValue }
    | { kind: 'conflict' };

/** Parse a raw cell value to a plain JSON object, or undefined if it is not one. */
function parseJsonObject(raw: unknown): Record<string, unknown> | undefined {
    if (typeof raw !== 'string') return undefined;
    try {
        const parsed = JSON.parse(raw);
        return isObject(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Decide how to undo a forward json_patch cell edit by read-modify-write.
 *
 * Surgical restore requires current, forwardPatch, and prior to all be JSON
 * objects; otherwise we value-replace to the recorded prior. When prior is SQL
 * NULL, scalar, or array, value-replace deliberately preserves the previous
 * behavior for that extreme non-object corner.
 *
 * @param currentRaw the cell value read from the DB now
 * @param forwardPatchRaw the recorded forward merge patch
 * @param priorRaw the recorded full prior cell value
 */
export function computeJsonPatchUndo(
    currentRaw: unknown,
    forwardPatchRaw: unknown,
    priorRaw: unknown
): JsonUndoPlan {
    // Some JSON number tokens cannot round-trip through JSON.parse/JSON.stringify
    // safely. In that case undo falls back to the recorded prior string so
    // untouched sibling numbers remain byte-exact.
    if (hasPrecisionRiskyNumber(currentRaw) || hasPrecisionRiskyNumber(priorRaw)) {
        return { kind: 'replace' };
    }

    const current = parseJsonObject(currentRaw);
    const forwardPatch = parseJsonObject(forwardPatchRaw);
    const prior = parseJsonObject(priorRaw);
    if (!current || !forwardPatch || !prior) {
        return { kind: 'replace' };
    }
    return { kind: 'restore', value: JSON.stringify(restoreInto(current, forwardPatch, prior, 0)) };
}

/**
 * Plan a guarded JSON merge-patch undo/redo without overwriting unrelated keys.
 *
 * Object patches validate only the paths the forward patch touched. This lets a
 * concurrent sibling survive history replay while rejecting a concurrent edit
 * to the same path. Cases that cannot round-trip through JavaScript JSON
 * exactly fall back to byte-for-byte whole-cell comparison.
 */
export function planJsonPatchHistoryReplay(
    currentRaw: CellValue,
    forwardPatchRaw: CellValue,
    priorRaw: CellValue,
    postRaw: CellValue,
    direction: JsonPatchHistoryReplayDirection
): JsonPatchHistoryReplayPlan {
    const expectedRaw = direction === 'undo' ? postRaw : priorRaw;
    const targetRaw = direction === 'undo' ? priorRaw : postRaw;
    const exactPlan = (): JsonPatchHistoryReplayPlan => (
        cellValuesEqual(currentRaw, expectedRaw)
            ? { kind: 'write', value: targetRaw }
            : { kind: 'conflict' }
    );

    if (
        hasPrecisionRiskyNumber(currentRaw)
        || hasPrecisionRiskyNumber(forwardPatchRaw)
        || hasPrecisionRiskyNumber(priorRaw)
        || hasPrecisionRiskyNumber(postRaw)
    ) {
        return exactPlan();
    }

    const current = parseJsonObject(currentRaw);
    const forwardPatch = parseJsonObject(forwardPatchRaw);
    const prior = parseJsonObject(priorRaw);
    const post = parseJsonObject(postRaw);
    if (!current || !forwardPatch || !prior || !post) {
        return exactPlan();
    }

    const expected = direction === 'undo' ? post : prior;
    if (!patchFootprintMatches(current, expected, forwardPatch, prior, 0)) {
        return { kind: 'conflict' };
    }

    const replayed = direction === 'undo'
        ? restoreInto(current, forwardPatch, prior, 0)
        : applyMergePatch(current, forwardPatch, 0);
    return { kind: 'write', value: JSON.stringify(replayed) };
}

/** Validate only the object branches and leaves selected by a merge patch. */
function patchFootprintMatches(
    currentObj: Record<string, unknown>,
    expectedObj: Record<string, unknown>,
    patchObj: Record<string, unknown>,
    forwardPriorObj: Record<string, unknown>,
    depth: number
): boolean {
    if (depth > MAX_DEPTH) {
        throw new Error('JSON history replay depth limit exceeded');
    }
    for (const key of Object.keys(patchObj)) {
        const patchValue = patchObj[key];
        const currentHas = Object.prototype.hasOwnProperty.call(currentObj, key);
        const expectedHas = Object.prototype.hasOwnProperty.call(expectedObj, key);
        const forwardPriorHas = Object.prototype.hasOwnProperty.call(forwardPriorObj, key);
        const currentValue = currentHas ? currentObj[key] : undefined;
        const expectedValue = expectedHas ? expectedObj[key] : undefined;
        const forwardPriorValue = forwardPriorHas ? forwardPriorObj[key] : undefined;

        if (isObject(patchValue)) {
            if (!forwardPriorHas || !isObject(forwardPriorValue)) {
                // The forward edit created/replaced this whole branch. Undo may
                // delete or value-replace it, so accepting a new descendant
                // sibling here would clobber that external write.
                if (!jsonOwnValueEqual(currentHas, currentValue, expectedHas, expectedValue, depth + 1)) {
                    return false;
                }
                continue;
            }
            if (
                !currentHas || !isObject(currentValue)
                || !expectedHas || !isObject(expectedValue)
            ) {
                return false;
            }
            if (!patchFootprintMatches(
                currentValue,
                expectedValue,
                patchValue,
                forwardPriorValue,
                depth + 1
            )) {
                return false;
            }
            continue;
        }

        // RFC 7396 treats arrays, scalars, and null as atomic patch leaves.
        if (!jsonOwnValueEqual(currentHas, currentValue, expectedHas, expectedValue, depth + 1)) {
            return false;
        }
    }
    return true;
}

function jsonOwnValueEqual(
    leftHas: boolean,
    left: unknown,
    rightHas: boolean,
    right: unknown,
    depth: number
): boolean {
    return leftHas === rightHas && (!leftHas || jsonValueEqual(left, right, depth));
}

function jsonValueEqual(left: unknown, right: unknown, depth: number): boolean {
    if (depth > MAX_DEPTH) {
        throw new Error('JSON history replay depth limit exceeded');
    }
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        return left.every((value, index) => jsonValueEqual(value, right[index], depth + 1));
    }
    if (!isObject(left) || !isObject(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(key => (
        Object.prototype.hasOwnProperty.call(right, key)
        && jsonValueEqual(left[key], right[key], depth + 1)
    ));
}

function cellValuesEqual(left: CellValue, right: CellValue): boolean {
    if (left instanceof Uint8Array || right instanceof Uint8Array) {
        if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
        return left.length === right.length && left.every((byte, index) => byte === right[index]);
    }
    return Object.is(left, right);
}

/**
 * Walk only the forward patch's key structure, restoring each touched key from
 * prior into a clone of current; keys absent from the patch are untouched.
 */
function restoreInto(
    currentObj: Record<string, unknown>,
    patchObj: Record<string, unknown>,
    priorObj: Record<string, unknown>,
    depth: number
): Record<string, unknown> {
    if (depth > MAX_DEPTH) {
        throw new Error('JSON undo restore depth limit exceeded');
    }
    // Null-prototype clones treat keys such as "__proto__" and "constructor"
    // as ordinary JSON data instead of inherited accessors/properties.
    const result: Record<string, unknown> = Object.assign(Object.create(null), currentObj);
    for (const key of Object.keys(patchObj)) {
        const pv = patchObj[key];
        const priorHas = Object.prototype.hasOwnProperty.call(priorObj, key);
        const priorVal = priorHas ? priorObj[key] : undefined;

        if (isObject(pv)) {
            if (priorHas && isObject(priorVal)) {
                if (Object.prototype.hasOwnProperty.call(result, key) && isObject(result[key])) {
                    const base = result[key] as Record<string, unknown>;
                    result[key] = restoreInto(base, pv, priorVal, depth + 1);
                } else {
                    result[key] = priorVal;
                }
            } else if (priorHas) {
                result[key] = priorVal;
            } else {
                const base = (Object.prototype.hasOwnProperty.call(result, key) && isObject(result[key]))
                    ? (result[key] as Record<string, unknown>)
                    : Object.create(null);
                const child = restoreInto(base, pv, Object.create(null), depth + 1);
                if (Object.keys(child).length === 0) {
                    delete result[key];
                } else {
                    result[key] = child;
                }
            }
        } else if (priorHas) {
            result[key] = priorVal;
        } else {
            delete result[key];
        }
    }
    return result;
}

function hasPrecisionRiskyNumber(raw: unknown): boolean {
    if (typeof raw !== 'string') return false;
    // Neutralize string literals so only structural JSON number tokens are inspected.
    const structural = raw.replace(/"(?:\\.|[^"\\])*"/g, '""');
    const tokens = structural.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g);
    if (!tokens) return false;
    return tokens.some(tok => {
        const n = Number(tok);
        // Non-finite overflow (e.g. 1e999 -> Infinity), or any token whose exact
        // text a JSON parse/serialize round-trip does not reproduce — large
        // integers and high-precision decimals alike — cannot be restored by RMW
        // without changing the stored number. Value-replace writes the recorded
        // prior string back byte-exact instead.
        return !Number.isFinite(n) || JSON.stringify(n) !== tok;
    });
}

function isObject(val: unknown): val is Record<string, unknown> {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
}

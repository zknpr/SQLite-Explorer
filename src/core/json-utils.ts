/**
 * JSON Merge Patch Generator (RFC 7396)
 *
 * Generates a patch P such that MergePatch(Original, P) approx Modified.
 * Note: RFC 7396 Merge Patch is lossy for null values (it uses null to delete keys).
 * If the modified value contains null, it will be treated as deletion if used in a patch.
 * SQLite's json_patch works this way.
 */

const MAX_DEPTH = 1000;

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

    const patch: Record<string, unknown> = {};
    let hasChanges = false;

    // Check for modifications and additions
    for (const key of Object.keys(modified)) {
        const originalVal = original[key];
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
        if (modified[key] === undefined) {
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
        targetObj = {};
    } else {
        // Clone target to avoid mutation if we want immutability,
        // Clone shallowly for safety.
        targetObj = { ...(target as Record<string, unknown>) };
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

export type JsonUndoPlan =
    | { kind: 'restore'; value: string }
    | { kind: 'replace' };

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
    const current = parseJsonObject(currentRaw);
    const forwardPatch = parseJsonObject(forwardPatchRaw);
    const prior = parseJsonObject(priorRaw);
    if (!current || !forwardPatch || !prior) {
        return { kind: 'replace' };
    }
    return { kind: 'restore', value: JSON.stringify(restoreInto(current, forwardPatch, prior, 0)) };
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
    const result: Record<string, unknown> = { ...currentObj };
    for (const key of Object.keys(patchObj)) {
        const pv = patchObj[key];
        const priorHas = Object.prototype.hasOwnProperty.call(priorObj, key);
        const priorVal = priorHas ? priorObj[key] : undefined;

        if (isObject(pv)) {
            if (priorHas && isObject(priorVal)) {
                const base = isObject(result[key]) ? (result[key] as Record<string, unknown>) : {};
                result[key] = restoreInto(base, pv, priorVal, depth + 1);
            } else if (priorHas) {
                result[key] = priorVal;
            } else {
                const base = isObject(result[key]) ? (result[key] as Record<string, unknown>) : {};
                const child = restoreInto(base, pv, {}, depth + 1);
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

function isObject(val: unknown): val is Record<string, unknown> {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
}

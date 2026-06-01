/**
 * JSON Merge Patch Generator (RFC 7396)
 *
 * Generates a patch P such that MergePatch(Original, P) approx Modified.
 * Note: RFC 7396 Merge Patch is lossy for null values (it uses null to delete keys).
 * If the modified value contains null, it will be treated as deletion if used in a patch.
 * SQLite's json_patch works this way.
 */

const MAX_DEPTH = 1000;

class UnfaithfulInverseMergePatchError extends Error {
    constructor() {
        super('JSON inverse merge patch would not faithfully restore the prior value');
    }
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

/**
 * Build a JSON Merge Patch that reverses the keys touched by a forward patch.
 *
 * The inverse is intentionally restricted to the forward patch key structure so
 * undo can restore the edited keys without replacing concurrent sibling edits.
 */
export function invertMergePatch(forwardPatch: unknown, prior: unknown): unknown {
    return invertMergePatchAtDepth(forwardPatch, prior, 0);
}

/**
 * Convert recorded cell values into a serialized inverse merge patch.
 *
 * Undo uses this only when both recorded values are JSON strings and the prior
 * document is an object, matching SQLite json_patch object-merge semantics.
 */
export function tryCreateInverseMergePatch(forwardPatchValue: unknown, priorValue: unknown): string | undefined {
    if (typeof forwardPatchValue !== 'string' || typeof priorValue !== 'string') {
        return undefined;
    }

    const forwardPatch = parseJsonValue(forwardPatchValue);
    const prior = parseJsonValue(priorValue);
    if (!forwardPatch.ok || !prior.ok || !isObject(forwardPatch.value) || !isObject(prior.value)) {
        return undefined;
    }

    try {
        return JSON.stringify(invertMergePatch(forwardPatch.value, prior.value));
    } catch (err) {
        if (err instanceof UnfaithfulInverseMergePatchError) {
            return undefined;
        }
        throw err;
    }
}

function invertMergePatchAtDepth(forwardPatch: unknown, prior: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) {
        throw new Error('JSON invert merge patch depth limit exceeded');
    }

    if (!isObject(forwardPatch)) {
        return prior === undefined ? null : prior;
    }

    const inverse: Record<string, unknown> = {};
    const priorObj = isObject(prior) ? prior : {};

    for (const key of Object.keys(forwardPatch)) {
        const priorHas = Object.prototype.hasOwnProperty.call(priorObj, key);
        const priorVal = priorHas ? priorObj[key] : undefined;
        const forwardVal = forwardPatch[key];

        if (isObject(forwardVal)) {
            if (priorHas && isObject(priorVal)) {
                inverse[key] = invertMergePatchAtDepth(forwardVal, priorVal, depth + 1);
            } else if (priorHas && priorVal === null) {
                throw new UnfaithfulInverseMergePatchError();
            } else if (priorHas) {
                // A forward object patch replaced a scalar or array prior, so the inverse must restore that whole value.
                inverse[key] = priorVal;
            } else {
                // Recurse into added objects so undo deletes only the leaves touched by the forward patch.
                inverse[key] = invertMergePatchAtDepth(forwardVal, {}, depth + 1);
            }
        } else if (forwardVal === null) {
            inverse[key] = createInverseLeafValue(priorHas, priorVal);
        } else {
            inverse[key] = createInverseLeafValue(priorHas, priorVal);
        }
    }

    return inverse;
}

function createInverseLeafValue(priorHas: boolean, priorVal: unknown): unknown {
    if (!priorHas) {
        // RFC 7396 null deletes a key, which is faithful when the forward patch added that key.
        return null;
    }

    if (priorVal === null) {
        // RFC 7396 null would delete this existing key instead of restoring its explicit JSON null value.
        throw new UnfaithfulInverseMergePatchError();
    }

    return priorVal;
}

function parseJsonValue(value: string): { ok: true; value: unknown } | { ok: false } {
    try {
        return { ok: true, value: JSON.parse(value) };
    } catch {
        return { ok: false };
    }
}

function isObject(val: unknown): val is Record<string, unknown> {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
}

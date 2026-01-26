/**
 * JSON Merge Patch Generator (RFC 7396)
 *
 * Generates a patch P such that MergePatch(Original, P) approx Modified.
 * Note: RFC 7396 Merge Patch is lossy for null values (it uses null to delete keys).
 * If the modified value contains null, it will be treated as deletion if used in a patch.
 * SQLite's json_patch works this way.
 */

export function generateMergePatch(original: any, modified: any): any {
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

    const patch: Record<string, any> = {};
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
            const subPatch = generateMergePatch(originalVal, modifiedVal);
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
export function applyMergePatch(target: any, patch: any): any {
    if (patch === null) {
        // If patch is null, it typically means deletion in a parent context,
        // but at the root level, it means the result is null.
        return null;
    }

    if (typeof patch !== 'object' || Array.isArray(patch)) {
        // If patch is a primitive or array, it replaces the target.
        return patch;
    }

    if (typeof target !== 'object' || target === null || Array.isArray(target)) {
        // If target is not an object (or is null/array), it is treated as empty object for patching.
        target = {};
    } else {
        // Clone target to avoid mutation if we want immutability,
        // but for now let's clone shallowly to be safe.
        target = { ...target };
    }

    for (const key of Object.keys(patch)) {
        const val = patch[key];
        if (val === null) {
            delete target[key];
        } else {
            target[key] = applyMergePatch(target[key], val);
        }
    }

    return target;
}

function isObject(val: any): boolean {
    return val !== null && typeof val === 'object';
}

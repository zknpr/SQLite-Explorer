/**
 * Platform Utilities
 *
 * Provides safe access to platform-specific APIs like Node.js 'fs'.
 */

// Declare require for environment check if not globally available
declare var require: any;

/**
 * Get the Node.js 'fs' module if available.
 * Returns null in browser environments.
 */
export function getNodeFs() {
    if (typeof require === 'function') {
        try {
            return require('fs');
        } catch (e) {
            // require not available or fs module missing
            return null;
        }
    }
    return null;
}

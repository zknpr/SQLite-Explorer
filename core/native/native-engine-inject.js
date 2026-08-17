/**
 * esbuild `inject` module for the desktop-native worker bundle
 * (`bundleDesktopNativeWorker` in scripts/build.mjs).
 *
 * Binds the free identifier `__desktopNativeCreateEngine` — referenced by the
 * engine seam in website/src/sqlite-viewer/worker.js when
 * `import.meta.env.DESKTOP_NATIVE_ENGINE` is defined true — to the sidecar's
 * engine factory. The WASM builds define that flag false instead, the seam's
 * native branch folds away entirely (their byte-identity gate), and this
 * module is never injected into them.
 *
 * Sourced from native-host.js, NOT native-entry.js: worker.js comes to depend
 * on whatever module this re-export names, and the entry holds top-level
 * awaits — a dependency edge onto it would create a cycle that forces esbuild
 * to wrap a top-level-await module lazily, which emits an invalid bundle
 * (`await` inside a synchronous wrapper). The host is synchronous and
 * cycle-free by design; see its module docstring.
 */
export { createNativeEngine as __desktopNativeCreateEngine } from './native-host.js';

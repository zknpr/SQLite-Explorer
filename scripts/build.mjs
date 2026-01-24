/**
 * Build Script for SQLite Explorer Extension
 *
 * Compiles TypeScript source files into JavaScript bundles for:
 * - Node.js extension (main VS Code extension)
 * - Browser extension (for vscode.dev)
 * - Node.js worker (SQLite database operations)
 * - Browser worker (for vscode.dev)
 *
 * Uses esbuild for fast compilation with polyfills for browser compatibility.
 */

import esbuild from "esbuild";
import { polyfillNode } from "esbuild-plugin-polyfill-node";

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve paths relative to project root.
 */
const resolve = (...args) => path.resolve(__dirname, '..', ...args);

// Development mode flag
const DEV = !!process.env.DEV;
console.log({ DEV });

// Output directory
const outDir = resolve('out');

/**
 * Convert environment variables to esbuild define object.
 */
function envToDefine(env) {
  const metaEnv = Object.fromEntries(Object.entries(env).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]));
  console.log(metaEnv);
  return metaEnv;
}

/**
 * Base esbuild configuration shared by all builds.
 */
const config = {
  bundle: true,
  minify: !DEV,
  sourcemap: DEV,
  loader: {
    '.bin': 'file',
  },
};

/**
 * Base configuration for extension main entry point.
 */
const baseConfig = {
  ...config,
  entryPoints: [resolve('src/main.ts')],
  format: 'cjs',
  target: 'es2022',
  external: ['vscode', 'worker_threads'],
  define: {
    ...envToDefine({
      DEV,
      VITE_VSCODE: true,
    }),
  },
};

/**
 * Base configuration for worker entry point.
 */
const baseWorkerConfig = {
  ...config,
  entryPoints: [resolve('src/databaseWorker.ts')],
  format: 'esm',
  target: 'es2022',
  define: {
    ...envToDefine({
      DEV,
      VITE_VSCODE: true,
    }),
    // Point to assets directory for sql.js WASM file
    'import.meta.url': '"file:./assets/"',
  },
};

/**
 * Compile Node.js main extension bundle.
 * This runs in VS Code's extension host process.
 */
const compileNodeMain = () =>
  esbuild.build({
    ...baseConfig,
    outfile: resolve(outDir, 'extension.js'),
    platform: 'node',
    alias: {
      '@workers/v8-value-serializer/v8': 'node:v8',
    },
    define: {
      ...baseConfig.define,
      ...envToDefine({
        DEV,
        VSCODE_BROWSER_EXT: false,
      }),
    }
  });

/**
 * Compile browser main extension bundle.
 * This runs in vscode.dev's web worker environment.
 */
const compileBrowserMain = () =>
  esbuild.build({
    ...baseConfig,
    outfile: resolve(outDir, 'extension-browser.js'),
    platform: 'browser',
    mainFields: ['browser', 'module', 'main'],
    external: [
      ...baseConfig.external,
      'process',
      'worker_threads',
      'child_process',
      'os',
      'fs',
      'path',
      'stream',
      'stream/web',
      'node-fetch',
    ],
    alias: {
      'path': resolve('src/empty.js'),
    },
    define: {
      ...baseConfig.define,
      ...envToDefine({
        DEV,
        VSCODE_BROWSER_EXT: true,
      }),
    },
    plugins: [
      polyfillNode({
        polyfills: {
          buffer: true,
        }
      })
    ],
  });

/**
 * Compile Node.js worker bundle.
 * This runs SQLite operations in a separate thread.
 */
const compileNodeWorker = () =>
  esbuild.build({
    ...baseWorkerConfig,
    outfile: resolve(outDir, 'worker.js'),
    platform: 'node',
    alias: {
      '@workers/v8-value-serializer/v8': 'node:v8',
    },
    define: {
      ...baseWorkerConfig.define,
      ...envToDefine({
        DEV,
        VSCODE_BROWSER_EXT: false,
      })
    },
  });

/**
 * Compile browser worker bundle.
 * This runs SQLite operations in a web worker.
 */
const compileBrowserWorker = () =>
  esbuild.build({
    ...baseWorkerConfig,
    outfile: resolve(outDir, 'worker-browser.js'),
    platform: 'browser',
    mainFields: ['browser', 'module', 'main'],
    external: ['fs/promises', 'path'],
    define: {
      ...baseWorkerConfig.define,
      ...envToDefine({
        DEV,
        VSCODE_BROWSER_EXT: true,
      })
    },
    plugins: [
      polyfillNode({
        polyfills: {}
      })
    ]
  });

/**
 * Copy assets to output directory.
 * Ensures the webview HTML and WASM files are available.
 */
const copyAssets = async () => {
  // Create assets directory
  const assetsDir = resolve(outDir, '..', 'assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  // Copy sql.js WASM from node_modules if present
  try {
    const wasmSrc = resolve('node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    const wasmDst = resolve(assetsDir, 'sqlite3.wasm');
    if (fs.existsSync(wasmSrc) && !fs.existsSync(wasmDst)) {
      fs.copyFileSync(wasmSrc, wasmDst);
      console.log('Copied sql.js WASM to assets/');
    }
  } catch (err) {
    console.warn('Could not copy sql.js WASM:', err.message);
  }
};

/**
 * Bundle the webview HTML from separate source files.
 *
 * Reads the template HTML, CSS, and JavaScript files from core/ui/
 * and bundles them into a single viewer.html file.
 *
 * Source files:
 * - core/ui/viewer.template.html - HTML template with placeholders
 * - core/ui/viewer.css - CSS styles
 * - core/ui/viewer.js - JavaScript logic
 *
 * Output:
 * - core/ui/viewer.html - Bundled HTML file ready for the webview
 */
const bundleWebview = async () => {
  const templatePath = resolve('core', 'ui', 'viewer.template.html');
  const cssPath = resolve('core', 'ui', 'viewer.css');
  const jsPath = resolve('core', 'ui', 'viewer.js');
  const outputPath = resolve('core', 'ui', 'viewer.html');

  // Read source files
  const template = fs.readFileSync(templatePath, 'utf-8');
  const css = fs.readFileSync(cssPath, 'utf-8');
  const js = fs.readFileSync(jsPath, 'utf-8');

  // Optionally minify in production mode
  let finalCss = css;
  let finalJs = js;

  if (!DEV) {
    // Use esbuild to minify CSS
    try {
      const cssResult = await esbuild.transform(css, {
        loader: 'css',
        minify: true,
      });
      finalCss = cssResult.code;
    } catch (err) {
      console.warn('CSS minification failed, using original:', err.message);
    }

    // Use esbuild to minify JavaScript
    try {
      const jsResult = await esbuild.transform(js, {
        loader: 'js',
        minify: true,
      });
      finalJs = jsResult.code;
    } catch (err) {
      console.warn('JS minification failed, using original:', err.message);
    }
  }

  // Bundle: replace placeholders with actual content
  const bundled = template
    .replace('<!--STYLES-->', finalCss)
    .replace('<!--SCRIPTS-->', finalJs);

  // Write the bundled HTML
  fs.writeFileSync(outputPath, bundled, 'utf-8');
  console.log('Bundled webview: core/ui/viewer.html');
};

/**
 * Main compilation function.
 * Runs all build targets in parallel for speed.
 */
const compileExt = async (target) => {
  await Promise.all([
    compileNodeMain(),
    compileBrowserMain(),
    compileNodeWorker(),
    compileBrowserWorker(),
    copyAssets(),
    bundleWebview(),
  ]);
};

// Run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.env.VSCODE_EXT_TARGET;
  compileExt(target).then(() => {
    console.log('Compilation completed.');
  }).catch((error) => {
    console.error('Compilation failed.', error);
    process.exit(1);
  });
}

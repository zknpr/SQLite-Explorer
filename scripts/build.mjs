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
 * Removed default format to enforce explicit selection in targets.
 */
const baseWorkerConfig = {
  ...config,
  entryPoints: [resolve('src/databaseWorker.ts')],
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
    format: 'cjs',
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
    // CommonJS, NOT iife: the VS Code Web extension host loads the extension
    // entry as a CommonJS module and calls `module.exports.activate(context)`.
    // An iife bundle exports nothing on module.exports, so `activate` is never
    // found — the extension "activates" (the module loads) but its activate()
    // never runs, no custom editor is registered, and databases spin forever on
    // the loading screen in vscode.dev. This is the root cause of #418 (the web
    // build never worked). Desktop already uses cjs; the browser entry must too.
    format: 'cjs',
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
    outfile: resolve(outDir, 'worker.cjs'),
    platform: 'node',
    format: 'cjs',
    external: ['worker_threads', 'node:v8'],
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
    // IIFE (not ESM): this bundle is loaded as a CLASSIC Web Worker via
    // `new Worker(blobUrl)` in workerFactory.ts. An ESM bundle emits a top-level
    // `export{...}` which a classic worker cannot parse ("SyntaxError: Unexpected
    // token 'export'"), so the worker never boots and VS Code Web hangs on load.
    // IIFE also keeps the classic-worker environment sql.js/emscripten expects.
    format: 'iife',
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

  // Bundle JavaScript using esbuild
  // This allows using imports/exports in viewer.js and its modules
  let finalJs = '';
  const jsResult = await esbuild.build({
    entryPoints: [jsPath],
    bundle: true,
    write: false,
    minify: !DEV,
    format: 'iife',
    target: 'es2020',
    loader: {
      '.js': 'js',
      '.ts': 'ts'
    }
  });
  finalJs = jsResult.outputFiles[0].text;

  // Optionally minify CSS in production mode
  let finalCss = css;
  if (!DEV) {
    try {
      const cssResult = await esbuild.transform(css, {
        loader: 'css',
        minify: true,
      });
      finalCss = cssResult.code;
    } catch (err) {
      console.warn('CSS minification failed, using original:', err.message);
    }
  }

  // Bundle: replace placeholders with actual content.
  // Use function replacers so literal "$&"/"$1"-style sequences inside the
  // bundled JS/CSS (e.g. regex replacement strings) aren't reinterpreted as
  // String.replace() substitution patterns.
  const bundled = template
    .replace('<!--STYLES-->', () => finalCss)
    .replace('<!--SCRIPTS-->', () => finalJs);

  // Write the bundled HTML
  fs.writeFileSync(outputPath, bundled, 'utf-8');
  console.log('Bundled webview: core/ui/viewer.html');
};

/**
 * Bundle the web demo viewer HTML.
 *
 * Creates a standalone viewer for the website demo that uses
 * parent window communication instead of VS Code API.
 *
 * Output:
 * - website/public/sqlite-viewer/viewer.html - Bundled HTML for web demo
 */
const bundleWebDemoViewer = async () => {
  const templatePath = resolve('core', 'ui', 'viewer.template.html');
  const cssPath = resolve('core', 'ui', 'viewer.css');
  const jsPath = resolve('core', 'ui', 'web-viewer.js');
  const outputDir = resolve('website', 'public', 'sqlite-viewer');
  const outputPath = resolve(outputDir, 'viewer.html');

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Read source files
  const template = fs.readFileSync(templatePath, 'utf-8');
  const css = fs.readFileSync(cssPath, 'utf-8');

  // Plugin to replace api.js imports with web-api.js
  const webApiPlugin = {
    name: 'web-api-plugin',
    setup(build) {
      // Intercept imports of api.js and redirect to web-api.js
      build.onResolve({ filter: /\/api\.js$/ }, args => {
        // Only redirect if it's from the modules directory
        if (args.importer.includes('core/ui/modules') || args.importer.includes('core/ui/web-viewer')) {
          return {
            path: resolve('core', 'ui', 'modules', 'web-api.js'),
          };
        }
        return null;
      });
    }
  };

  // Bundle JavaScript using esbuild with web-api plugin
  let finalJs = '';
  try {
    const jsResult = await esbuild.build({
      entryPoints: [jsPath],
      bundle: true,
      write: false,
      minify: !DEV,
      format: 'iife',
      target: 'es2020',
      plugins: [webApiPlugin],
      loader: {
        '.js': 'js',
        '.ts': 'ts'
      }
    });
    finalJs = jsResult.outputFiles[0].text;
  } catch (err) {
    console.error('Web demo JS bundling failed:', err);
    return;
  }

  // Minify CSS in production mode
  let finalCss = css;
  if (!DEV) {
    try {
      const cssResult = await esbuild.transform(css, {
        loader: 'css',
        minify: true,
      });
      finalCss = cssResult.code;
    } catch (err) {
      console.warn('CSS minification failed, using original:', err.message);
    }
  }

  // Bundle: replace placeholders with actual content
  // Inject Codicon font for web demo (VS Code extension handles this via local resources or CSP-friendly URI)
  const codiconLink = '<link rel="stylesheet" href="https://unpkg.com/@vscode/codicons@0.0.44/dist/codicon.css" integrity="sha384-sVpT0iPTciRIsuV1JVtIodkJ0guQ/8vFWf8PaazFqcSmJfWptKd00bCziqfui3Ir" crossorigin="anonymous">';

  const bundled = template
    .replace('<!--HEAD-->', () => codiconLink)
    .replace('<!--STYLES-->', () => finalCss)
    .replace('<!--SCRIPTS-->', () => finalJs)
    .replace('nonce="<!--NONCE-->"', ''); // Remove nonce for static web demo

  // Write the bundled HTML
  fs.writeFileSync(outputPath, bundled, 'utf-8');
  console.log('Bundled web demo viewer: website/public/sqlite-viewer/viewer.html');
};

/**
 * Validate that required output files exist after build.
 * Throws error if any required files are missing.
 */
const validateBuildOutputs = () => {
  const requiredFiles = [
    'out/extension.js',
    'out/extension-browser.js',
    'out/worker.cjs',
    'out/worker-browser.js',
    'assets/sqlite3.wasm',
    'core/ui/viewer.html'
  ];

  const missingFiles = requiredFiles.filter(file => !fs.existsSync(resolve(file)));
  if (missingFiles.length > 0) {
    throw new Error(`Build validation failed: missing files: ${missingFiles.join(', ')}`);
  }
};

/**
 * Main compilation function.
 * Runs all build targets in parallel for speed with proper error handling.
 */
const compileExt = async (target) => {
  // Define build tasks with names for error reporting
  const buildTasks = [
    { name: 'compileNodeMain', fn: compileNodeMain },
    { name: 'compileBrowserMain', fn: compileBrowserMain },
    { name: 'compileNodeWorker', fn: compileNodeWorker },
    { name: 'compileBrowserWorker', fn: compileBrowserWorker },
    { name: 'copyAssets', fn: copyAssets },
    { name: 'bundleWebview', fn: bundleWebview },
    { name: 'bundleWebDemoViewer', fn: bundleWebDemoViewer },
  ];

  // Run all tasks in parallel and collect results
  const results = await Promise.allSettled(buildTasks.map(task => task.fn()));

  // Check for failures and report which tasks failed
  const failures = results
    .map((result, idx) => ({ result, task: buildTasks[idx] }))
    .filter(({ result }) => result.status === 'rejected');

  if (failures.length > 0) {
    console.error('\n=== Build Failures ===');
    for (const { result, task } of failures) {
      console.error(`\n[${task.name}] FAILED:`);
      console.error(result.reason);
    }
    throw new Error(`Build failed: ${failures.length} task(s) failed: ${failures.map(f => f.task.name).join(', ')}`);
  }

  // Validate all required outputs exist
  validateBuildOutputs();
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

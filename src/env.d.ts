interface ImportMetaEnv {
  readonly VSCODE_BROWSER_EXT: boolean;
  readonly VITE_VSCODE: boolean;
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

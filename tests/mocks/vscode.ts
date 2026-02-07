export const env = {
  uriScheme: 'vscode',
  appName: 'Code',
  language: 'en-US'
};

export const Uri = {
  parse: (value: string) => ({
    toString: () => value,
    path: value,
    scheme: 'file'
  }),
  file: (path: string) => ({
    toString: () => `file://${path}`,
    path,
    scheme: 'file'
  })
};

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4
}

export enum UIKind {
  Desktop = 1,
  Web = 2
}

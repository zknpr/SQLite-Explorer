/** A configured refusal, distinct from corrupt files and failed database opens. */
export class DatabaseFileSizeLimitError extends Error {
  constructor(
    readonly byteLength: number,
    readonly maximumBytes: number,
    options?: ErrorOptions
  ) {
    super(
      `File size (${(byteLength / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowed size (${(maximumBytes / (1024 * 1024)).toFixed(2)} MB). Configure 'sqliteExplorer.maxFileSize' to increase the limit.`,
      options
    );
    this.name = 'DatabaseFileSizeLimitError';
  }
}

import * as vsc from 'vscode';

/** Native save dialogs do not consistently confirm replacement on every host. */
export async function confirmFileReplacement(uri: vsc.Uri, exists?: boolean): Promise<boolean> {
  if (exists === undefined) {
    try {
      await vsc.workspace.fs.stat(uri);
      exists = true;
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code;
      if (code !== 'ENOENT' && code !== 'FileNotFound') throw error;
      exists = false;
    }
  }
  if (!exists) return true;
  const replace = vsc.l10n.t('Replace');
  const selected = await vsc.window.showWarningMessage(
    vsc.l10n.t('Replace the existing file?'),
    { modal: true, detail: uri.fsPath || uri.toString() },
    replace
  );
  return selected === replace;
}

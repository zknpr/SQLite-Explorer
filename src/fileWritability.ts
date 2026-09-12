import path from 'path';
import { getNodeFs } from './core/platform/fs';

/** SQLite journals and atomic replacements also require a writable parent. */
export async function canPersistLocalDatabase(filePath: string): Promise<boolean> {
  const fs = getNodeFs();
  if (!fs) throw new Error('Cannot check local database permissions without filesystem access.');
  const isPermissionError = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
  };
  try {
    await fs.promises.access(filePath, fs.constants.W_OK);
  } catch (error) {
    if (isPermissionError(error)) return false;
    // Native SQLite can create a missing leaf. Its parent still has to exist
    // and allow writes; unrelated I/O failures must fail the open explicitly.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await fs.promises.access(path.dirname(filePath), fs.constants.W_OK);
    return true;
  } catch (error) {
    if (isPermissionError(error)) return false;
    throw error;
  }
}

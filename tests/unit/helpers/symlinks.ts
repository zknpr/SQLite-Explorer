import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fileSymlinkRefusal(): string | false {
    if (process.platform !== 'win32') return false;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-explorer-symlink-probe-'));
    try {
        fs.writeFileSync(path.join(directory, 'target'), '');
        fs.symlinkSync('target', path.join(directory, 'link'));
        return false;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        return 'this Windows account may not create file symlinks (that needs an administrator or Developer Mode)';
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

/**
 * The reason a test cannot make a file symlink, or false where it can.
 * Windows lets an administrator or SYSTEM create one, and a standard user only
 * with Developer Mode on, so a test that needs one is skipped for that user.
 * A directory junction needs no privilege.
 */
export const NO_FILE_SYMLINKS: string | false = fileSymlinkRefusal();

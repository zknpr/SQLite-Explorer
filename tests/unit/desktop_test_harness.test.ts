import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';

describe('desktop test harness dependency interop', () => {
  it('loads Mocha from an ESM namespace returned by the VS Code extension host', async () => {
    const harnessPath = path.resolve('tests/desktop/suite/index.js');
    const source = await readFile(harnessPath, 'utf8');
    const exported: { run?: () => Promise<void> } = {};
    let addedFile = '';

    class FakeMocha {
      addFile(file: string) {
        addedFile = file;
      }

      run(done: (failures: number) => void) {
        done(0);
      }
    }

    vm.runInNewContext(source, {
      __dirname: path.dirname(harnessPath),
      exports: exported,
      require(specifier: string) {
        if (specifier === 'node:path') {
          return path;
        }
        if (specifier === 'mocha') {
          // VS Code's embedded Node exposes Mocha 12 as an ESM namespace.
          return { Mocha: FakeMocha };
        }
        throw new Error(`Unexpected module requested by desktop harness: ${specifier}`);
      }
    });

    assert.strictEqual(typeof exported.run, 'function');
    await exported.run?.();
    assert.strictEqual(addedFile, path.resolve(path.dirname(harnessPath), 'desktop.test.js'));
  });
});

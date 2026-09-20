import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

const repository = process.cwd();
const helperPath = path.join(repository, 'scripts/vscode-runtime.mjs');

interface RuntimeHelpers {
    applicationRoot(executablePath: string): string;
    assertRuntimeVersion(executablePath: string, expectedVersion: string): string;
}

const helpers = () => import(pathToFileURL(helperPath).href) as Promise<RuntimeHelpers>;

function temporaryDirectory(t: TestContext): string {
    const parent = path.join(repository, '.tmp');
    fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'vscode-runtime-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function writeFile(filename: string, content: string): void {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
}

function makeApplication(directory: string, layout: 'mac' | 'linux' | 'windows', version: string, macExecutable = 'Code') {
    const executable = layout === 'mac'
        ? path.join(directory, 'Visual Studio Code.app', 'Contents', 'MacOS', macExecutable)
        : path.join(directory, layout === 'windows' ? 'Code.exe' : 'code');
    const application = layout === 'mac'
        ? path.join(directory, 'Visual Studio Code.app', 'Contents', 'Resources', 'app')
        : path.join(directory, 'resources', 'app');
    writeFile(executable, 'test executable placeholder');
    writeFile(path.join(application, 'package.json'), JSON.stringify({ version }));
    return { executable, application };
}

function launcherFixture(t: TestContext) {
    const directory = temporaryDirectory(t);
    const fakeRepo = path.join(directory, 'repo');
    writeFile(path.join(fakeRepo, 'scripts/run-desktop-tests.mjs'), fs.readFileSync(path.join(repository, 'scripts/run-desktop-tests.mjs'), 'utf8'));
    if (fs.existsSync(helperPath)) {
        writeFile(path.join(fakeRepo, 'scripts/vscode-runtime.mjs'), fs.readFileSync(helperPath, 'utf8'));
    }
    writeFile(path.join(fakeRepo, 'package.json'), JSON.stringify({ engines: { vscode: '^1.110.0' } }));
    writeFile(path.join(fakeRepo, 'out/extension.js'), '');
    writeFile(path.join(fakeRepo, '.desktop-test-out/suite/index.js'), '');
    writeFile(path.join(fakeRepo, 'node_modules/@vscode/test-electron/package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
    writeFile(path.join(fakeRepo, 'node_modules/@vscode/test-electron/index.mjs'), `
import fs from 'node:fs';
export async function downloadAndUnzipVSCode(version) {
    fs.writeFileSync(process.env.DOWNLOAD_MARKER, version);
    if (process.env.FORBID_DOWNLOAD === '1') throw new Error('Unexpected download');
    return process.env.CACHED_EXECUTABLE;
}
export async function runTests(options) {
    fs.writeFileSync(process.env.LAUNCH_MARKER, JSON.stringify(options));
}
`);
    const launchMarker = path.join(directory, 'launched.json');
    const downloadMarker = path.join(directory, 'downloaded.txt');
    const run = (cachedExecutable: string, override?: string) => {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            CACHED_EXECUTABLE: cachedExecutable,
            LAUNCH_MARKER: launchMarker,
            DOWNLOAD_MARKER: downloadMarker,
            TMPDIR: directory,
            TMP: directory,
            TEMP: directory
        };
        delete env.VSCODE_TEST_EXECUTABLE_PATH;
        delete env.FORBID_DOWNLOAD;
        if (override !== undefined) {
            env.VSCODE_TEST_EXECUTABLE_PATH = override;
            env.FORBID_DOWNLOAD = '1';
        }
        return spawnSync(process.execPath, [path.join(fakeRepo, 'scripts/run-desktop-tests.mjs')], {
            cwd: fakeRepo, env, encoding: 'utf8', timeout: 10_000
        });
    };
    return { directory, launchMarker, downloadMarker, run };
}

it('desktop launcher refuses a cache named 1.110.0 whose application actually reports 1.135.0', t => {
    const f = launcherFixture(t);
    const app = makeApplication(path.join(f.directory, '.vscode-test/vscode-darwin-arm64-1.110.0'), 'mac', '1.135.0');
    const result = f.run(app.executable);
    assert.notEqual(result.status, 0, 'a mislabeled cache must not launch extension tests under the wrong VS Code runtime');
    assert.match(result.stderr, /expected.*1\.110\.0.*(?:actual|found).*1\.135\.0/i);
    assert.equal(fs.existsSync(f.launchMarker), false);
    assert.equal(fs.readFileSync(path.join(app.application, 'package.json'), 'utf8'), '{"version":"1.135.0"}');
});

it('desktop launcher accepts an explicitly selected exact-version executable without downloading', t => {
    const f = launcherFixture(t);
    const app = makeApplication(path.join(f.directory, 'fresh app'), 'mac', '1.110.0');
    const result = f.run(path.join(f.directory, 'unused cache'), app.executable);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(f.downloadMarker), false);
    assert.equal(JSON.parse(fs.readFileSync(f.launchMarker, 'utf8')).vscodeExecutablePath, app.executable);
});

it('desktop launcher rejects drift in an explicit executable without launching or replacing the application', t => {
    const f = launcherFixture(t);
    const app = makeApplication(path.join(f.directory, 'installed app'), 'linux', '1.136.1');
    const result = f.run(path.join(f.directory, 'unused cache'), app.executable);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected.*1\.110\.0.*(?:actual|found).*1\.136\.1/i);
    assert.equal(fs.existsSync(f.downloadMarker), false);
    assert.equal(fs.existsSync(f.launchMarker), false);
    assert.equal(fs.existsSync(app.executable), true);
});

for (const layout of ['mac', 'linux', 'windows'] as const) {
    it(`reads the actual ${layout} application package version`, async t => {
        const { applicationRoot, assertRuntimeVersion } = await helpers();
        const app = makeApplication(temporaryDirectory(t), layout, '1.110.0');
        assert.equal(applicationRoot(app.executable), fs.realpathSync(app.application));
        assert.equal(assertRuntimeVersion(app.executable, '1.110.0'), '1.110.0');
        assert.throws(() => assertRuntimeVersion(app.executable, '1.109.0'), /expected.*1\.109\.0.*(?:actual|found).*1\.110\.0/i);
    });
}

it('resolves a macOS Electron executable alias to its actual application', async t => {
    const { applicationRoot, assertRuntimeVersion } = await helpers();
    const directory = temporaryDirectory(t);
    const app = makeApplication(directory, 'mac', '1.110.0', 'Electron');
    const alias = path.join(directory, 'launch-code');
    try { fs.symlinkSync(app.executable, alias); }
    catch (error) {
        if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        assert.equal(assertRuntimeVersion(app.executable, '1.110.0'), '1.110.0');
        t.diagnostic('The OS refused executable symlink creation without privilege; the Electron application layout is still verified.');
        return;
    }
    assert.equal(applicationRoot(alias), fs.realpathSync(app.application));
    assert.equal(assertRuntimeVersion(alias, '1.110.0'), '1.110.0');
});

it('resolves a Windows versioned application folder and refuses ambiguous retained versions', async t => {
    const { applicationRoot, assertRuntimeVersion } = await helpers();
    const directory = temporaryDirectory(t);
    const executable = path.join(directory, 'Code.exe');
    writeFile(executable, 'test executable placeholder');
    const application = path.join(directory, '0123456789', 'resources', 'app');
    writeFile(path.join(application, 'package.json'), '{"version":"1.110.0"}');
    assert.equal(applicationRoot(executable), fs.realpathSync(application));
    assert.equal(assertRuntimeVersion(executable, '1.110.0'), '1.110.0');
    writeFile(path.join(directory, 'abcdef0123/resources/app/package.json'), '{"version":"1.135.0"}');
    assert.throws(() => assertRuntimeVersion(executable, '1.110.0'), /ambiguous.*application/i);
});

it('refuses an unreadable or malformed actual application version instead of trusting its directory', async t => {
    const { assertRuntimeVersion } = await helpers();
    const app = makeApplication(temporaryDirectory(t), 'mac', '1.110.0');
    const manifest = path.join(app.application, 'package.json');
    fs.writeFileSync(manifest, 'not json');
    assert.throws(() => assertRuntimeVersion(app.executable, '1.110.0'), /runtime.*version|package\.json/i);
    fs.writeFileSync(manifest, '{}');
    assert.throws(() => assertRuntimeVersion(app.executable, '1.110.0'), /expected.*1\.110\.0.*(?:actual|found).*missing/i);
    fs.unlinkSync(manifest);
    assert.throws(() => assertRuntimeVersion(app.executable, '1.110.0'), /package\.json|application.*root/i);
});

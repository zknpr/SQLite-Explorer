import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';

const sourceRepositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..'
);

const SQLJS_BRANCH = 'agent/paged-vfs-attach-isolation';
const SQLJS_COMMIT = '653366ed214563ea95a57b34c92986b6ff584c23';
const SQLJS_RUN = '31639875548';

const TXIKI_BRANCH = 'agent/v8-bounded-host-views';
const TXIKI_COMMIT = 'acef1d0de4f16321bc24b81261aebcea064f5923';
const TXIKI_RUN = '31648639100';

interface ScriptSpec {
    name: string;
    scriptName: string;
    branch: string;
    commit: string;
    runId: string;
    artifactContents: Readonly<Record<string, Buffer>>;
    destinations: Readonly<Record<string, readonly string[]>>;
    executable: boolean;
}

const scriptSpecs: readonly ScriptSpec[] = [
    {
        name: 'sql.js',
        scriptName: 'refresh-sqljs.mjs',
        branch: SQLJS_BRANCH,
        commit: SQLJS_COMMIT,
        runId: SQLJS_RUN,
        artifactContents: {
            'dist/sql-wasm.js': Buffer.from('fixture sql.js glue\n'),
            'dist/sql-wasm.wasm': Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x02, 0x03])
        },
        destinations: {
            'dist/sql-wasm.js': [
                'vendor/sql.js/sql-wasm.js',
                'website/public/sqlite-viewer/sql-wasm.js'
            ],
            'dist/sql-wasm.wasm': [
                'vendor/sql.js/sql-wasm.wasm',
                'assets/sqlite3.wasm',
                'website/public/sqlite-viewer/sql-wasm.wasm'
            ]
        },
        executable: false
    },
    {
        name: 'txiki.js',
        scriptName: 'refresh-natives.mjs',
        branch: TXIKI_BRANCH,
        commit: TXIKI_COMMIT,
        runId: TXIKI_RUN,
        artifactContents: {
            'aarch64-linux-gnu/tjs': Buffer.from('fixture aarch64 linux\n'),
            'aarch64-macos/tjs': Buffer.from('fixture aarch64 macos\n'),
            'x86_64-linux-gnu/tjs': Buffer.from('fixture x86_64 linux\n'),
            'x86_64-macos/tjs': Buffer.from('fixture x86_64 macos\n'),
            'x86_64-windows/tjs.exe': Buffer.from('fixture x86_64 windows\n')
        },
        destinations: {
            'aarch64-linux-gnu/tjs': ['natives/aarch64-linux-gnu/tjs'],
            'aarch64-macos/tjs': ['natives/aarch64-macos/tjs'],
            'x86_64-linux-gnu/tjs': ['natives/x86_64-linux-gnu/tjs'],
            'x86_64-macos/tjs': ['natives/x86_64-macos/tjs'],
            'x86_64-windows/tjs.exe': ['natives/x86_64-windows/tjs.exe']
        },
        executable: true
    }
];

const temporaryRoots = new Set<string>();

afterEach(() => {
    for (const root of temporaryRoots) {
        rmSync(root, { recursive: true, force: true });
    }
    temporaryRoots.clear();
});

function sha256(contents: Buffer): string {
    return createHash('sha256').update(contents).digest('hex');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeFixtureFile(root: string, relativePath: string, contents: Buffer | string): void {
    const destination = path.join(root, ...relativePath.split('/'));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
}

function patchFixtureHashes(script: string, spec: ScriptSpec): string {
    let patched = script;
    for (const [artifactPath, contents] of Object.entries(spec.artifactContents)) {
        const key = spec.name === 'sql.js' ? path.posix.basename(artifactPath) : artifactPath;
        const expression = new RegExp(`('${escapeRegExp(key)}'\\s*:\\s*)'[0-9a-f]{64}'`);
        assert.match(patched, expression, `fixture hash key ${key} must exist in ${spec.scriptName}`);
        patched = patched.replace(expression, `$1'${sha256(contents)}'`);
    }
    return patched;
}

function fakeGhSource(): string {
    return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const expectedRun = process.env.FAKE_GH_EXPECTED_RUN;
if (args[0] !== 'run' || (args[1] !== 'view' && args[1] !== 'download')) {
    console.error('unexpected fake gh arguments: ' + JSON.stringify(args));
    process.exit(90);
}
if (args[2] !== expectedRun) {
    console.error('unexpected run id: ' + args[2]);
    process.exit(91);
}

if (args[1] === 'view') {
    process.stdout.write(process.env.FAKE_GH_METADATA || '{}');
    process.exit(0);
}

const destinationIndex = args.indexOf('--dir');
if (destinationIndex < 0 || !args[destinationIndex + 1]) {
    console.error('download destination missing');
    process.exit(92);
}
const source = process.env.FAKE_GH_ARTIFACT_ROOT;
const destination = args[destinationIndex + 1];
for (const entry of fs.readdirSync(source)) {
    fs.cpSync(path.join(source, entry), path.join(destination, entry), { recursive: true });
}
`;
}

interface Harness {
    root: string;
    repositoryRoot: string;
    artifactRoot: string;
    scriptPath: string;
    environment: NodeJS.ProcessEnv;
    sentinels: ReadonlyMap<string, Buffer>;
}

function createHarness(spec: ScriptSpec): Harness {
    const root = mkdtempSync(path.join(tmpdir(), 'artifact-refresh-policy-'));
    temporaryRoots.add(root);
    const repositoryRoot = path.join(root, 'repo');
    const scriptDirectory = path.join(repositoryRoot, 'scripts');
    const artifactRoot = path.join(root, 'artifacts');
    const fakeBin = path.join(root, 'fake-bin');
    mkdirSync(scriptDirectory, { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    const sourceScript = readFileSync(
        path.join(sourceRepositoryRoot, 'scripts', spec.scriptName),
        'utf8'
    );
    const scriptPath = path.join(scriptDirectory, spec.scriptName);
    writeFileSync(scriptPath, patchFixtureHashes(sourceScript, spec));
    const helperDirectory = path.join(scriptDirectory, 'lib');
    mkdirSync(helperDirectory, { recursive: true });
    copyFileSync(
        path.join(sourceRepositoryRoot, 'scripts', 'lib', 'pinned-artifacts.mjs'),
        path.join(helperDirectory, 'pinned-artifacts.mjs')
    );

    for (const [artifactPath, contents] of Object.entries(spec.artifactContents)) {
        writeFixtureFile(artifactRoot, artifactPath, contents);
    }
    // Real workflow artifacts can contain unrelated files. Only duplicate or
    // misplaced security-relevant payload names are rejected.
    writeFixtureFile(artifactRoot, 'artifact-metadata.txt', 'unrelated metadata\n');

    const sentinels = new Map<string, Buffer>();
    for (const destinations of Object.values(spec.destinations)) {
        for (const relativeDestination of destinations) {
            const sentinel = Buffer.from(`original ${relativeDestination}\n`);
            sentinels.set(relativeDestination, sentinel);
            writeFixtureFile(repositoryRoot, relativeDestination, sentinel);
        }
    }

    const fakeGh = path.join(fakeBin, 'gh');
    writeFileSync(fakeGh, fakeGhSource());
    chmodSync(fakeGh, 0o755);

    return {
        root,
        repositoryRoot,
        artifactRoot,
        scriptPath,
        sentinels,
        environment: {
            ...process.env,
            PATH: fakeBin,
            FAKE_GH_EXPECTED_RUN: spec.runId,
            FAKE_GH_ARTIFACT_ROOT: artifactRoot,
            FAKE_GH_METADATA: JSON.stringify({
                headBranch: spec.branch,
                headSha: spec.commit,
                conclusion: 'success'
            })
        }
    };
}

function runScript(harness: Harness, args: readonly string[] = []) {
    return spawnSync(process.execPath, [harness.scriptPath, ...args], {
        cwd: harness.repositoryRoot,
        env: harness.environment,
        encoding: 'utf8',
        timeout: 15_000
    });
}

function localArguments(spec: ScriptSpec, artifactRoot: string): string[] {
    return [
        '--from', artifactRoot,
        '--run', spec.runId,
        '--branch', spec.branch,
        '--commit', spec.commit
    ];
}

function combinedOutput(result: ReturnType<typeof runScript>): string {
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function assertDestinationsUnchanged(harness: Harness): void {
    for (const [relativeDestination, sentinel] of harness.sentinels) {
        assert.deepEqual(
            readFileSync(path.join(harness.repositoryRoot, relativeDestination)),
            sentinel,
            `${relativeDestination} changed despite refresh rejection`
        );
    }
}

function assertRejected(
    harness: Harness,
    args: readonly string[],
    expectedMessage: RegExp
): void {
    const result = runScript(harness, args);
    assert.notEqual(result.status, 0, combinedOutput(result));
    assert.match(combinedOutput(result), expectedMessage);
    assertDestinationsUnchanged(harness);
}

function assertInstalled(harness: Harness, spec: ScriptSpec): void {
    const intendedDestinations = new Set<string>();
    for (const [artifactPath, destinations] of Object.entries(spec.destinations)) {
        const expectedContents = spec.artifactContents[artifactPath];
        for (const relativeDestination of destinations) {
            intendedDestinations.add(relativeDestination);
            const installedPath = path.join(harness.repositoryRoot, relativeDestination);
            assert.deepEqual(readFileSync(installedPath), expectedContents);
            if (spec.executable) {
                assert.equal(statSync(installedPath).mode & 0o777, 0o755);
            } else {
                assert.equal(statSync(installedPath).mode & 0o111, 0);
            }
        }
    }

    const installedFiles: string[] = [];
    const visit = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(entryPath);
            else if (entry.isFile()) {
                installedFiles.push(path.relative(harness.repositoryRoot, entryPath).split(path.sep).join('/'));
            }
        }
    };
    for (const topLevel of ['assets', 'vendor', 'website', 'natives']) {
        const directory = path.join(harness.repositoryRoot, topLevel);
        if (existsSync(directory)) visit(directory);
    }
    assert.deepEqual(installedFiles.sort(), [...intendedDestinations].sort());
}

test('refresh scripts share one pinned-artifact policy implementation', () => {
    for (const spec of scriptSpecs) {
        const source = readFileSync(
            path.join(sourceRepositoryRoot, 'scripts', spec.scriptName),
            'utf8'
        );
        assert.match(source, /from ['"]\.\/lib\/pinned-artifacts\.mjs['"]/);
        assert.doesNotMatch(source, /function readPinnedArtifacts\s*\(/);
        assert.doesNotMatch(source, /function readPinnedRunMetadata\s*\(/);
    }
});

for (const spec of scriptSpecs) {
    describe(`${spec.name} refresh provenance`, () => {
        test('default mode validates exact successful metadata before installing', () => {
            const harness = createHarness(spec);
            const result = runScript(harness);
            assert.equal(result.status, 0, combinedOutput(result));
            assertInstalled(harness, spec);
        });

        for (const [label, metadata, expectedMessage] of [
            [
                'wrong branch',
                { headBranch: 'main', headSha: spec.commit, conclusion: 'success' },
                /expected branch/i
            ],
            [
                'wrong commit',
                { headBranch: spec.branch, headSha: 'f'.repeat(40), conclusion: 'success' },
                /expected commit/i
            ],
            [
                'unsuccessful conclusion',
                { headBranch: spec.branch, headSha: spec.commit, conclusion: 'failure' },
                /expected.*success|conclusion/i
            ],
            [
                'missing branch metadata',
                { headSha: spec.commit, conclusion: 'success' },
                /expected branch/i
            ],
            [
                'missing commit metadata',
                { headBranch: spec.branch, conclusion: 'success' },
                /headSha|commit/i
            ],
            [
                'missing conclusion metadata',
                { headBranch: spec.branch, headSha: spec.commit },
                /expected.*success|conclusion/i
            ]
        ] as const) {
            test(`default mode rejects ${label} without partial writes`, () => {
                const harness = createHarness(spec);
                harness.environment.FAKE_GH_METADATA = JSON.stringify(metadata);
                assertRejected(harness, [], expectedMessage);
            });
        }

        test('local mode requires explicit run, branch, and commit together', () => {
            for (const omittedOption of ['--run', '--branch', '--commit']) {
                const harness = createHarness(spec);
                const args = localArguments(spec, harness.artifactRoot);
                const optionIndex = args.indexOf(omittedOption);
                args.splice(optionIndex, 2);
                assertRejected(harness, args, /required with --from|requires.*--run.*--branch.*--commit/i);
            }
        });

        test('rejects provenance options without --from', () => {
            const harness = createHarness(spec);
            assertRejected(
                harness,
                ['--run', spec.runId, '--branch', spec.branch, '--commit', spec.commit],
                /accepted only with --from/i
            );
        });

        for (const [label, option, wrongValue, expectedMessage] of [
            ['run ID', '--run', '1', /expected run/i],
            ['branch', '--branch', 'main', /expected branch/i],
            ['commit', '--commit', 'f'.repeat(40), /expected commit/i]
        ] as const) {
            test(`local mode rejects a wrong pinned ${label}`, () => {
                const harness = createHarness(spec);
                const args = localArguments(spec, harness.artifactRoot);
                args[args.indexOf(option) + 1] = wrongValue;
                assertRejected(harness, args, expectedMessage);
            });
        }

        test('rejects a missing expected artifact before installing', () => {
            const harness = createHarness(spec);
            const missingPath = Object.keys(spec.artifactContents)[0];
            rmSync(path.join(harness.artifactRoot, ...missingPath.split('/')));
            assertRejected(
                harness,
                localArguments(spec, harness.artifactRoot),
                /artifact manifest|missing/i
            );
        });

        test('rejects a duplicate or misplaced payload filename before installing', () => {
            const harness = createHarness(spec);
            const artifactPath = Object.keys(spec.artifactContents)[0];
            const duplicateName = path.posix.basename(artifactPath);
            copyFileSync(
                path.join(harness.artifactRoot, ...artifactPath.split('/')),
                path.join(harness.artifactRoot, duplicateName)
            );
            assertRejected(
                harness,
                localArguments(spec, harness.artifactRoot),
                /artifact manifest|unexpected|duplicate/i
            );
        });

        test('rejects a hash-matching payload moved to an unexpected relative path', () => {
            const harness = createHarness(spec);
            const artifactPath = Object.keys(spec.artifactContents)[0];
            const source = path.join(harness.artifactRoot, ...artifactPath.split('/'));
            const movedPath = `unexpected/${path.posix.basename(artifactPath)}`;
            writeFixtureFile(harness.artifactRoot, movedPath, readFileSync(source));
            rmSync(source);
            assertRejected(
                harness,
                localArguments(spec, harness.artifactRoot),
                /artifact manifest|unexpected|missing/i
            );
        });

        test('rejects a hash mismatch before installing', () => {
            const harness = createHarness(spec);
            const artifactPath = Object.keys(spec.artifactContents).at(-1);
            assert.ok(artifactPath);
            writeFixtureFile(harness.artifactRoot, artifactPath, 'tampered artifact\n');
            assertRejected(
                harness,
                localArguments(spec, harness.artifactRoot),
                /sha-?256|hash|expected/i
            );
        });

        test('rejects a symlinked payload before installing', () => {
            const harness = createHarness(spec);
            const artifactPath = Object.keys(spec.artifactContents)[0];
            const target = path.join(harness.artifactRoot, ...artifactPath.split('/'));
            const decoy = path.join(harness.root, 'decoy');
            writeFileSync(decoy, readFileSync(target));
            rmSync(target);
            symlinkSync(decoy, target);
            assertRejected(
                harness,
                localArguments(spec, harness.artifactRoot),
                /non-regular|artifact manifest/i
            );
        });

        test('local mode installs only the exact pinned artifact manifest', () => {
            const harness = createHarness(spec);
            const result = runScript(harness, localArguments(spec, harness.artifactRoot));
            assert.equal(result.status, 0, combinedOutput(result));
            assertInstalled(harness, spec);
        });
    });
}

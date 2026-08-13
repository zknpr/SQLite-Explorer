import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function portableRelative(root, entryPath) {
  return path.relative(root, entryPath).split(path.sep).join('/');
}

function readValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

export function createPinnedArtifactPolicy({
  scriptName,
  repository,
  sourceBranch,
  sourceCommit,
  pinnedRunId,
  expectedArtifactPaths,
  executable = false
}, {
  renameFile = renameSync
} = {}) {
  const payloadFilenames = new Set(
    Object.keys(expectedArtifactPaths).map(artifactPath => path.posix.basename(artifactPath))
  );

  function listPayloadPaths(root) {
    const matches = [];
    const visit = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(entryPath);
        } else if (payloadFilenames.has(entry.name)) {
          if (!entry.isFile()) {
            throw new Error(
              `Artifact manifest contains a non-regular payload: ${portableRelative(root, entryPath)}`
            );
          }
          matches.push(portableRelative(root, entryPath));
        }
      }
    };
    visit(root);
    return matches.sort();
  }

  function readPinnedArtifacts(root) {
    const expectedPaths = Object.keys(expectedArtifactPaths).sort();
    const observedPaths = listPayloadPaths(root);
    if (
      expectedPaths.length !== observedPaths.length ||
      expectedPaths.some((expectedPath, index) => expectedPath !== observedPaths[index])
    ) {
      throw new Error(
        `Artifact manifest mismatch: expected exactly ${expectedPaths.join(', ')}; ` +
        `received ${observedPaths.length > 0 ? observedPaths.join(', ') : '(none)'}`
      );
    }

    const artifacts = new Map();
    for (const [artifactPath, expectedHash] of Object.entries(expectedArtifactPaths)) {
      const contents = readFileSync(path.join(root, ...artifactPath.split('/')));
      const actualHash = sha256(contents);
      if (actualHash !== expectedHash) {
        throw new Error(
          `SHA-256 mismatch for ${artifactPath}: expected ${expectedHash}, received ${actualHash}`
        );
      }
      artifacts.set(artifactPath, contents);
    }
    return artifacts;
  }

  function cleanupWorkspaces(entries) {
    const errors = [];
    for (const entry of entries) {
      try {
        rmSync(entry.workspace, { recursive: true, force: true });
      } catch (error) {
        errors.push(new Error(`Failed to clean artifact workspace ${entry.workspace}`, {
          cause: error
        }));
      }
    }
    return errors;
  }

  function throwWithSecondaryErrors(primaryError, secondaryErrors, message) {
    if (secondaryErrors.length === 0) throw primaryError;
    throw new AggregateError([primaryError, ...secondaryErrors], message, {
      cause: primaryError
    });
  }

  function installArtifacts(replacements) {
    const entries = [];
    try {
      for (const replacement of replacements) {
        const directory = path.dirname(replacement.destination);
        mkdirSync(directory, { recursive: true });
        const workspace = mkdtempSync(
          path.join(directory, `.${path.basename(replacement.destination)}.refresh-`)
        );
        const entry = {
          ...replacement,
          workspace,
          staged: path.join(workspace, 'staged'),
          backup: path.join(workspace, 'original'),
          originalMoved: false,
          installed: false
        };
        entries.push(entry);

        writeFileSync(entry.staged, entry.contents);
        if (executable) chmodSync(entry.staged, 0o755);
        const actualHash = sha256(readFileSync(entry.staged));
        if (actualHash !== entry.expectedHash) {
          throw new Error(
            `Refusing to install ${entry.destination}: expected ${entry.expectedHash}, ` +
            `received ${actualHash}`
          );
        }
      }
    } catch (error) {
      throwWithSecondaryErrors(
        error,
        cleanupWorkspaces(entries),
        'Artifact staging failed and cleanup was incomplete'
      );
    }

    try {
      for (const entry of entries) {
        if (existsSync(entry.destination)) {
          renameFile(entry.destination, entry.backup);
          entry.originalMoved = true;
        }
        renameFile(entry.staged, entry.destination);
        entry.installed = true;
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const entry of entries.slice().reverse()) {
        if (entry.installed) {
          try {
            rmSync(entry.destination, { force: true });
            entry.installed = false;
          } catch (rollbackError) {
            rollbackErrors.push(new Error(
              `Failed to remove partially installed artifact ${entry.destination}`,
              { cause: rollbackError }
            ));
          }
        }
        if (entry.originalMoved) {
          try {
            renameFile(entry.backup, entry.destination);
            entry.originalMoved = false;
          } catch (rollbackError) {
            rollbackErrors.push(new Error(
              `Failed to restore original artifact ${entry.destination}; backup remains at ${entry.backup}`,
              { cause: rollbackError }
            ));
          }
        }
      }

      // A failed restoration keeps its workspace because that directory holds
      // the only recoverable copy of the original destination.
      const cleanupErrors = cleanupWorkspaces(
        entries.filter(entry => !entry.originalMoved)
      );
      throwWithSecondaryErrors(
        error,
        [...rollbackErrors, ...cleanupErrors],
        'Artifact installation failed and rollback was incomplete'
      );
    }

    const cleanupErrors = cleanupWorkspaces(entries);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'Artifacts were installed, but transaction workspace cleanup failed'
      );
    }
  }

  function parseArguments(args = process.argv.slice(2)) {
    if (args.length === 0) return { suppliedSource: undefined };

    const values = new Map();
    for (let index = 0; index < args.length; index += 1) {
      const option = args[index];
      if (!['--from', '--run', '--branch', '--commit'].includes(option)) {
        throw new Error(
          `Usage: node scripts/${scriptName} [--from path --run run-id ` +
          '--branch branch --commit 40-character-sha]'
        );
      }
      if (values.has(option)) throw new Error(`${option} may be specified only once`);
      values.set(option, readValue(args, index, option));
      index += 1;
    }

    if (!values.has('--from')) {
      throw new Error('--run, --branch, and --commit are accepted only with --from');
    }
    if (!values.has('--run') || !values.has('--branch') || !values.has('--commit')) {
      throw new Error('--run, --branch, and --commit are required with --from');
    }

    const runId = values.get('--run');
    const branch = values.get('--branch');
    const commit = values.get('--commit');
    if (!/^\d+$/.test(runId)) throw new Error(`Invalid workflow run id: ${runId}`);
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Invalid source commit: ${commit}`);
    if (runId !== pinnedRunId) {
      throw new Error(`Refusing local artifacts: expected run ${pinnedRunId}, received ${runId}`);
    }
    if (branch !== sourceBranch) {
      throw new Error(`Refusing local artifacts: expected branch ${sourceBranch}, received ${branch}`);
    }
    if (commit !== sourceCommit) {
      throw new Error(`Refusing local artifacts: expected commit ${sourceCommit}, received ${commit}`);
    }

    return { suppliedSource: path.resolve(values.get('--from')) };
  }

  function readPinnedRunMetadata() {
    const output = execFileSync(
      'gh',
      [
        'run',
        'view',
        pinnedRunId,
        '--repo',
        repository,
        '--json',
        'headBranch,headSha,conclusion'
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
    );
    let metadata;
    try {
      metadata = JSON.parse(output);
    } catch (error) {
      throw new Error(`Run ${pinnedRunId} returned invalid metadata JSON`, { cause: error });
    }

    const commit = String(metadata.headSha ?? '').toLowerCase();
    if (metadata.headBranch !== sourceBranch) {
      throw new Error(
        `Refusing run ${pinnedRunId}: expected branch ${sourceBranch}, ` +
        `received ${metadata.headBranch ?? '(missing)'}`
      );
    }
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new Error(`Run ${pinnedRunId} did not report a valid headSha`);
    }
    if (commit !== sourceCommit) {
      throw new Error(
        `Refusing run ${pinnedRunId}: expected commit ${sourceCommit}, received ${commit}`
      );
    }
    if (metadata.conclusion !== 'success') {
      throw new Error(
        `Refusing run ${pinnedRunId}: expected conclusion success, ` +
        `received ${metadata.conclusion ?? '(missing)'}`
      );
    }
  }

  return {
    installArtifacts,
    parseArguments,
    readPinnedArtifacts,
    readPinnedRunMetadata
  };
}

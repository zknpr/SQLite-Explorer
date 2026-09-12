import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

function inlineBranchFilter(workflow: string, event: string): string[] {
  const match = workflow.match(
    new RegExp(`^  ${event}:\\s*\\n {4}branches:\\s*\\[([^\\]]*)\\]`, 'm')
  );
  assert.ok(match, `${event} must use an explicit inline branch filter`);
  return match[1]
    .split(',')
    .map(branch => branch.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

describe('dependency-update CI branch coverage', () => {
  it('runs pull-request CI for every Dependabot target branch', () => {
    const ciWorkflow = readFileSync(
      path.resolve(process.cwd(), '.github/workflows/ci.yml'),
      'utf8'
    );
    const dependabot = readFileSync(
      path.resolve(process.cwd(), '.github/dependabot.yml'),
      'utf8'
    );
    const pullRequestBranches = inlineBranchFilter(ciWorkflow, 'pull_request');
    const dependabotTargets = [
      ...dependabot.matchAll(/^\s*target-branch:\s*["']?([^\s"'#]+)["']?/gm)
    ].map(match => match[1]);

    assert.ok(pullRequestBranches.includes('main'), 'main pull requests must retain CI');
    for (const target of new Set(dependabotTargets)) {
      assert.ok(
        pullRequestBranches.includes(target),
        `Dependabot target branch ${target} must have pull-request CI`
      );
    }
  });
});

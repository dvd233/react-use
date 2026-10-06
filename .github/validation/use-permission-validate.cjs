'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const baselineCommit = 'fbe99c6327e6af94df03bc8bd6ecc5e3ff04fbcc';
const baselineTree = 'a0e86d6271c1a1c3b7edc4f5cea8447a71d1c122';
const sourceTree = 'f5b8d3b56fa0652d5d29f6f69727c557e41e23fb';
const changedPaths = ['src/usePermission.ts', 'tests/usePermission.test.ts'];
const testTitles = [
  'updates the permission state and removes its listener on unmount',
  'does not add a listener when the query resolves after unmount',
  'ignores an obsolete query without affecting the new listener',
  'keeps the empty state when querying the permission rejects',
];
const regressionTitles = new Set(testTitles.slice(1, 3));

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readBindings(file) {
  const bindings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(bindings.source_repository, 'dvd233/react-use', 'Root must verify and bind the fork');
  assert.equal(bindings.source_repository_id, '1407991245');
  assert.equal(bindings.source_owner_id, '111864431');
  assert.equal(bindings.parent_repository, 'streamich/react-use');
  assert.equal(bindings.parent_repository_id, '154950925');
  assert.equal(bindings.default_branch, 'master');
  assert.equal(bindings.source_branch, 'fix/use-permission-cleanup');
  assert.equal(bindings.harness_branch, 'validation/use-permission-cleanup-20261007');
  assert.match(bindings.source_commit, /^[a-f0-9]{40}$/, 'Use an immutable source commit SHA');
  assert.notEqual(bindings.source_commit, baselineCommit, 'The source commit must contain the fix');
  assert.equal(bindings.baseline_commit, baselineCommit);
  assert.equal(bindings.baseline_tree, baselineTree);
  assert.equal(bindings.source_tree, sourceTree);
  assert.deepEqual(Object.keys(bindings.source_file_sha256).sort(), changedPaths);
  for (const value of [bindings.package_sha256, bindings.lock_sha256,
    ...Object.values(bindings.source_file_sha256)]) {
    assert.match(value, /^[a-f0-9]{64}$/);
  }
  return bindings;
}

function checkContext(bindings, env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, bindings.source_repository);
  assert.equal(env.GITHUB_REPOSITORY_ID, bindings.source_repository_id);
  assert.equal(env.GITHUB_REPOSITORY_OWNER_ID, bindings.source_owner_id);
  assert.equal(env.GITHUB_REF, `refs/heads/${bindings.harness_branch}`);
  assert.equal(env.GITHUB_EVENT_NAME, 'push');
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function checkCheckout(cwd, commit, tree, bindings) {
  assert.equal(git(cwd, ['rev-parse', 'HEAD']), commit, 'Checkout SHA mismatch');
  assert.equal(git(cwd, ['rev-parse', 'HEAD^{tree}']), tree, 'Checkout tree mismatch');
  if (commit === bindings.source_commit) {
    const headers = git(cwd, ['cat-file', '-p', 'HEAD']).split('\n\n')[0];
    const parents = headers.split('\n').filter((line) => line.startsWith('parent '));
    assert.deepEqual(parents, [`parent ${baselineCommit}`], 'Source must have the verified sole parent');
  }
  assert.equal(sha256(path.join(cwd, 'package.json')), bindings.package_sha256);
  assert.equal(sha256(path.join(cwd, 'yarn.lock')), bindings.lock_sha256);
  assert.equal(git(cwd, ['diff', '--name-only', 'HEAD', '--']), '', 'Tracked inputs changed');
}

function checkScope(baseline, candidate, bindings) {
  const files = new Set([
    ...git(baseline, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n'),
    ...git(candidate, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n'),
  ]);
  const differences = [...files].filter((file) => {
    const a = path.join(baseline, file);
    const b = path.join(candidate, file);
    return !fs.existsSync(a) || !fs.existsSync(b) || sha256(a) !== sha256(b);
  }).sort();
  assert.deepEqual(differences, changedPaths, 'Expected exactly the reviewed two-file source change');
  for (const file of changedPaths) {
    assert.equal(sha256(path.join(candidate, file)), bindings.source_file_sha256[file]);
  }
}

function validateFocusedReport(report, negative) {
  assert.equal(report.wasInterrupted, false);
  assert.equal(report.numRuntimeErrorTestSuites, 0, 'Runtime/setup failures are not regression proof');
  assert.equal(report.numTotalTestSuites, 1);
  assert.equal(report.numTotalTests, 4);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests, 0);
  assert.equal(report.numFailedTests, negative ? 2 : 0);
  assert.equal(report.numPassedTests, negative ? 2 : 4);
  const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
  assert.deepEqual(assertions.map((test) => test.title).sort(), [...testTitles].sort());
  for (const test of assertions) {
    const expectedFailure = negative && regressionTitles.has(test.title);
    assert.equal(test.status, expectedFailure ? 'failed' : 'passed', test.title);
    if (expectedFailure) {
      const message = test.failureMessages.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
      assert.match(message, /Expected number of calls:\s*0/);
      assert.match(message, /Received number of calls:\s*1/);
      assert.match(message, /change/);
    }
  }
}

async function runValidation(bindings, baseline, candidate) {
  const output = path.resolve(process.env.VALIDATION_OUTPUT || 'validation-results');
  fs.mkdirSync(output, { recursive: true });
  const expectedNode = Number(process.env.EXPECTED_NODE_MAJOR);
  const quality = process.env.RUN_QUALITY_CHECKS === 'true';
  const summary = {
    sourceRepository: bindings.source_repository,
    sourceCommit: bindings.source_commit,
    sourceTree: bindings.source_tree,
    baselineCommit,
    baselineTree,
    node: process.version,
    platform: process.platform,
    expectedNode,
    quality,
    commands: [],
    errors: [],
    passed: false,
  };
  const summaryFile = path.join(output, 'summary.json');
  const persist = () => fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + '\n');
  persist();

  async function command(label, cwd, program, args) {
    const log = path.join(output, `${label}.log`);
    const fd = fs.openSync(log, 'w');
    const record = { label, cwd, program, args, started: new Date().toISOString() };
    summary.commands.push(record);
    console.log(`Running ${label}: ${program} ${args.join(' ')}`);
    try {
      const result = await new Promise((resolve) => {
        const child = spawn(program, args, { cwd, stdio: ['ignore', fd, fd], env: process.env });
        child.once('error', (error) => resolve({ exitCode: null, error: String(error) }));
        child.once('close', (code, signal) => resolve({ exitCode: code, signal }));
      });
      Object.assign(record, result, { finished: new Date().toISOString(), log });
      return record;
    } finally {
      fs.closeSync(fd);
      persist();
    }
  }

  try {
    assert.equal(Number(process.versions.node.split('.')[0]), expectedNode);
    assert.ok([20, 22].includes(expectedNode));
    assert.equal(quality, process.platform === 'linux' && expectedNode === 20,
      'Build/lint/types must use the upstream Ubuntu Node20 scope');
    checkCheckout(baseline, baselineCommit, baselineTree, bindings);
    checkCheckout(candidate, bindings.source_commit, bindings.source_tree, bindings);
    checkScope(baseline, candidate, bindings);

    const installs = {};
    for (const [variant, cwd] of [['baseline', baseline], ['candidate', candidate]]) {
      const nodeVersion = await command(`${variant}-node-version`, cwd, 'node', ['--version']);
      const yarnVersion = await command(`${variant}-yarn-version`, cwd, 'yarn', ['--version']);
      assert.equal(nodeVersion.exitCode, 0);
      assert.equal(fs.readFileSync(nodeVersion.log, 'utf8').trim(), process.version);
      assert.equal(yarnVersion.exitCode, 0);
      assert.equal(fs.readFileSync(yarnVersion.log, 'utf8').trim(), '1.22.22');
      installs[variant] = await command(`${variant}-install`, cwd, 'yarn', ['install', '--frozen-lockfile']);
      if (installs[variant].exitCode !== 0) continue;
      checkCheckout(cwd, variant === 'baseline' ? baselineCommit : bindings.source_commit,
        variant === 'baseline' ? baselineTree : bindings.source_tree, bindings);
      if (quality) {
        await command(`${variant}-build`, cwd, 'yarn', ['build']);
        await command(`${variant}-lint`, cwd, 'yarn', ['lint']);
        await command(`${variant}-types`, cwd, 'yarn', ['lint:types']);
      }
      await command(`${variant}-full-tests`, cwd, 'yarn', ['test']);
    }

    if (installs.candidate.exitCode === 0) {
      const reportFile = path.join(output, 'candidate-focused.json');
      const result = await command('candidate-focused', candidate, 'yarn',
        ['test', 'tests/usePermission.test.ts', '--json', '--outputFile', reportFile]);
      assert.equal(result.exitCode, 0);
      validateFocusedReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')), false);
      summary.positiveControl = '4 passed';
    }

    if (installs.baseline.exitCode === 0) {
      checkCheckout(baseline, baselineCommit, baselineTree, bindings);
      const testFile = path.join(baseline, 'tests/usePermission.test.ts');
      assert.equal(fs.existsSync(testFile), false, 'Do not overwrite an upstream test');
      fs.copyFileSync(path.join(candidate, 'tests/usePermission.test.ts'), testFile);
      try {
        const reportFile = path.join(output, 'baseline-new-test-negative.json');
        const result = await command('baseline-new-test-negative', baseline, 'yarn',
          ['test', 'tests/usePermission.test.ts', '--json', '--outputFile', reportFile]);
        assert.equal(result.exitCode, 1, 'Only the exact expected regression failure counts');
        validateFocusedReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')), true);
        summary.negativeControl = '2 precise failures and 2 passed';
      } finally {
        fs.unlinkSync(testFile);
      }
    }

    checkCheckout(baseline, baselineCommit, baselineTree, bindings);
    checkCheckout(candidate, bindings.source_commit, bindings.source_tree, bindings);
    checkScope(baseline, candidate, bindings);
    const unexpected = summary.commands.filter((result) =>
      result.label !== 'baseline-new-test-negative' && result.exitCode !== 0);
    assert.equal(unexpected.length, 0, 'Native baseline/candidate failures remain blocking');
    assert.equal(summary.positiveControl, '4 passed');
    assert.equal(summary.negativeControl, '2 precise failures and 2 passed');
    summary.passed = true;
  } catch (error) {
    summary.errors.push(String(error.stack || error));
  } finally {
    persist();
  }
  console.log(JSON.stringify(summary, null, 2));
  return summary.passed ? 0 : 1;
}

async function main() {
  const [mode, file, baseline, candidate] = process.argv.slice(2);
  const bindings = readBindings(file);
  checkContext(bindings);
  if (mode === 'check-bindings') {
    assert.ok(process.env.GITHUB_OUTPUT, 'This entry point is for the reviewed hosted workflow');
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `source_repository=${bindings.source_repository}\nsource_commit=${bindings.source_commit}\n`);
    console.log(JSON.stringify(bindings, null, 2));
    return;
  }
  assert.equal(mode, 'run');
  assert.ok(baseline && candidate);
  process.exitCode = await runValidation(bindings, path.resolve(baseline), path.resolve(candidate));
}

module.exports = { readBindings, checkContext, validateFocusedReport, checkScope };
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

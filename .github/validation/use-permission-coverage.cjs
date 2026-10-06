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
  assert.equal(bindings.harness_branch, 'validation/use-permission-coverage-20261007');
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

function assessCoverage(summary, raw, target) {
  assert.deepEqual(Object.keys(summary).filter((file) => file !== 'total'), [target]);
  assert.deepEqual(Object.keys(raw), [target]);
  const file = raw[target];
  assert.equal(file.path, target);
  for (const [mapKey, counterKey] of [
    ['statementMap', 's'], ['fnMap', 'f'], ['branchMap', 'b'],
  ]) {
    const map = file[mapKey];
    const counters = file[counterKey];
    assert.ok(map && typeof map === 'object' && !Array.isArray(map));
    assert.ok(counters && typeof counters === 'object' && !Array.isArray(counters));
    assert.deepEqual(Object.keys(counters).sort(), Object.keys(map).sort(),
      `${counterKey} counter IDs must exactly match ${mapKey}`);
    for (const [id, counter] of Object.entries(counters)) {
      const values = counterKey === 'b' ? counter : [counter];
      assert.ok(Array.isArray(values), `${counterKey}.${id} has invalid counters`);
      if (counterKey === 'b') {
        assert.ok(Array.isArray(map[id].locations));
        assert.equal(values.length, map[id].locations.length,
          `Branch ${id} counters must match its locations`);
      }
      for (const count of values) {
        assert.ok(Number.isSafeInteger(count) && count >= 0,
          `${counterKey}.${id} counters must be nonnegative integers`);
      }
    }
  }
  const lines = {};
  for (const [id, count] of Object.entries(file.s)) {
    const line = file.statementMap[id].start.line;
    lines[line] = Math.max(lines[line] || 0, count);
  }
  const counters = {
    statements: Object.values(file.s),
    branches: Object.values(file.b).flat(),
    functions: Object.values(file.f),
    lines: Object.values(lines),
  };
  for (const [metric, values] of Object.entries(counters)) {
    const reported = summary[target][metric];
    assert.equal(reported.total, values.length, `${metric} total mismatch`);
    assert.equal(reported.covered, values.filter((count) => count > 0).length);
    assert.equal(reported.skipped, 0);
    assert.ok(Number.isFinite(reported.pct) && reported.pct >= 0 && reported.pct <= 100);
    const expectedPct = reported.total === 0 ? 100
      : Math.floor(((1000 * 100 * reported.covered) / reported.total) / 10) / 100;
    assert.equal(reported.pct, expectedPct, `${metric} percentage mismatch`);
    assert.deepEqual(summary.total[metric], reported);
  }
  function statementAt(line) {
    const entries = Object.entries(file.statementMap).filter(([, item]) => item.start.line === line);
    assert.equal(entries.length, 1, `Expected one mapped statement on frozen source line ${line}`);
    return file.s[entries[0][0]];
  }
  const condition = statementAt(45);
  const lateReturn = statementAt(46);
  const liveAssignment = statementAt(48);
  assert.ok(condition > 0 && lateReturn > 0 && liveAssignment > 0);
  assert.equal(condition, lateReturn + liveAssignment, 'Both guard outcomes must reconcile');
  const branches = Object.entries(file.branchMap).filter(([, item]) =>
    item.type === 'if' && item.loc.start.line === 45);
  assert.equal(branches.length, 1);
  const branchCounts = file.b[branches[0][0]];
  assert.ok(branchCounts.length > 0 && branchCounts.every((count) => count > 0));
  return {
    scope: 'src/usePermission.ts only; not the entire library',
    wholeHook: summary[target],
    wholeHook100Percent: Object.keys(counters).every((metric) =>
      summary[target][metric].covered === summary[target][metric].total),
    newGuard: {
      conditionLine: 45, conditionExecutions: condition,
      lateReturnLine: 46, lateReturnExecutions: lateReturn,
      continuedPathLine: 48, continuedPathExecutions: liveAssignment,
      instrumentedBranchLocations: branchCounts,
      bothOutcomesExercised: true,
      allNewExecutableStatementsCovered: true,
    },
  };
}

async function runCoverage(bindings, baseline, candidate) {
  const output = path.resolve(process.env.VALIDATION_OUTPUT || 'coverage-results');
  fs.mkdirSync(output, { recursive: true });
  const summary = { sourceCommit: bindings.source_commit, sourceTree: bindings.source_tree,
    baselineCommit, node: process.version, platform: process.platform,
    commands: [], errors: [], passed: false, wholeHook100Percent: false };
  const persist = () => fs.writeFileSync(path.join(output, 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n');
  persist();
  async function command(label, program, args) {
    const log = path.join(output, `${label}.log`);
    const fd = fs.openSync(log, 'w');
    const record = { label, program, args, started: new Date().toISOString(), log };
    summary.commands.push(record);
    try {
      const result = await new Promise((resolve) => {
        const child = spawn(program, args, { cwd: candidate,
          stdio: ['ignore', fd, fd], env: process.env });
        child.once('error', (error) => resolve({ exitCode: null, error: String(error) }));
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      });
      Object.assign(record, result, { finished: new Date().toISOString() });
      return record;
    } finally {
      fs.closeSync(fd);
      persist();
    }
  }
  try {
    assert.equal(process.platform, 'linux');
    assert.equal(Number(process.versions.node.split('.')[0]), 20);
    checkCheckout(baseline, baselineCommit, baselineTree, bindings);
    checkCheckout(candidate, bindings.source_commit, bindings.source_tree, bindings);
    checkScope(baseline, candidate, bindings);
    const node = await command('node-version', 'node', ['--version']);
    const yarn = await command('yarn-version', 'yarn', ['--version']);
    assert.equal(node.exitCode, 0);
    assert.equal(fs.readFileSync(node.log, 'utf8').trim(), process.version);
    assert.equal(yarn.exitCode, 0);
    assert.equal(fs.readFileSync(yarn.log, 'utf8').trim(), '1.22.22');
    const install = await command('candidate-install', 'yarn', ['install', '--frozen-lockfile']);
    assert.equal(install.exitCode, 0);
    checkCheckout(candidate, bindings.source_commit, bindings.source_tree, bindings);
    const coverageDir = path.join(output, 'coverage');
    const testReport = path.join(output, 'focused-tests.json');
    const result = await command('target-hook-coverage', 'yarn', [
      'test:coverage', '--runInBand', '--runTestsByPath', 'tests/usePermission.test.ts',
      '--collectCoverageFrom=src/usePermission.ts', `--coverageDirectory=${coverageDir}`,
      '--coverageReporters=json-summary', '--coverageReporters=json', '--coverageReporters=text',
      '--json', `--outputFile=${testReport}`,
    ]);
    assert.equal(result.exitCode, 0);
    validateFocusedReport(JSON.parse(fs.readFileSync(testReport, 'utf8')), false);
    const totals = JSON.parse(fs.readFileSync(path.join(coverageDir, 'coverage-summary.json'), 'utf8'));
    const raw = JSON.parse(fs.readFileSync(path.join(coverageDir, 'coverage-final.json'), 'utf8'));
    const assessment = assessCoverage(totals, raw, path.join(candidate, 'src/usePermission.ts'));
    fs.writeFileSync(path.join(output, 'coverage-assessment.json'),
      JSON.stringify(assessment, null, 2) + '\n');
    summary.coverage = assessment;
    summary.wholeHook100Percent = assessment.wholeHook100Percent;
    summary.passedMeaning = 'Measurement and meaningful guard coverage verified; not a 100% whole-hook claim';
    checkCheckout(baseline, baselineCommit, baselineTree, bindings);
    checkCheckout(candidate, bindings.source_commit, bindings.source_tree, bindings);
    checkScope(baseline, candidate, bindings);
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
    assert.ok(process.env.GITHUB_OUTPUT);
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `source_repository=${bindings.source_repository}\nsource_commit=${bindings.source_commit}\n`);
    console.log(JSON.stringify(bindings, null, 2));
    return;
  }
  assert.equal(mode, 'run');
  assert.ok(baseline && candidate);
  process.exitCode = await runCoverage(bindings, path.resolve(baseline), path.resolve(candidate));
}

module.exports = { readBindings, checkContext, assessCoverage, validateFocusedReport };
if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

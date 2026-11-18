'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { spec } = require('node:test/reporters');

const root = path.join(__dirname, '..');

function findFiles(directory, suffix) {
  const files = [];
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findFiles(relative, suffix));
    else if (entry.isFile() && relative.endsWith(suffix)) files.push(relative);
  }
  return files.sort();
}

function findSuites() {
  const suites = findFiles('tests', '.test.js');
  const tracked = execFileSync('git', ['ls-files', '-z', '--', ':(glob)tests/**/*.test.js'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .sort();

  if (suites.length === 0 || suites.join('\0') !== tracked.join('\0')) {
    const missing = tracked.filter((file) => !suites.includes(file));
    const untracked = suites.filter((file) => !tracked.includes(file));
    const details = [
      missing.length && `Missing: ${missing.join(', ')}`,
      untracked.length && `Untracked: ${untracked.join(', ')}`,
    ]
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `Test discovery must match the nonempty Git inventory under tests/.${details ? `\n${details}` : ''}`,
    );
  }
  return suites;
}

function coverageFiles() {
  return ['background.js', 'devtools.js', 'panel.js', ...findFiles('scripts', '.js')];
}

function lineCoverage(file) {
  const source = readFileSync(path.join(root, file), 'utf8');
  return source.split(/\r\n|[\r\n\u2028\u2029]/).length;
}

function percent(hit, total) {
  return total === 0 ? '—' : ((hit / total) * 100).toFixed(2);
}

function* formatCoverage(summary) {
  const files = coverageFiles();
  const measured = new Map(summary.files.map((row) => [path.relative(root, row.path).split(path.sep).join('/'), row]));
  const width = Math.max('all files'.length, ...files.map((file) => file.length));
  function row(file, lines, branches, functions, detail = '') {
    return `${file.padEnd(width)} | ${lines.padStart(7)} | ${branches.padStart(8)} | ${functions.padStart(9)}${detail ? ` | ${detail}` : ''}\n`;
  }
  yield '\nNode.js coverage\n';
  yield row('File', '% Lines', '% Branch', '% Funcs', 'Uncovered lines');
  let totalLines = 0;
  for (const file of files) {
    const report = measured.get(file);
    if (!report) {
      const lines = lineCoverage(file);
      totalLines += lines;
      yield row(file, '0.00', '—', '—', 'File not loaded by Node.js');
      continue;
    }
    totalLines += report.totalLineCount;
    const ranges = [];
    for (const line of report.lines) {
      if (line.count !== 0) continue;
      const previous = ranges[ranges.length - 1];
      if (previous && previous[1] + 1 === line.line) previous[1] = line.line;
      else ranges.push([line.line, line.line]);
    }
    yield row(
      file,
      report.coveredLinePercent.toFixed(2),
      report.coveredBranchPercent.toFixed(2),
      report.coveredFunctionPercent.toFixed(2),
      ranges.map(([first, last]) => (first === last ? first : `${first}-${last}`)).join(', '),
    );
  }
  const totals = summary.totals;
  yield row(
    'all files',
    percent(totals.coveredLineCount, totalLines),
    percent(totals.coveredBranchCount, totals.totalBranchCount),
    percent(totals.coveredFunctionCount, totals.totalFunctionCount),
  );
  yield 'Line totals include unloaded files. V8 counts branches and functions only in files it loads.\n';
}

async function* reportTests(source) {
  const files = new Map();
  let coverage;
  async function* testEvents() {
    for await (const event of source) {
      if (event.type === 'test:summary' && event.data.file) files.set(event.data.file, event.data.success);
      if (event.type === 'test:coverage') coverage = event.data.summary;
      else yield event;
    }
  }
  yield* Readable.from(testEvents()).pipe(spec());
  const passed = [...files.values()].filter(Boolean).length;
  yield `\nTest files: ${passed} passed, ${files.size - passed} failed, ${files.size} total\n`;
  for (const [file, success] of files) {
    yield `${success ? 'PASS' : 'FAIL'} ${path.relative(root, file).split(path.sep).join('/')}\n`;
  }
  if (coverage) yield* formatCoverage(coverage);
}

function main() {
  const args = process.argv.slice(2);
  const suites = findSuites();
  if (args.length === 1 && args[0] === '--list') {
    console.log(suites.join('\n'));
    return;
  }
  const useCoverage = !args.includes('--no-coverage');
  const selected = args.filter((arg) => arg !== '--no-coverage');
  const invalid = selected.find((file) => !suites.includes(file));
  if (invalid) throw new Error(`Unknown test suite or option: ${invalid}`);
  const coverage = useCoverage
    ? ['--experimental-test-coverage', ...coverageFiles().map((file) => `--test-coverage-include=${file}`)]
    : [];
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      path.join(root, 'tests', 'node-test-setup.mjs'),
      '--test',
      '--test-concurrency=1',
      '--test-reporter',
      __filename,
      ...coverage,
      '--',
      ...(selected.length ? [...new Set(selected)] : suites),
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Test runner terminated by ${result.signal}`);
  process.exitCode = result.status;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else {
  module.exports = reportTests;
}

'use strict';
// Runs every test suite in sequence and reports a single pass/fail verdict.
// Each suite boots its own server on its own port, so they must not run in
// parallel. Run: npm test

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  { name: 'engine rules',    file: 'engine.test.js' },
  { name: 'audit engine',    file: 'audit.test.js' },
  { name: 'client paths',    file: 'path.test.js' },
  { name: 'http api',        file: 'api.test.js' },
  { name: 'stress',          file: 'stress.test.js' },
  { name: 'audit server',    file: 'audit-server.test.js' }
];

let totalPassed = 0, totalFailed = 0, failedSuites = [];

for (const s of SUITES) {
  process.stdout.write('\n=== ' + s.name + ' (' + s.file + ') ===\n');
  const r = spawnSync('node', [path.join(__dirname, s.file)], {
    stdio: 'inherit',
    timeout: 300000
  });
  if (r.status !== 0) {
    failedSuites.push(s.name);
    totalFailed++;
  } else {
    totalPassed++;
  }
}

console.log('\n' + '='.repeat(52));
console.log('suites passed: ' + totalPassed + '/' + SUITES.length);
if (failedSuites.length) {
  console.log('FAILED: ' + failedSuites.join(', '));
  process.exit(1);
}
console.log('all suites green');

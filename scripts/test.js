// Each test file gets an independent project, including its config, data and storage.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests')).filter((file) => file.endsWith('.test.js')).sort();
let passed = 0;
let failed = 0;
async function worker() {
  while (files.length) {
    const file = files.shift();
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-test-'));
    try {
      for (const name of ['src', 'tests', 'scripts', 'package.json', 'config.example.yaml']) {
        fs.cpSync(path.join(root, name), path.join(fixture, name), { recursive: true });
      }
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'junction');
      const { stdout } = await run(process.execPath, ['--test', '--test-reporter=tap', path.join(fixture, 'tests', file)], {
        cwd: fixture, env: { ...process.env, FILE_MASTER_TEST_ROOT: fs.realpathSync(fixture) }, timeout: 60000, maxBuffer: 8 * 1024 * 1024
      });
      const count = Number(stdout.match(/^# tests (\d+)/m)?.[1] || 0);
      passed += count;
      console.log(`${file}: ${count} passed`);
    } catch (err) {
      failed++;
      console.error(`${file}: FAILED\n${err.stdout || ''}${err.stderr || err.message}`);
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  }
}
Promise.all(Array.from({ length: Math.min(4, files.length) }, worker)).then(() => {
  console.log(`Tests: ${passed} passed; ${failed} failed files (isolated projects)`);
  process.exitCode = failed ? 1 : 0;
}).catch((err) => { console.error(err); process.exitCode = 1; });

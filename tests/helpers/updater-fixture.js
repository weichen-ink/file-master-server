const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');
const { createUpdater } = require('../../src/core/updater');

function openFixture(rootDir, runCommand, faults = {}) {
  const configPath = path.join(rootDir, 'config.yaml');
  const config = {
    getConfig: () => YAML.parse(fs.readFileSync(configPath, 'utf8')),
    getRawConfigYaml: () => fs.readFileSync(configPath, 'utf8'),
    saveRawConfigYaml(raw) {
      if (faults.save) throw new Error('simulated config restore failure');
      fs.writeFileSync(`${configPath}.tmp`, raw);
      fs.renameSync(`${configPath}.tmp`, configPath);
      return this.getConfig();
    }
  };
  // Production adapters are standalone functions; keep the fixture equally callable.
  config.saveRawConfigYaml = config.saveRawConfigYaml.bind(config);
  return createUpdater({ rootDir, config, runCommand });
}

function createFixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-updater-flow-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');
  const write = (file, data) => fs.writeFileSync(path.join(rootDir, file), data);
  fs.mkdirSync(path.join(rootDir, '.git'));
  write('config.yaml', '# user comment\nport: 3000\npassword: user-secret\nimage_host:\n  watermark_text: Custom\n');
  write('config.example.yaml', 'port: 9999\nnew_default: enabled\nimage_host:\n  webp_quality: 80\n');
  write('watermark.png', 'custom watermark');
  write('package.json', '{"version":"1.0.1"}');
  write('package-lock.json', '{}');
  const original = read('config.yaml');
  const faults = {};
  const calls = [];
  const runCommand = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === faults.fail) throw new Error(`simulated ${faults.fail} failure`);
    if (cmd.startsWith('npm')) {
      if (faults.install) throw new Error('simulated dependency install failure');
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'reset') {
      if (!fs.existsSync(path.join(rootDir, 'data/update_pending_restore.flag'))) throw new Error('reset without recovery marker');
      write('config.yaml', 'port: 9999\n');
      write('watermark.png', 'upstream watermark');
      if (faults.changeDeps) write('package.json', '{"version":"1.0.2"}');
      faults.afterReset?.();
    }
    const stdout = args[0] === 'log' ? 'before|before|old|2026-11-10' : args[0] === 'rev-parse'
      ? (args.includes('FETCH_HEAD') ? 'after' : 'main') : '';
    return { stdout, stderr: '' };
  };
  const updater = openFixture(rootDir, runCommand, faults);
  return { rootDir, updater, faults, calls, read, write, original,
    pending: () => fs.existsSync(path.join(rootDir, 'data/update_pending_restore.flag')) };
}
module.exports = { createFixture, openFixture };

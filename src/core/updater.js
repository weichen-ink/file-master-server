const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const YAML = require('yaml');
const defaultConfig = require('./config');
const { ROOT_DIR } = defaultConfig;
const { createUpdateBackup } = require('./update-backup');
const { createUpdateGit, OFFICIAL_UPSTREAM_REPO, getEffectiveUpstreamRepo,
  validateGitMirror, validateGitRemote, validateGitBranch } = require('./update-git');

// One coordinator owns the lock. Tests use separate roots and a command boundary.
function createUpdater({ rootDir = ROOT_DIR, config = defaultConfig, runCommand, resolveOfficialCommit } = {}) {
  const DATA_DIR = path.join(rootDir, 'data');
  const CONFIG_PATH = path.join(rootDir, 'config.yaml');
  const EXAMPLE_CONFIG_PATH = path.join(rootDir, 'config.example.yaml');
  const PKG_PATH = path.join(rootDir, 'package.json');
  const PKG_LOCK_PATH = path.join(rootDir, 'package-lock.json');
  const { getConfig, getRawConfigYaml, saveRawConfigYaml } = config;
  let updateInProgress = false;
  const backup = createUpdateBackup({ rootDir, dataDir: DATA_DIR, configPath: CONFIG_PATH, getConfig });
  const { backupWatermarkFiles, restoreWatermarkFiles, readPendingUpdate, writePendingUpdate, clearPendingUpdate } = backup;
  const git = createUpdateGit({ rootDir, getConfig, isUpdateInProgress: () => updateInProgress, runCommand, resolveCommit:resolveOfficialCommit });
  const { runCmd, getFileSha256, readPackageVersion, fetchVerifiedUpdate } = git;

  async function getUpdateStatus(options) {
    return { ...await git.getUpdateStatus(options), dependenciesPending: Boolean(readPendingUpdate()?.dependenciesPending) };
  }

  /**
   * Restores user's config.yaml while preserving any new default keys introduced in upstream config.yaml.
   */
  function restoreAndMergeUserConfig(userRawYaml, upstreamRawYaml) {
    try {
      const userDoc = YAML.parseDocument(userRawYaml);
      const userParsed = YAML.parse(userRawYaml) || {};
      const upstreamParsed = YAML.parse(upstreamRawYaml) || {};

      // Add any new top-level keys introduced by upstream that don't exist in user's config yet
      for (const [key, val] of Object.entries(upstreamParsed)) {
        if (userParsed[key] === undefined) {
          userDoc.set(key, val);
        } else if (
          (key === 'image_host' || key === 'backup') &&
          val &&
          typeof val === 'object' &&
          typeof userParsed[key] === 'object'
        ) {
          for (const [subKey, subVal] of Object.entries(val)) {
            if (userParsed[key][subKey] === undefined) {
              userDoc.setIn([key, subKey], subVal);
            }
          }
        }
      }

      return saveRawConfigYaml(userDoc.toString());
    } catch (err) {
      console.warn('[Updater] Failed to merge config AST, restoring exact user config.yaml:', err.message);
      return saveRawConfigYaml(userRawYaml);
    }
  }

  /**
   * Pulls latest changes from locked official upstream repository (or configured mirror accelerator),
   * preserves config.yaml & watermark.png, updates npm dependencies if package.json changed,
   * and returns execution details.
   */
  async function performHotUpdate(options = {}) {
    if (updateInProgress) {
      throw new Error('An update is already in progress. Please wait.');
    }

    const cfg = getConfig();
    const upstreamMirror = (options.upstream_mirror ?? cfg.upstream_mirror ?? '').trim();
    const effectiveRepo = getEffectiveUpstreamRepo(upstreamMirror || options.upstream_repo || cfg.upstream_repo);
    const upstreamBranch = (options.upstream_branch || cfg.upstream_branch || 'main').trim() || 'main';

    if (!validateGitRemote(effectiveRepo)) {
      throw new Error(`Invalid effective repository URL format: "${effectiveRepo}"`);
    }
    if (!validateGitBranch(upstreamBranch)) {
      throw new Error(`Invalid upstream branch name format: "${upstreamBranch}"`);
    }

    updateInProgress = true;
    let userRawYaml;
    let watermarkBackups;
    let state;

    try {
      const logs = [];
      const logStep = (msg) => {
        const entry = `[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ${msg}`;
        logs.push(entry);
        console.log(`[HotUpdate] ${msg}`);
      };

      const recovery = backup.recoverInterruptedUpdate();
      if (!recovery.success) throw new Error(`Cannot update until user assets are recovered: ${recovery.error}`);
      const previousInstallPending = Boolean(readPendingUpdate()?.dependenciesPending);

      // Back up user's config.yaml and all customized watermark files before touching git
      userRawYaml = getRawConfigYaml();
      watermarkBackups = backupWatermarkFiles();
      const oldPkgHash = getFileSha256(PKG_PATH) + ':' + getFileSha256(PKG_LOCK_PATH);

      fs.mkdirSync(DATA_DIR, { recursive: true });
      const cfgBackupPath = path.join(DATA_DIR, 'config.backup.yaml');
      fs.writeFileSync(cfgBackupPath, userRawYaml, 'utf8');
      state = { assetsRestored: false, dependenciesPending: previousInstallPending };
      writePendingUpdate(state);
      logStep(`Backed up config.yaml to data/config.backup.yaml`);

      const beforeStatus = await getUpdateStatus({ fetchRemote: false });
      const fromCommit = beforeStatus.localShortCommit || 'unknown';

      logStep(`Fetching latest commits from ${effectiveRepo} (branch: ${upstreamBranch})...`);
      const verifiedCommit = await fetchVerifiedUpdate(effectiveRepo,upstreamBranch);
      const toCommit = verifiedCommit.slice(0,7);

      logStep(`Applying update (${fromCommit} -> ${toCommit})...`);
      // Reset can change dependencies even if the process exits before hash comparison.
      state.dependenciesPending = true;
      writePendingUpdate(state);
      await runCmd('git', ['reset', '--hard', verifiedCommit], 15000);
      const newPkgHash = getFileSha256(PKG_PATH) + ':' + getFileSha256(PKG_LOCK_PATH);
      state.dependenciesPending = previousInstallPending || oldPkgHash !== newPkgHash;
      writePendingUpdate(state);

      // Read the newly pulled upstream config.example.yaml (or config.yaml) before restoring user's config
      const templatePath = fs.existsSync(EXAMPLE_CONFIG_PATH) ? EXAMPLE_CONFIG_PATH : CONFIG_PATH;
      const upstreamRawYaml = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : '';
      restoreAndMergeUserConfig(userRawYaml, upstreamRawYaml);
      logStep(`Restored and merged user config.yaml (all credentials & settings preserved)`);

      const wmRestore = restoreWatermarkFiles(watermarkBackups);
      if (!wmRestore.success) {
        const failedNames = wmRestore.failed.map((f) => path.basename(f.file)).join(', ');
        throw new Error(`Failed to restore customized watermark files after update: ${failedNames}`);
      }
      state.assetsRestored = true;
      writePendingUpdate(state);
      logStep(`Restored customized watermark assets`);

      let depsUpdated = false;
      if (state.dependenciesPending) {
        logStep(`Changed or unfinished dependencies; running npm install --omit=dev --ignore-scripts...`);
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        await runCmd(npmCmd, ['install', '--omit=dev', '--ignore-scripts'], 120000);
        depsUpdated = true;
        logStep(`Dependencies installed successfully`);
      } else {
        logStep(`package.json unchanged; skipped npm install`);
      }

      clearPendingUpdate();
      const newVersion = readPackageVersion();
      logStep(`Update complete (v${newVersion}, commit ${toCommit}). Scheduling service restart...`);

      return {
        success: true,
        fromCommit,
        toCommit,
        alreadyUpToDate: fromCommit === toCommit,
        depsUpdated,
        version: newVersion,
        logs
      };
    } catch (err) {
      // Restore only unfinished asset recovery. Never overwrite user edits on an install retry.
      try {
        if (state && !state.assetsRestored) {
          saveRawConfigYaml(userRawYaml);
          const rollbackRes = restoreWatermarkFiles(watermarkBackups);
          if (rollbackRes.success) {
            state.assetsRestored = true;
            writePendingUpdate(state);
          }
        }
        if (state?.assetsRestored && !state.dependenciesPending) {
          clearPendingUpdate();
        }
      } catch {
        // Keep durable state and backups if secondary restoration fails.
      }
      if (state?.dependenciesPending) {
        console.warn('[HotUpdate] Dependencies may be incomplete; retry the hot update even if no newer commit is available.');
      }
      throw err;
    } finally {
      updateInProgress = false;
    }
  }

  return { OFFICIAL_UPSTREAM_REPO, getEffectiveUpstreamRepo, validateGitMirror,
    readPackageVersion, getUpdateStatus, performHotUpdate, ...backup,
    isUpdateInProgress: () => updateInProgress };
}

/**
 * Gracefully restarts the current Node.js server process across all Linux & cross-platform runtime modes:
 * - node --watch (touches server.js to trigger built-in watcher reload)
 * - Linux systemd / Docker / PM2 supervisor (closes HTTP server and exits with 0 so supervisor respawns cleanly)
 * - Standalone `node src/server.js` / `npm start` (closes HTTP server to free port, then spawns fresh process)
 */
function restartServerProcess(httpServer, serverEntryFile) {
  const isWatchMode = process.execArgv.some((arg) => arg === '--watch' || arg.startsWith('--watch=')) ||
    process.env.npm_lifecycle_event === 'dev';
  const isPm2 = process.env.pm_id !== undefined || Boolean(process.env.PM2_HOME);
  const isSystemd = Boolean(process.env.INVOCATION_ID || process.env.JOURNAL_STREAM);
  const isDocker = process.pid === 1 || fs.existsSync('/.dockerenv');
  const isManagedBySupervisor = isPm2 || isSystemd || isDocker;

  const modeLabel = isWatchMode
    ? 'watch'
    : isPm2
      ? 'pm2'
      : isSystemd
        ? 'systemd'
        : isDocker
          ? 'docker'
          : 'standalone';

  console.log(`[HotUpdate] Restarting server process (mode: ${modeLabel})...`);

  if (isWatchMode && serverEntryFile && fs.existsSync(serverEntryFile)) {
    const now = new Date();
    fs.utimesSync(serverEntryFile, now, now);
    return;
  }

  let respawned = false;
  const finishRestart = () => {
    if (respawned) return;
    respawned = true;

    if (!isManagedBySupervisor) {
      const entry = serverEntryFile || path.join(ROOT_DIR, 'src/server.js');
      const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
        cwd: ROOT_DIR,
        env: process.env,
        detached: true,
        stdio: 'inherit'
      });
      child.unref();
    }
    process.exit(0);
  };

  if (httpServer) {
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    httpServer.close(() => finishRestart());
    setTimeout(finishRestart, 800).unref();
  } else {
    finishRestart();
  }
}

module.exports = { ...createUpdater(), createUpdater, restartServerProcess };

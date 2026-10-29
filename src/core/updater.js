const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const YAML = require('yaml');
const {
  ROOT_DIR,
  CONFIG_PATH,
  DATA_DIR,
  getConfig,
  getRawConfigYaml,
  saveRawConfigYaml
} = require('./config');

const PKG_PATH = path.join(ROOT_DIR, 'package.json');
const PKG_LOCK_PATH = path.join(ROOT_DIR, 'package-lock.json');
const WATERMARK_PATH = path.join(ROOT_DIR, 'watermark.png');

let updateInProgress = false;

function validateGitRemote(repo) {
  if (typeof repo !== 'string') return false;
  const trimmed = repo.trim();
  if (!trimmed || trimmed.startsWith('-')) return false;
  if (/[\r\n\0`$;|&]/.test(trimmed)) return false;
  const remoteRegex = /^(https?:\/\/[\w.-]+(:\d+)?\/[\w.\-\/~]+(\.git)?|git@[\w.\-]+:[\w.\-\/~]+(\.git)?|ssh:\/\/[\w.\-@]+(:\d+)?\/[\w.\-\/~]+(\.git)?|\/[\w.\-\/]+)$/;
  return remoteRegex.test(trimmed);
}

function validateGitBranch(branch) {
  if (typeof branch !== 'string') return false;
  const trimmed = branch.trim();
  if (!trimmed || trimmed.startsWith('-')) return false;
  if (/[\r\n\0`$;|&]/.test(trimmed)) return false;
  if (/\.\.|\~|\^|\:|\?|\*|\[|\\|@\{|\.lock$|\/$/.test(trimmed)) return false;
  return /^[a-zA-Z0-9_.\-\/]+$/.test(trimmed);
}

/**
 * Helper to execute a command inside ROOT_DIR with timeout and non-interactive git env.
 */
function runCmd(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: ROOT_DIR,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C'
        }
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || '').trim();
          return reject(new Error(`${cmd} ${args.join(' ')} failed: ${detail}`));
        }
        resolve({
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim()
        });
      }
    );
  });
}

function getFileSha256(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    return pkg.version || '0.1.0';
  } catch {
    return '0.1.0';
  }
}

/**
 * Inspects local git status and optionally fetches upstream commit info.
 */
async function getUpdateStatus({ fetchRemote = false } = {}) {
  const cfg = getConfig();
  const upstreamRepo = cfg.upstream_repo || '';
  const upstreamBranch = cfg.upstream_branch || 'main';
  const version = readPackageVersion();
  const hasGitDir = fs.existsSync(path.join(ROOT_DIR, '.git'));

  const result = {
    version,
    upstreamRepo,
    upstreamBranch,
    hasGitDir,
    localCommit: null,
    localShortCommit: null,
    localCommitMessage: null,
    localCommitDate: null,
    currentBranch: null,
    remoteOriginUrl: null,
    remoteCommit: null,
    remoteShortCommit: null,
    remoteCommitMessage: null,
    remoteCommitDate: null,
    commitsBehind: 0,
    incomingCommits: [],
    hasUpdate: false,
    updateInProgress
  };

  if (!hasGitDir) {
    return result;
  }

  try {
    const { stdout: logOut } = await runCmd('git', ['log', '-1', '--format=%H|%h|%s|%ci'], 5000);
    const [fullHash, shortHash, subject, dateStr] = logOut.split('|');
    result.localCommit = fullHash || null;
    result.localShortCommit = shortHash || null;
    result.localCommitMessage = subject || null;
    result.localCommitDate = dateStr || null;
  } catch {
    // Ignore if repo has no commits
  }

  try {
    const { stdout: branchOut } = await runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], 5000);
    result.currentBranch = branchOut || null;
  } catch {
    // Ignore
  }

  try {
    const { stdout: remoteOut } = await runCmd('git', ['remote', 'get-url', 'origin'], 5000);
    result.remoteOriginUrl = remoteOut || null;
  } catch {
    // Ignore if origin is not set
  }

  if (fetchRemote && upstreamRepo) {
    if (!validateGitRemote(upstreamRepo)) {
      throw new Error(`Invalid upstream repository URL: "${upstreamRepo}"`);
    }
    if (!validateGitBranch(upstreamBranch)) {
      throw new Error(`Invalid upstream branch name: "${upstreamBranch}"`);
    }
    await ensureGitInitialized(upstreamRepo);
    await runCmd('git', ['fetch', '--prune', '--', upstreamRepo, upstreamBranch], 30000);

    const { stdout: remoteLog } = await runCmd(
      'git',
      ['log', '-1', '--format=%H|%h|%s|%ci', 'FETCH_HEAD'],
      5000
    );
    const [rFull, rShort, rSubj, rDate] = remoteLog.split('|');
    result.remoteCommit = rFull || null;
    result.remoteShortCommit = rShort || null;
    result.remoteCommitMessage = rSubj || null;
    result.remoteCommitDate = rDate || null;

    if (result.localCommit && result.remoteCommit) {
      result.hasUpdate = result.localCommit !== result.remoteCommit;
      if (result.hasUpdate) {
        try {
          const { stdout: countOut } = await runCmd(
            'git',
            ['rev-list', '--count', 'HEAD..FETCH_HEAD'],
            5000
          );
          result.commitsBehind = Number(countOut) || 0;

          const { stdout: incomingOut } = await runCmd(
            'git',
            ['log', 'HEAD..FETCH_HEAD', '--oneline', '-n', '15'],
            5000
          );
          result.incomingCommits = incomingOut
            ? incomingOut.split('\n').map((line) => line.trim()).filter(Boolean)
            : [];
        } catch {
          result.commitsBehind = 1;
        }
      }
    }
  }

  return result;
}

/**
 * Ensures git repository is initialized in ROOT_DIR (e.g. if deployed from a release archive).
 */
async function ensureGitInitialized(upstreamRepo) {
  const hasGitDir = fs.existsSync(path.join(ROOT_DIR, '.git'));
  if (!hasGitDir) {
    if (!validateGitRemote(upstreamRepo)) {
      throw new Error(`Invalid upstream repository URL: "${upstreamRepo}"`);
    }
    await runCmd('git', ['init'], 10000);
    await runCmd('git', ['remote', 'add', 'origin', '--', upstreamRepo], 5000);
  }
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
        key === 'image_host' &&
        val &&
        typeof val === 'object' &&
        typeof userParsed.image_host === 'object'
      ) {
        for (const [subKey, subVal] of Object.entries(val)) {
          if (userParsed.image_host[subKey] === undefined) {
            userDoc.setIn(['image_host', subKey], subVal);
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
 * Pulls latest changes from configured upstream repository, preserves config.yaml & watermark.png,
 * updates npm dependencies if package.json changed, and returns execution details.
 */
async function performHotUpdate() {
  if (updateInProgress) {
    throw new Error('An update is already in progress. Please wait.');
  }

  const cfg = getConfig();
  const upstreamRepo = (cfg.upstream_repo || '').trim();
  const upstreamBranch = (cfg.upstream_branch || 'main').trim() || 'main';

  if (!upstreamRepo) {
    throw new Error('Upstream repository URL (upstream_repo) is not configured in config.yaml.');
  }
  if (!validateGitRemote(upstreamRepo)) {
    throw new Error(`Invalid upstream repository URL format: "${upstreamRepo}"`);
  }
  if (!validateGitBranch(upstreamBranch)) {
    throw new Error(`Invalid upstream branch name format: "${upstreamBranch}"`);
  }

  updateInProgress = true;
  const logs = [];
  const logStep = (msg) => {
    const entry = `[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ${msg}`;
    logs.push(entry);
    console.log(`[HotUpdate] ${msg}`);
  };

  // Back up user's config.yaml and custom watermark.png before touching git
  const userRawYaml = getRawConfigYaml();
  const watermarkBackup = fs.existsSync(WATERMARK_PATH) ? fs.readFileSync(WATERMARK_PATH) : null;
  const oldPkgHash = getFileSha256(PKG_PATH) + ':' + getFileSha256(PKG_LOCK_PATH);

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'config.backup.yaml'), userRawYaml, 'utf8');
    logStep(`Backed up config.yaml to data/config.backup.yaml`);

    const beforeStatus = await getUpdateStatus({ fetchRemote: false });
    const fromCommit = beforeStatus.localShortCommit || 'unknown';

    logStep(`Fetching latest commits from ${upstreamRepo} (branch: ${upstreamBranch})...`);
    await ensureGitInitialized(upstreamRepo);
    await runCmd('git', ['fetch', '--prune', '--', upstreamRepo, upstreamBranch], 45000);

    const { stdout: targetHashOut } = await runCmd('git', ['rev-parse', '--short', 'FETCH_HEAD'], 5000);
    const toCommit = targetHashOut || 'FETCH_HEAD';

    logStep(`Applying update (${fromCommit} -> ${toCommit})...`);
    await runCmd('git', ['reset', '--hard', 'FETCH_HEAD'], 15000);

    // Read the newly pulled upstream config.yaml before restoring user's config
    const upstreamRawYaml = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : '';
    restoreAndMergeUserConfig(userRawYaml, upstreamRawYaml);
    logStep(`Restored and merged user config.yaml (all credentials & settings preserved)`);

    if (watermarkBackup) {
      fs.writeFileSync(WATERMARK_PATH, watermarkBackup);
    }

    const newPkgHash = getFileSha256(PKG_PATH) + ':' + getFileSha256(PKG_LOCK_PATH);
    let depsUpdated = false;
    if (oldPkgHash !== newPkgHash) {
      logStep(`Detected changes in package.json; running npm install --omit=dev --ignore-scripts...`);
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      await runCmd(npmCmd, ['install', '--omit=dev', '--ignore-scripts'], 120000);
      depsUpdated = true;
      logStep(`Dependencies installed successfully`);
    } else {
      logStep(`package.json unchanged; skipped npm install`);
    }

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
    // Always ensure user's config.yaml is intact even if git reset/fetch failed mid-way
    try {
      saveRawConfigYaml(userRawYaml);
      if (watermarkBackup) fs.writeFileSync(WATERMARK_PATH, watermarkBackup);
    } catch {
      // Ignore secondary restore error
    }
    throw err;
  } finally {
    updateInProgress = false;
  }
}

/**
 * Gracefully restarts the current Node.js server process across all runtime modes:
 * - node --watch (touches server.js to trigger built-in watcher reload)
 * - PM2 / systemd (closes HTTP server and exits with 0 so supervisor respawns)
 * - Standalone `node src/server.js` / `npm start` (closes HTTP server to free port, then spawns fresh process)
 */
function restartServerProcess(httpServer, serverEntryFile) {
  const isWatchMode = process.execArgv.some((arg) => arg === '--watch' || arg.startsWith('--watch=')) ||
    process.env.npm_lifecycle_event === 'dev';
  const isPm2 = process.env.pm_id !== undefined || Boolean(process.env.PM2_HOME);

  console.log(`[HotUpdate] Restarting server process (mode: ${isWatchMode ? 'watch' : isPm2 ? 'pm2' : 'standalone'})...`);

  if (isWatchMode && serverEntryFile && fs.existsSync(serverEntryFile)) {
    const now = new Date();
    fs.utimesSync(serverEntryFile, now, now);
    return;
  }

  let respawned = false;
  const finishRestart = () => {
    if (respawned) return;
    respawned = true;

    if (!isPm2) {
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

module.exports = {
  readPackageVersion,
  getUpdateStatus,
  performHotUpdate,
  restartServerProcess
};

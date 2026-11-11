const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const OFFICIAL_UPSTREAM_REPO = 'https://github.com/weichen-ink/file-master-server.git';

/**
 * Resolves the effective clone/fetch URL by combining an optional mirror accelerator prefix
 * with the locked official repository.
 * Examples:
 *   - mirrorPrefix: "" -> "https://github.com/weichen-ink/file-master-server.git"
 *   - mirrorPrefix: "https://ghproxy.net/" -> "https://ghproxy.net/https://github.com/weichen-ink/file-master-server.git"
 *   - mirrorPrefix: "https://gitclone.com/github.com/weichen-ink/file-master-server.git" -> as-is
 */
function validateGitMirror(mirror) {
  if (!mirror) return true;
  const trimmed = String(mirror).trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('-') || /[\r\n\0`$;|&<>\\'"]/.test(trimmed)) return false;
  if (trimmed === OFFICIAL_UPSTREAM_REPO) return true;
  const checkTarget = trimmed.endsWith('/' + OFFICIAL_UPSTREAM_REPO)
    ? trimmed.slice(0, -(OFFICIAL_UPSTREAM_REPO.length + 1))
    : trimmed;
  if (!checkTarget || /\.git(\/|$)/i.test(checkTarget) || checkTarget.includes('weichen-ink')) {
    return false;
  }
  if (!/^https?:\/\/[\w.-]+(:\d+)?(\/[\w.\-\/~]+)?\/?$/i.test(checkTarget)) {
    return false;
  }
  try {
    const parsed = new URL(checkTarget);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    return true;
  } catch {
    return false;
  }
}

function getEffectiveUpstreamRepo(mirrorPrefix = '') {
  const m = String(mirrorPrefix || '').trim();
  if (!m) return OFFICIAL_UPSTREAM_REPO;
  if (m === OFFICIAL_UPSTREAM_REPO || m === 'https://github.com/weichen-ink/file-master-server') {
    return OFFICIAL_UPSTREAM_REPO;
  }
  if (m.endsWith('/' + OFFICIAL_UPSTREAM_REPO)) {
    const prefix = m.slice(0, -(OFFICIAL_UPSTREAM_REPO.length + 1));
    return validateGitMirror(prefix)
      ? prefix.replace(/\/+$/, '') + '/' + OFFICIAL_UPSTREAM_REPO
      : OFFICIAL_UPSTREAM_REPO;
  }
  if (!validateGitMirror(m)) {
    return OFFICIAL_UPSTREAM_REPO;
  }
  return m.replace(/\/+$/, '') + '/' + OFFICIAL_UPSTREAM_REPO;
}

function validateGitRemote(repo) {
  if (typeof repo !== 'string') return false;
  const trimmed = repo.trim();
  if (!trimmed || trimmed.startsWith('-')) return false;
  if (/[\r\n\0`$;|&<>\\'"]/.test(trimmed)) return false;
  if (trimmed === OFFICIAL_UPSTREAM_REPO) return true;
  if (trimmed.endsWith('/' + OFFICIAL_UPSTREAM_REPO)) {
    const prefix = trimmed.slice(0, -(OFFICIAL_UPSTREAM_REPO.length + 1));
    return Boolean(prefix) && validateGitMirror(prefix);
  }
  return false;
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
function executeCommand(rootDir, cmd, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: rootDir,
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


function createUpdateGit({ rootDir: ROOT_DIR, getConfig, isUpdateInProgress, runCommand }) {
  const PKG_PATH = path.join(ROOT_DIR, 'package.json');
  const runCmd = runCommand || ((cmd, args, timeout) => executeCommand(ROOT_DIR, cmd, args, timeout));
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
    const officialRepo = OFFICIAL_UPSTREAM_REPO;
    const upstreamMirror = (cfg.upstream_mirror || '').trim();
    const effectiveRepo = getEffectiveUpstreamRepo(upstreamMirror || cfg.upstream_repo);
    const upstreamBranch = (cfg.upstream_branch || 'main').trim() || 'main';
    const version = readPackageVersion();
    const hasGitDir = fs.existsSync(path.join(ROOT_DIR, '.git'));

    const result = {
      version,
      officialRepo,
      upstreamMirror,
      effectiveRepo,
      upstreamRepo: effectiveRepo,
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
      remoteVersion: null,
      remoteCommitDate: null,
      commitsBehind: 0,
      incomingCommits: [],
      incomingChanges: [],
      hasUpdate: false,
      updateInProgress: isUpdateInProgress()
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

    if (fetchRemote && effectiveRepo) {
      if (!validateGitRemote(effectiveRepo)) {
        throw new Error(`Invalid upstream repository URL: "${effectiveRepo}"`);
      }
      if (!validateGitBranch(upstreamBranch)) {
        throw new Error(`Invalid upstream branch name: "${upstreamBranch}"`);
      }
      await ensureGitInitialized(effectiveRepo);
      await runCmd('git', ['fetch', '--prune', '--', effectiveRepo, upstreamBranch], 30000);

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
      try {
        const { stdout: packageSource } = await runCmd('git', ['show', 'FETCH_HEAD:package.json'], 5000);
        const version = JSON.parse(packageSource).version;
        result.remoteVersion = typeof version === 'string' ? version : null;
      } catch { /* A commit can update files without a readable package manifest. */ }


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
              ['log', 'HEAD..FETCH_HEAD', '--format=%H%x00%s%x00%b%x00', '-n', '15'],
              5000
            );
            const fields = incomingOut.split('\0');
            for (let i = 0; i + 2 < fields.length; i += 3) {
              const hash = fields[i].trim();
              if (!/^[a-f0-9]{40,64}$/i.test(hash)) continue;
              result.incomingChanges.push({hash, title: fields[i + 1], body: fields[i + 2].trim()});
            }
            result.incomingCommits = result.incomingChanges.map(change => `${change.hash.slice(0,7)} ${change.title}`);
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

  return { runCmd, getFileSha256, readPackageVersion, getUpdateStatus, ensureGitInitialized };
}
module.exports = { createUpdateGit, OFFICIAL_UPSTREAM_REPO, getEffectiveUpstreamRepo,
  validateGitMirror, validateGitRemote, validateGitBranch };

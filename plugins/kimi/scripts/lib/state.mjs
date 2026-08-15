import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
// KMP-23: KIMI_COMPANION_DATA is our own session export (set by the
// session-lifecycle hook) and always wins. CLAUDE_PLUGIN_DATA is the
// harness-provided per-plugin dir — but it leaks across plugins at the
// session level (the codex plugin's hook exports ITS dir to every process),
// so it is only a fallback for contexts our hook never reached.
const KIMI_DATA_ENV = "KIMI_COMPANION_DATA";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "kimi-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

// One migration attempt per resolved dir per process — resolveStateDir is
// called on every state read and must stay cheap after the first check.
const migrationAttempted = new Set();

// KMP-23 upgrade path: state used to live at <data>/state/<slug>. Migrate it
// into the namespaced dir ONLY from a data dir whose basename identifies as
// OURS (harness-assigned "kimi-<marketplace>") — a leaked codex dir also has
// a state/<slug> with identical filenames and near-identical schema, and
// silently adopting it would import the very contamination KMP-23 removes.
// Migration preserves the stop-review-gate flag (a user-enabled safety gate
// must not silently turn off on upgrade) and job history, rewriting each
// job's absolute logFile path to the new location.
function migrateLegacyStateDir(newDir, slugDirName) {
  if (migrationAttempted.has(newDir)) {
    return;
  }
  migrationAttempted.add(newDir);
  if (fs.existsSync(newDir)) {
    return;
  }
  for (const envName of [KIMI_DATA_ENV, PLUGIN_DATA_ENV]) {
    const dataDir = process.env[envName];
    if (!dataDir || !/^kimi-/.test(path.basename(dataDir))) {
      continue;
    }
    const legacyDir = path.join(dataDir, "state", slugDirName);
    if (!fs.existsSync(legacyDir)) {
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      fs.renameSync(legacyDir, newDir);
    } catch (error) {
      // A concurrent process may have migrated first (rename EEXIST/ENOENT);
      // anything else is worth a visible warning — a silent failure here
      // silently disables a user-enabled review gate (Kimi review 2026-07-30).
      if (error?.code !== "EEXIST" && error?.code !== "ENOENT") {
        process.stderr.write(`[kimi-companion] legacy state migration failed (${error?.message}); continuing with fresh state at ${newDir}\n`);
      }
      return;
    }
    try {
      // Pre-fix broker.json was a SHARED file both plugins wrote — it may
      // name the codex plugin's live broker and pid. Broker state is
      // ephemeral; NEVER import it into the namespace where our
      // unhealthy-pointer teardown kills recorded pids (Kimi review
      // 2026-07-30: that path killed foreign brokers via migrated records).
      for (const ephemeral of ["broker.json", "broker.lock", "state.lock"]) {
        fs.rmSync(path.join(newDir, ephemeral), { recursive: true, force: true });
      }
      const stateFile = path.join(newDir, STATE_FILE_NAME);
      if (fs.existsSync(stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        const legacyPrefix = legacyDir.endsWith(path.sep) ? legacyDir : legacyDir + path.sep;
        for (const job of parsed.jobs ?? []) {
          for (const key of ["logFile", "jobFile"]) {
            if (typeof job[key] === "string" && job[key].startsWith(legacyPrefix)) {
              job[key] = path.join(newDir, path.relative(legacyDir, job[key]));
            }
          }
        }
        fs.writeFileSync(stateFile, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      }
    } catch (error) {
      // The rename already happened; a failed rewrite leaves stale absolute
      // job paths — degraded but functional (result/log reads report
      // missing). Say so instead of hiding it.
      process.stderr.write(`[kimi-companion] migrated state at ${newDir} but could not rewrite job paths (${error?.message})\n`);
    }
    return;
  }
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const dataDir = process.env[KIMI_DATA_ENV] || process.env[PLUGIN_DATA_ENV];
  // The extra "kimi" segment namespaces our state INSIDE whatever data dir
  // we land in: even when the leaked codex dir is all we have, our
  // state/broker files can never collide with the codex companion's
  // identically-named files at <data>/state/<slug> (KMP-23).
  const stateRoot = dataDir ? path.join(dataDir, "kimi", "state") : FALLBACK_STATE_ROOT_DIR;
  const slugDirName = `${slug}-${hash}`;
  const stateDir = path.join(stateRoot, slugDirName);
  migrateLegacyStateDir(stateDir, slugDirName);
  return stateDir;
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// state.json is a shared index mutated by launcher, worker, and cancel
// processes concurrently; a read/modify/write without a lock can erase
// another process's update. mkdir is the same atomic primitive the broker
// lock uses; the wait is synchronous because all callers are sync.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireStateLock(cwd) {
  const lockDir = path.join(resolveStateDir(cwd), "state.lock");
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      return lockDir;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > 2000) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch {}
      sleepSync(50);
    }
  }
  // Proceeding unlocked beats deadlocking a CLI command forever.
  return null;
}

function releaseStateLock(lockDir) {
  if (!lockDir) {
    return;
  }
  try {
    fs.rmdirSync(lockDir);
  } catch {}
}

export function saveState(cwd, state) {
  const lock = acquireStateLock(cwd);
  try {
    return saveStateUnlocked(cwd, state);
  } finally {
    releaseStateLock(lock);
  }
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
}

export function updateState(cwd, mutate) {
  const lock = acquireStateLock(cwd);
  try {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  } finally {
    releaseStateLock(lock);
  }
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

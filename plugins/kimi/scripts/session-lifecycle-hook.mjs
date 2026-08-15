#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/acp-client.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { listJobs, resolveStateFile, updateState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "KIMI_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  // Kill workers outside the lock, but mutate state via updateState so a
  // stale snapshot can never overwrite another session's concurrent jobs
  // or config changes.
  for (const job of listJobs(workspaceRoot)) {
    if (job.sessionId !== sessionId) {
      continue;
    }
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  updateState(workspaceRoot, (state) => {
    state.jobs = state.jobs.filter((job) => job.sessionId !== sessionId);
  });
}

// A workspace broker is SHARED: if any other session still has active jobs,
// this session's end must not tear it down under them. Idle sessions losing
// the broker is fine — the next call respawns it and sessions persist.
function otherSessionsActive(cwd, sessionId) {
  if (!cwd) {
    return false;
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  return listJobs(workspaceRoot).some(
    (job) => (job.status === "queued" || job.status === "running") && job.sessionId !== sessionId
  );
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  // KMP-23: export under OUR name, not the generic CLAUDE_PLUGIN_DATA — the
  // codex plugin's hook exports the same generic name session-wide, and
  // whichever hook runs last used to hijack every raw-shell companion call
  // into the other plugin's data dir. KIMI_COMPANION_DATA wins in state.mjs.
  // Basename guard: if an earlier foreign hook's export already reached this
  // process, capturing it would pin our state inside THEIR dir for the whole
  // session — skip instead (state.mjs falls back per-invocation).
  const hookDataDir = process.env[PLUGIN_DATA_ENV];
  if (hookDataDir && /^kimi-/.test(path.basename(hookDataDir))) {
    appendEnvVar("KIMI_COMPANION_DATA", hookDataDir);
  }
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  cleanupSessionJobs(cwd, sessionId);

  if (otherSessionsActive(cwd, sessionId)) {
    // Another session's work is mid-flight on the shared broker: leave the
    // runtime alone; only this session's jobs were cleaned up.
    return;
  }

  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

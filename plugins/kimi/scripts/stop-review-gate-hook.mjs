#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { getKimiAvailability } from "./lib/kimi.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// hooks.json kills the whole hook at 900s; the inner task timeout needs
// headroom below that so the explicit timeout branch can still run.
const STOP_REVIEW_TIMEOUT_MS = 14 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

// The stop-gate runs under the REJECT policy, and Kimi has no read-only
// sandbox: shell tools (git status/diff) get permission-rejected and Kimi
// then ends its turn silently. So the working-tree context must be provided
// INLINE (the review command's architecture); Kimi's file-reading tool
// needs no permission and covers anything not inlined.
function buildRepoContextBlock(cwd) {
  try {
    ensureGitRepository(cwd);
  } catch {
    // Documented fail-open: without git the gate cannot verify what the
    // previous turn changed. It allows the stop rather than blocking every
    // non-git workspace forever.
    return "Not a git repository: the gate cannot verify changes here. ALLOW immediately.";
  }
  try {
    const target = resolveReviewTarget(cwd, { scope: "working-tree" });
    const context = collectReviewContext(cwd, target, { maxInlineFiles: 20, maxInlineDiffBytes: 512 * 1024 });
    if (context.inputMode === "self-collect") {
      // Shell tools are permission-blocked, so a summary-only context MUST
      // redirect Kimi to its file-reading tool or big changes go unseen.
      return [
        context.content,
        "",
        "The full diff was too large to inline. Before deciding, use your file-reading tool to inspect every file in the Changed Files list above."
      ].join("\n");
    }
    return context.content;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Repository context collection failed (${message}). Judge from the response text and your file-reading tool.`;
  }
}

function buildStopReviewPrompt(cwd, input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock,
    CONTEXT_BOUNDARY: crypto.randomBytes(8).toString("hex"),
    REPO_CONTEXT_BLOCK: buildRepoContextBlock(cwd)
  });
}

function buildSetupNote(cwd) {
  const availability = getKimiAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Kimi is not set up for the review gate.${detail} Run /kimi:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Kimi review task returned no final output. Run /kimi:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Kimi stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Kimi review task returned an unexpected answer. Run /kimi:review --wait manually or bypass the gate."
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "kimi-companion.mjs");
  const prompt = buildStopReviewPrompt(cwd, input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  // Prompt goes via stdin: a single positional would be re-tokenized by the
  // slash-command argument convention, mangling the multi-line template.
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json"], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    input: prompt,
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Kimi review task timed out after 15 minutes. Run /kimi:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    if (/busy with another turn/i.test(detail)) {
      return {
        ok: false,
        reason: "Another Kimi turn is running, so the stop-gate review could not run. Wait for it (/kimi:status) or cancel it (/kimi:cancel), then stop again."
      };
    }
    return {
      ok: false,
      reason: detail
        ? `The stop-time Kimi review task failed: ${detail}`
        : "The stop-time Kimi review task failed. Run /kimi:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Kimi review task returned invalid JSON. Run /kimi:review --wait manually or bypass the gate."
    };
  }
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Kimi task ${runningJob.id} is still running. Check /kimi:status and use /kimi:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

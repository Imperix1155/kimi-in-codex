// Review-output values are Kimi-authored text downstream of reviewed repo
// content — hostile values must not be able to spoof rendered structure.
// Inline fields flatten to one line (control chars stripped, length capped);
// block fields keep newlines but every line is indented so a "# heading" or
// "- [critical] ..." inside a body cannot masquerade as renderer output.
const MAX_INLINE_FIELD_CHARS = 300;
const MAX_BLOCK_FIELD_CHARS = 4000;
const MAX_RAW_ECHO_CHARS = 20000;

function sanitizeInline(value, maxChars = MAX_INLINE_FIELD_CHARS) {
  const flattened = String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flattened.length > maxChars ? `${flattened.slice(0, maxChars - 1)}…` : flattened;
}

function indentBlock(value, indent = "  ", maxChars = MAX_BLOCK_FIELD_CHARS) {
  let text = String(value ?? "")
    // Lone \r must become a real newline BEFORE the strip and the split —
    // markdown treats it as a line break, so leaving it embedded would put
    // forged content at column zero.
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, "")
    .trimEnd();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n[truncated]`;
  }
  return text
    .split("\n")
    .map((line) =>
      // CommonMark allows headings/bullets with up to three leading spaces,
      // so indentation alone cannot neutralize them — escape the leading
      // structure token too.
      `${indent}${line
        .replace(/^(\s*)([#>\-*+`])/, "$1\\$2")
        .replace(/^(\s*)(\d+)([.)])/, "$1$2\\$3")}`
    )
    .join("\n");
}

// A fenced block is only safe when the fence is longer than any backtick
// run inside the content — otherwise embedded ``` breaks out of the block.
function safeFence(content, info = "text") {
  let text = String(content ?? "");
  if (text.length > MAX_RAW_ECHO_CHARS) {
    text = `${text.slice(0, MAX_RAW_ECHO_CHARS)}\n[truncated]`;
  }
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

const VALID_VERDICTS = new Set(["approve", "needs-attention"]);
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

// Strict schema-shape validation (exported: the review command fails the job
// on a nonnull result). Kept in sync with schemas/review-output.schema.json;
// unknown extra properties are tolerated.
export function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !VALID_VERDICTS.has(data.verdict.trim())) {
    return `Invalid verdict ${JSON.stringify(data.verdict)}; expected "approve" or "needs-attention".`;
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  for (const [index, finding] of data.findings.entries()) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      return `Finding ${index + 1} is not an object.`;
    }
    if (typeof finding.severity !== "string" || !VALID_SEVERITIES.has(finding.severity)) {
      return `Finding ${index + 1} has invalid severity ${JSON.stringify(finding.severity)}.`;
    }
    for (const key of ["title", "body", "file"]) {
      if (typeof finding[key] !== "string" || !finding[key].trim()) {
        return `Finding ${index + 1} is missing string \`${key}\`.`;
      }
    }
    if (!Number.isInteger(finding.line_start) || finding.line_start < 1) {
      return `Finding ${index + 1} has invalid \`line_start\`.`;
    }
    if (!Number.isInteger(finding.line_end) || finding.line_end < 1) {
      return `Finding ${index + 1} has invalid \`line_end\`.`;
    }
    if (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1) {
      return `Finding ${index + 1} has invalid \`confidence\`.`;
    }
    if (typeof finding.recommendation !== "string") {
      return `Finding ${index + 1} is missing string \`recommendation\`.`;
    }
  }
  if (!Array.isArray(data.next_steps) || !data.next_steps.every((step) => typeof step === "string" && step.trim())) {
    return "`next_steps` must be an array of non-empty strings.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Kimi Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/kimi:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/kimi:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Kimi session ID: ${job.threadId}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /kimi:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /kimi:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /kimi:review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${sanitizeInline(section, 1000)}`);
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Kimi Setup",
    "",
    `Status: ${report.ready ? "ready" : `needs attention (${report.state})`}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- kimi: ${report.kimi.detail}`,
    `- acp runtime: ${report.acp?.detail ?? "not probed"}`,
    `- auth: ${report.auth.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.versionNote) {
    lines.push(`Note: ${report.versionNote}`, "");
  }

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Kimi ${meta.reviewLabel}`,
      "",
      "Kimi did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", safeFence(parsedResult.rawOutput));
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Kimi ${meta.reviewLabel}`,
      "",
      `Target: ${sanitizeInline(meta.targetLabel)}`,
      "Kimi returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", safeFence(parsedResult.rawOutput));
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Kimi ${meta.reviewLabel}`,
    "",
    `Target: ${sanitizeInline(meta.targetLabel)}`,
    `Verdict: ${sanitizeInline(data.verdict, 40)}`,
    "",
    sanitizeInline(data.summary, 2000),
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${sanitizeInline(finding.severity, 20)}] ${sanitizeInline(finding.title)} (${sanitizeInline(finding.file)}${lineSuffix})`);
      lines.push(indentBlock(finding.body));
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${sanitizeInline(finding.recommendation, 1000)}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${sanitizeInline(step, 500)}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput.trim() : "";
  const toolOutputs = (Array.isArray(parsedResult?.toolOutputs) ? parsedResult.toolOutputs : []).filter(
    (entry) => entry && typeof entry.text === "string" && entry.text.trim()
  );
  const stderr = String(parsedResult?.stderr ?? "").trim();

  const parts = [];
  if (rawOutput) {
    parts.push(rawOutput);
  }
  // Surface tool / sub-agent output. When the model routes the real work
  // through tools and emits only a thin message (or none), this content IS
  // the deliverable — appended verbatim so nothing completed is lost. Titles
  // are agent-authored, so they are flattened to one line; bodies are the
  // task's own output and stay verbatim by design.
  if (toolOutputs.length > 0) {
    if (rawOutput) {
      parts.push("", "---", "", "### Tool / sub-agent output");
    }
    for (const entry of toolOutputs) {
      const label = sanitizeInline(entry.title || entry.kind || "tool", 120);
      const statusSuffix = entry.status && entry.status !== "completed" ? ` (${sanitizeInline(entry.status, 20)})` : "";
      parts.push("", `#### ${label}${statusSuffix}`, "", entry.text.trim());
    }
  }

  if (parts.length > 0) {
    return `${parts.join("\n").trim()}\n`;
  }

  // Nothing usable at all. Report that honestly — never present raw client
  // stderr AS the answer; offer it only as a clearly-labelled diagnostic.
  const lines = ["Kimi produced no output for this task: the turn ended without a message or any tool results."];
  if (stderr) {
    lines.push("", "Diagnostic output (stderr, not the task result):", safeFence(stderr));
  }
  return `${lines.join("\n")}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# Kimi Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending the session will trigger a fresh Kimi adversarial review and block if it finds issues.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Kimi Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nKimi session ID: ${threadId}\n`;
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.codex?.stdout === "string" && storedJob.result.codex.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nKimi session ID: ${threadId}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nKimi session ID: ${threadId}\n`;
  }

  const lines = [
    `# ${job.title ?? "Kimi Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Kimi session ID: ${threadId}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    "# Kimi Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/kimi:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}

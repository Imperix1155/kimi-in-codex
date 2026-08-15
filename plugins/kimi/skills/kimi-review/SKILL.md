---
name: kimi-review
description: Use when a user or review harness supplies a saved diff artifact and its SHA-256 for an independent, adversarial, SHA-pinned Kimi review.
---

# Kimi Review

Review one frozen diff artifact without substituting mutable repository state.

## Workflow

1. Require both the artifact path and its 64-hex SHA-256. If either is absent, stop and report `NOT REVIEWED: frozen diff path and SHA-256 are required.`
2. Set `DIFF_FILE` and `DIFF_SHA256` from the supplied values without recomputing, rewriting, or summarizing the artifact.
3. If `PLUGIN_ROOT` is unset, resolve the plugin root from this `SKILL.md` path: it is the ancestor containing `.codex-plugin/plugin.json`.
4. Run exactly once in the foreground:

   ```bash
   node "${PLUGIN_ROOT}/scripts/kimi-companion.mjs" review --diff-file "${DIFF_FILE}" --diff-sha256 "${DIFF_SHA256}" --json
   ```

5. Accept the leg as reviewed only when the command exits zero and its JSON has all of:
   - `reviewStatus: "REVIEWED"`
   - `target.mode: "frozen-diff"`
   - `target.diffSha256` equal to the supplied SHA-256, case-insensitively
   - a positive integer `target.byteCount`
   - a schema-validated `result`
6. Report status, verified SHA-256, byte count, verdict, summary, findings, and next steps.
7. On a nonzero exit, malformed JSON, missing provenance, or any status other than `REVIEWED`, report `NOT REVIEWED` with the runtime's concrete reason.

## Integrity rules

- Do not retry against `git diff`, a working tree, a branch, or another artifact.
- Do not run in the background or route through status/result/cancel workflows.
- Do not edit, apply, or delete the artifact.
- Do not describe a failed or unavailable Kimi leg as clean, approved, or reviewed.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Computing a fresh hash after the caller supplied one | Pass the supplied digest; the runtime independently verifies the saved bytes. |
| Falling back when the hash mismatches | Report `NOT REVIEWED`; the mismatch proves the evidence is stale or wrong. |
| Reporting only Kimi's verdict | Include the verified SHA-256 and byte count so a coverage ledger can pin the evidence. |

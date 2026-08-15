# Codex-Native Frozen Review Design

## Goal

Add one honest Codex-native Kimi review path that consumes a frozen diff artifact and its SHA-256, reviews exactly those verified bytes, and makes every unavailable or failed leg explicit as `NOT REVIEWED`.

## Approved approach

Extend the retained companion runtime with a frozen-artifact mode:

```text
review --diff-file <path> --diff-sha256 <64-hex> --json [--model <id>] [focus]
```

The runtime reads the artifact once as bytes, validates the supplied digest syntax, computes SHA-256 from that buffer, and rejects an empty, unreadable, non-UTF-8, or mismatched artifact before probing or starting Kimi. A successful review payload includes the normalized digest and byte count.

The existing live Git review modes remain legacy compatibility behavior. The new Codex skill uses only frozen-artifact mode and never substitutes a live working-tree or branch review.

## Exact-input isolation

After verification, decode the retained buffer as UTF-8 and inline it in the existing adversarial prompt. Do not recompute the Git diff, summarize it, or allow the large-diff self-collection path.

Create a temporary empty directory for the ACP session and pass it as the session `cwd`, while retaining the caller repository as the broker/job-state workspace. This prevents ordinary Kimi file browsing from observing a newer checkout than the artifact. Always remove the temporary directory after the turn. The session stays read-only: every ACP permission request is rejected and the existing granted-permission defense rejects the result.

The prompt identifies the target only by digest and byte count and states that the inlined snapshot is the complete review evidence. The artifact path is not disclosed to Kimi.

## Result and failure contract

On success, JSON output retains the existing schema-validated review result and adds:

```json
{
  "reviewStatus": "REVIEWED",
  "target": {
    "mode": "frozen-diff",
    "label": "frozen diff sha256:<digest>",
    "diffSha256": "<digest>",
    "byteCount": 123
  }
}
```

Any missing option, malformed digest, read/decode error, empty artifact, digest mismatch, Kimi/auth/runtime error, granted review permission, empty response, invalid JSON, or schema-invalid result exits nonzero. JSON failures use `reviewStatus: "NOT REVIEWED"` and a concrete error. Hash mismatches include expected and actual digests; no Kimi process may start before that rejection.

## Codex skill

Add `plugins/kimi/skills/kimi-review`. It triggers for frozen-diff, SHA-pinned, adversarial, or independent Kimi review requests. It requires both the saved artifact path and SHA-256, resolves `PLUGIN_ROOT`, invokes the companion once in foreground JSON mode, and reports the structured findings with the verified digest and byte count. Missing evidence or a nonzero/invalid response is reported as `NOT REVIEWED`; the skill must not retry against live Git state.

## Tests

- Focused runtime tests prove malformed/mismatched hashes fail before the fake ACP agent starts.
- A prompt-echo fixture proves the exact artifact text is present, live checkout content is absent, and the session cwd differs from the repository and contains no files.
- Success tests prove `REVIEWED`, digest, byte count, schema validation, and permission rejection.
- Failure tests prove invalid structured Kimi output is `NOT REVIEWED` and nonzero.
- The Codex package test proves the native skill and UI metadata exist and contain no Claude argument or fallback behavior.
- Run plugin/skill validators, the full deterministic engine battery, and a safe live review of a temporary seeded artifact when authentication is available.

## Explicitly deferred

- reviewing a mutable working tree or branch through the Codex skill
- background review, status, result, and cancellation
- automatic diff freezing or ledger orchestration
- stop hooks and automatic merge gating
- task delegation and rescue
- MCP exposure

This slice is a review leg, not the complete VRX review-loop implementation.

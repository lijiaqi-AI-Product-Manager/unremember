# Changelog

## v1.0.4 — 2026-10-24

Post-release hardening from the same audit cycle.

- Claude live detection now fails closed (`unknown`) when the sessions registry is missing; `UNREMEMBER_CLAUDE_LIVE_PROBE=off` is available only as an explicit test escape hatch.
- Apply takes an owner-only plan lock, so two processes cannot execute the same plan concurrently.
- Plans can be listed/removed with `plans` / `purge-plans`.
- Large Claude transcripts over `UNREMEMBER_MAX_SESSION_BYTES` (default 48 MiB) fail with a clear error instead of risking multi-GB memory use; the limit is configurable.
- Added more regression tests; total 39 passing, 1 platform-specific skip.
- npm 1.0.3 remains staged; 1.0.4 supersedes it.

## v1.0.3 — 2026-10-24

Security and correctness release driven by independent audits.

- Plan files no longer persist `session.preview`; a plan now contains only hashes, paths and ops.
- Apply validates every path against the current adapter store set, rejects symlinks, and fails loudly if automatic restore fails.
- Verify rejects a hostile agent `session_id` before cleanup, treats empty/agent-silent answers as errors, treats all-`unknown` runs as inconclusive, and detects pointer-only leaks.
- BOM-prefixed JSONL is parsed; any unparseable non-empty JSONL line is a blocker instead of a silent miss.
- MEMORY.md cleanup matches the exact markdown link target.
- Backups/plans/pending use owner-only permissions; existing file modes are preserved on atomic writes.
- dsh honors `--scope span`, reports mixed `.jsonl`/`.jsonl.zstd` encodings as blockers, and quotes resume placeholders.
- Encrypted pending without a key now reports the missing key instead of "no pending request".
- Node <22.19 is rejected by a small bootstrap before the zstd import can crash the CLI.
- Added `plans` / `purge-plans`; `sessions` masks previews unless `--show-preview`.
- Added regression tests for plan plaintext, malicious plan paths, verify cleanup/empty answers, BOM/torn JSONL, memory index, permissions, pending keys, dsh scope, and resume quoting.
- Coverage thresholds and a semantic-upload disclosure update.

## v1.0.2 — 2026-10-24

Package/CLI version consistency for the npm staged release.

- Bumped package and CLI version to 1.0.2.
- README now states the npm staging/2FA approval requirement instead of recommending a placeholder install.
- GitHub Release remains the supported download until the staged npm 1.0.2 is approved.

## v1.0.0 — 2026-10-24

First stable release.

- Semantic locator and leak judge for `--about` / `--semantic`, using a configurable OpenAI-chat-compatible endpoint; `plan --semantic` requires explicit `--yes` because candidate excerpts leave the machine.
- `doctor` command: Node, config dirs, semantic, encryption, backups, session count and dsh resume mode.
- dsh resume hook: `UNREMEMBER_DSH_RESUME_CMD` executes a user launcher with `{sessionId}` / `{cwd}`; otherwise the command is printed.
- Optional AES-256-GCM encryption for backups and pending requests via `UNREMEMBER_ENCRYPTION_KEY` / `_FILE`; wrong/missing keys fail closed.
- Coverage job and coverage script; zstd corrupt/truncated-frame tests.
- CI matrix: Ubuntu, Windows and macOS × Node 22/24.
- Mock-agent verify E2E tests: no-leak and leaked-canary paths.
- Release workflow: package, SHA-256, CycloneDX SBOM and GitHub build provenance attestation.
- npm publishing workflow prepared (requires `NPM_TOKEN` repository secret).
- Versioned 1.0.0; no semantic or dsh-resume stubs.

## v0.1.0 — 2026-10-24

First public MVP.

- Claude Code adapter: transcript/subagents, history, memory + index, file-history, paste-cache, tool-results, API request blobs, compact summaries, parent/logical-parent relinking, tool-pair closure.
- dsh adapter: v4 JSONL + Zstandard logs, seq-preserving field redaction, inbox/assistant stream/compaction/title cleanup, two-frame write-back. Decodes every concatenated Zstandard frame; Node versions that stop after the first frame no longer truncate the log.
- CLI: `sessions`, `plan`, `apply`, `verify`, `resume`, `rollback`, `backups`, `purge-backups`.
- Safety: dry-run by default, live-session refusal, SHA-256 preflight, backups, atomic writes, blocker/residual simulation.
- Verification: 20 probes across 5 categories on a fork; literal leak rate and exit code.
- Docs: README, skill, GitHub CI, issue templates, security policy.
- Not included in this release: semantic locator/judge, Codex, domestic cloud platforms, active-session editing.

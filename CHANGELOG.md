# Changelog

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

# Changelog

## v0.1.0 — 2026-10-24

First public MVP.

- Claude Code adapter: transcript/subagents, history, memory + index, file-history, paste-cache, tool-results, API request blobs, compact summaries, parent/logical-parent relinking, tool-pair closure.
- dsh adapter: v4 JSONL + Zstandard logs, seq-preserving field redaction, inbox/assistant stream/compaction/title cleanup, two-frame write-back.
- CLI: `sessions`, `plan`, `apply`, `verify`, `resume`, `rollback`, `backups`, `purge-backups`.
- Safety: dry-run by default, live-session refusal, SHA-256 preflight, backups, atomic writes, blocker/residual simulation.
- Verification: 20 probes across 5 categories on a fork; literal leak rate and exit code.
- Docs: README, skill, GitHub CI, issue templates, security policy.
- Not included in this release: semantic locator/judge, Codex, domestic cloud platforms, active-session editing.

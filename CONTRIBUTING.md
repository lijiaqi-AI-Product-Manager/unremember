# Contributing

Thanks for helping make local agents forget safely.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Requirements: Node.js 22.19+.

## Rules

1. **Never commit real sessions, secrets, usernames, or credentials.** Tests and bug reports must use synthetic data (`青柠绿-7429` is the project's standard canary).
2. Do not edit a real home directory in tests. Use `CLAUDE_CONFIG_DIR`, `DSH_HOME`, `UNREMEMBER_HOME`, and temporary directories.
3. A change to an adapter needs a fixture that exercises the actual on-disk shape, plus a rollback/round-trip assertion.
4. A change to planning needs a test for `residualHits === 0` or an explicit blocker.
5. Do not make `apply` more permissive without a corresponding `verify` and rollback story.

## Pull requests

- Keep the diff focused.
- Update `README.md` / `CHANGELOG.md` when behavior or compatibility changes.
- Run the full suite before opening the PR.
- Describe the real store shape you tested against, but redact paths and content.

## Adding a platform

An adapter must provide:

- session discovery and `last` resolution
- a reliable live-session check
- a complete list of stores (including off-session copies)
- planning with dependency closure and a simulated residual check
- a write-back that preserves the platform's invariants
- a fork/verify story that never mutates the original

If any of those is unconfirmed, document it rather than guessing.

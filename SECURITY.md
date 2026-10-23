# Security

## Reporting

Do **not** open a public issue for a vulnerability involving secret leakage, path traversal, or credential exposure. Use GitHub's private vulnerability reporting for this repository, or contact the maintainer through the profile page.

Include:

- affected version / commit
- platform and OS
- a synthetic reproduction, if possible
- whether a real session or credential was exposed

## Threat model

`unremember` is a local, offline-by-default tool. It edits files the user already owns and can already read.

It does **not** protect against:

- server-side retention, telemetry, cloud sessions, or backups you do not control
- secrets already committed to git, written into project files, or copied to another machine
- a running agent that has already loaded the old context into memory
- a malicious local process with read access to your home directory
- semantic paraphrases that do not contain the literal target

The backup directory and the pending skill request contain the original text by design. Use `unremember purge-backups` after verifying, and protect `~/.unremember` like any other sensitive local data.

## Scope

The current release supports Claude Code transcripts and dsh session v4. Unknown formats are refused rather than guessed at.

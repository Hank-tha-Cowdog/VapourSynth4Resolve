# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

1. Use GitHub's private reporting: **Security tab → Report a vulnerability**
   (private security advisory) on this repository.
2. Include: affected version/commit, macOS + Resolve versions, reproduction
   steps, and what you expected vs observed. Redact logs — never paste API
   keys, tokens, private media paths or customer material.
3. You'll get an acknowledgement on the advisory; fixes ship with a note in
   the release notes when appropriate.

## Design notes for reviewers

The current security posture (what is enforced, and why) is documented in
[`docs/security-posture-2026-11-11.md`](docs/security-posture-2026-11-11.md).
Notable invariants you can test:

- Chain steps execute only when approved **and** their stored approval
  byte-matches the freshly composed script (approval binds executable
  content; fail closed).
- Execution-capable IPC channels serve only the companion's own renderer.
- Private writes migrate to 0600 or refuse symlinks/hardlinks/foreign owners.
- Keyed cloud providers refuse plaintext non-loopback HTTP without an
  explicit opt-in.

Reports that break any of those invariants are especially valuable.

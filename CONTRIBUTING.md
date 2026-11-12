# Contributing

Thanks for helping improve VapourSynth for Resolve. The project is a v2 alpha;
small, well-tested changes are easiest to review.

## Getting set up

- macOS 26+ on Apple Silicon is the supported build target.
- Build instructions: [`docs/building-macos.md`](docs/building-macos.md)
  (plugin) and [`docs/packaging.md`](docs/packaging.md) (self-contained
  bundle + companion DMG).
- Quick check of what a change affects:
  - `companion-app/` — Electron main/preload + React renderer (MIT).
  - `common/` + `platform/macos/` — native chain composer and OFX plugin (GPLv3).

## Testing expectations

- Behavior changes get a regression test. Prefer exercising the real code path
  over mocks where practical (several suites deliberately load the real
  modules).
- The companion test files live in `companion-app/electron/__test_*.js` (run
  with `node --test`); native suites build via CMake (`tests/`).
- The JS draft emitter and the native composer are held to **byte parity** by
  a shared fixture (`tests/fixtures/qtgmc_parity.json`) consumed by both a
  native and a JS test. If you touch either emitter, both tests must stay
  green.
- Approval and security contracts in `docs/security-posture-2026-11-11.md`
  are deliberate; changes there need an explicit rationale and updated tests.

## Licensing

- Native plugin + `common/`: GPLv3 (see root `LICENSE`).
- `companion-app/`: MIT (see `companion-app/LICENSE`).
- Don't relabel the tree under a permissive license; third-party components
  keep their own terms — see `docs/notices-index.md` and `docs/SBOM.md`.

## Reporting

- Bugs and feature requests: GitHub issues (templates provided).
- Security problems: do **not** open a public issue — see
  [`SECURITY.md`](SECURITY.md).
- Never include secrets, API keys, private footage or project exports in
  reports. Redact logs before pasting.

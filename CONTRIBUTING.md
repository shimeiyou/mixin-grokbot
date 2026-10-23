# Contributing

Thanks for helping! 

1. Fork, create a branch, keep changes focused.
2. `npm ci && OFFLINE=1 ./run-tests.sh` must pass. Add a test for every behaviour change (tests use fakes; no real keystore or network).
3. Never commit secrets: keystores, `.env` files, `allowlist.json`, logs, `queue/`, `context/`, `run/`. Run `gitleaks detect` before opening a PR if you can.
4. Do not rename existing `MIXIN_*` environment variables; add new ones with safe defaults (off unless clearly harmless).
5. Update `README.md` **and** `README.zh-CN.md` (they must stay identical in content) and `CHANGELOG.md`.
6. Open a pull request describing the what and why.

Security issues: see [SECURITY.md](SECURITY.md) — do not open a public issue.

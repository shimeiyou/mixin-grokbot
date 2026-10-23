# Security Policy

## Reporting a vulnerability
Please report vulnerabilities **privately** via GitHub's "Report a vulnerability" (Security Advisories) on this repository. Do not open a public issue. We aim to acknowledge within 7 days.

## Handling secrets
- **Never commit your bot keystore** (`MIXIN_KEYSTORE_JSON`: `session_private_key`, etc.), webhook keys, env files or `allowlist.json`.
- Keep the env file at mode `0600` in a `0700` directory (`deploy/save-env.sh` does this).
- The gateway and scripts never print secret values; please keep it that way in contributions and bug reports (redact logs).
- The gateway never needs a spend key; do not put one in the keystore you give it.
- If a keystore leaks: revoke/rotate the bot session in the Mixin developer dashboard immediately.

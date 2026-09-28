# AGENTS.md

## Source of truth
- This GitHub repository is the only source of truth for S-UI Fleet Manager source code.
- Do not develop by editing files directly on the test or production server.
- Do not upload ad-hoc binaries to the server outside the repository release/deploy flow.

## Branch workflow
- `main`: stable, user-accepted releases only.
- `staging`: integration branch used by the test server.
- Do new work on a short-lived `feature/*`, `fix/*`, or `chore/*` branch based on `staging`.
- Open a PR into `staging` after local tests pass.
- Do not merge `staging` into `main` until the user has verified the deployed staging build.

## Required validation
Before proposing a PR:
- `go test ./...`
- `node --check web/app.js`
- `node --check web/templates.js`
- `node --test ui_form_test.cjs`
- `node --test batch_config_form_test.cjs`

Keep the repository buildable after every commit. Fix ordinary compile, lint, or test failures without asking the user to diagnose them.

## Deployment
- Pushes to `staging` are built by GitHub Actions for Linux amd64.
- The test server downloads the verified `staging-latest` release asset.
- Server runtime state is outside Git:
  - binary: `/opt/sui-fleet-manager/fleet-manager`
  - environment: `/etc/sui-fleet-manager.env`
  - database/backups: `/var/lib/sui-fleet-manager`
- Never overwrite or commit runtime data.

## Secrets and production identifiers
Never commit:
- `.env` or real environment values
- SQLite databases or backups
- API tokens, passwords, private keys, authorization headers, or SSH keys
- real production-only IP addresses or hostnames unless the user explicitly asks to publish them

Use `.env.example`, example domains, and documentation/test IP ranges instead.

## Change discipline
- Inspect existing code before changing architecture.
- Preserve working behavior unless the task explicitly requires a change.
- Prefer small, reviewable commits grouped by purpose.
- Do not perform unrelated refactors during feature or bug-fix work.
- High-risk configuration writes must keep preview, backup, verification, and audit behavior intact.

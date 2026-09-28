# S-UI Fleet Manager Roadmap

This file is the durable implementation plan for the fleet controller. It tracks the original v0.1 milestones and keeps future agent work focused on one milestone at a time.

## Branch policy

- `main`: user-accepted stable state.
- `staging`: current test-server candidate.
- `feature/*`, `fix/*`, `chore/*`: short-lived development branches based on `staging`.
- A milestone is promoted from `staging` to `main` only after the deployed build is tested by the user.

## v0.1 milestones

### 1. Repository audit and architecture baseline — complete

The source of truth is GitHub. Runtime state is outside the repository. GitHub Actions validates and builds Linux amd64 staging releases, and the server deploys the verified release with rollback protection.

### 2. Fleet/server management — complete

Server registration supports name, region, S-UI URL, encrypted API Token, and optional Komari UUID association.

### 3. S-UI API adapter and safety rules — complete for v0.1

S-UI calls use the documented `/apiv2` API, bounded response sizes, request timeouts, redirect isolation, encrypted Tokens, and verification after writes.

Future refactoring may move the adapter into its own package, but that is not required before feature completion.

### 4. Fleet dashboard — complete for v0.1

The dashboard combines S-UI status with Komari health and monitoring data, grouped by region, with server detail views.

### 5. Inbound, outbound, client, route, and full configuration editing — complete for v0.1

The controller supports single-server editing and object-first batch forms across S-UI configuration categories. Mutations use preview, stale-state checks, backup-before-write, and post-write verification.

### 6. Persistent batch jobs — complete for v0.1

Multi-server execution runs as bounded-concurrency background jobs stored in SQLite. Job progress and per-server results survive browser refreshes. Unfinished jobs are marked interrupted after a controller restart. Single-server writes remain synchronous for compatibility.

### 7. Snapshots, diff history, and rollback — next

Current preview diffs and S-UI database backups protect writes, but there is no controller-level snapshot history or guided rollback workflow yet.

Planned work:
- record configuration snapshots before and after successful writes;
- show object-level and field-level diffs by server;
- attach snapshots to job/audit entries;
- provide a guarded rollback preview that restores a selected prior snapshot through the normal backup/verify path;
- never auto-rollback remote S-UI configuration without an explicit user action.

### 8. Reusable templates — complete for v0.1

Rule-set, outbound, sing-box subscription, and Mihomo template workflows exist and use the same preview/backup/verification model.

### 9. Komari integration — complete for v0.1

The controller reads the existing modified Komari deployment and links S-UI servers to Komari node UUIDs without installing a second monitoring agent.

### 10. Audit trail — partial

Per-server mutation outcomes are recorded. Batch jobs add durable execution grouping.

Remaining work should link audit rows to job IDs and snapshots, expose filters, and retain enough structured detail for rollback investigation without storing secrets.

### 11. Security hardening — baseline complete, ongoing

Current controls include encrypted stored secrets, Basic Auth, same-origin checks for writes, response-size limits, TLS requirements for public listeners, no-store responses, CSP, and hardened systemd settings.

Security review remains mandatory for every new write path.

### 12. Reliability and operational hardening — partial

Completed: timeouts, bounded preview concurrency, persistent batch execution, verified staging releases, server-side deployment backup, service health checks, and deployment rollback.

Remaining work includes retention policies, database maintenance, clearer degraded-state reporting, and recovery tests.

### 13. Automated tests — active and required

Go tests and browser-logic Node tests run on every PR into `staging`. New milestones must add regression coverage before merge.

### 14. Packaging and deployment — complete for current test environment

Docker files remain available. The test server uses the GitHub Actions `staging-latest` Linux amd64 release and `deploy/deploy-staging-release.sh`.

### 15. Final v0.1 mock acceptance — pending

Before v0.1 is promoted to stable, run a complete mocked acceptance pass covering:
- mixed healthy/unhealthy S-UI panels;
- stale previews;
- partial batch failures;
- restart during a job;
- template application;
- backup and snapshot recovery;
- Komari unavailable/degraded behavior;
- authentication and secret-redaction checks.

## v0.2 reserved scope

Keep these out of v0.1 unless explicitly promoted:
- SSH bootstrap/install of S-UI on new hosts;
- certificate issuance and renewal orchestration beyond the current local deployment helper;
- alert delivery integrations;
- automated discovery of arbitrary servers;
- multi-user/RBAC control plane.

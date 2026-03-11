# Pilot Launch Runbook

This runbook defines the exact operator flow for launching and recovering pilots.

## Objective
- Launch a paid pilot safely.
- Ensure every launch is traceable.
- Provide a deterministic retry/fix path.

## Preconditions
1. At least one connector is enabled and healthy.
2. Renewal backlog is zero.
3. Latest snapshot manifest is valid.
4. Trust score meets the target threshold.
5. Procurement readiness is true (unless explicitly waived for internal dry-runs).

## Standard Launch Flow
1. Readiness check:
   - `GET /v1/connectors/pilot-readiness?requiredTrustScore=80&requireProcurementReady=true`
2. If `ready=false`:
   - Stop launch.
   - Use `blockers` list to create remediation tasks.
3. Dry-run launch:
   - `POST /v1/connectors/launch-pilot` with `{ "dryRun": true }`
4. Live launch:
   - `POST /v1/connectors/launch-pilot` with `{ "dryRun": false }`
5. Capture `launchRunId` from response.
6. Validate persisted outcome:
   - `GET /v1/connectors/pilot-launches?limit=20`

## Status Model
- `blocked`: readiness gates failed.
- `dry_run`: readiness passed, no packet generated.
- `ready`: transient pre-delivery state recorded.
- `launched`: sales packet generated and delivery state recorded.
- `delivery_failed`: readiness passed but packet/delivery step failed.

## Recovery Flow
1. Query recent outcomes:
   - `GET /v1/connectors/pilot-launches?status=delivery_failed&limit=50`
2. For each failed run:
   - Inspect `error`, `readiness`, `delivery`.
   - If snapshot/trust issue: regenerate + verify snapshot, re-run readiness.
   - If connector health issue: repair connector and re-check status.
   - If transient API issue: retry launch.
3. Re-run launch:
   - `POST /v1/connectors/launch-pilot`

## Incident Triggers
- 2+ `delivery_failed` runs in 30 minutes.
- Readiness oscillates between pass/fail due to renewal backlog.
- Connector enters `unhealthy` during active pilot launch window.

## Escalation
1. Open incident ticket with:
   - affected customer
   - `launchRunId`
   - first failure timestamp
   - latest error
2. Apply containment:
   - pause launch attempts for impacted workspace.
3. Execute rollback/retry process:
   - follow `operations/rollback-retry.md`.
4. Communicate every 30 minutes until stabilized.

## Evidence to Keep
- Readiness payload used for launch.
- Launch response with `launchRunId`.
- Post-launch history entry from `/v1/connectors/pilot-launches`.
- Any manual overrides and approval notes.

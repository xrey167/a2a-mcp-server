# Launch Co Pilot One-Pager (Filled)

## Quote-to-Order Command Center

**Prepared for:** Launch Co Leadership (Ops, Sales, Finance)  
**Prepared on:** 2026-03-11  
**Session ID:** `180f25f1-6fb3-4db0-81b8-b7bfc4f3c5f9`  
**Onboarding ID:** `97b01f33-1dbe-4e1e-84c0-c776c68247d9`  
**Launch Mode:** `production`  
**Status:** `launched`

## Executive Summary

Launch Co successfully launched Quote-to-Order in production mode across Odoo, Business Central, and Dynamics.  
The first live cycle shows measurable throughput signal and manual-effort reduction, with controlled risk overrides documented in audit trail.

## Measured Outcomes (Baseline vs Current)

| KPI | Baseline | Current | Delta |
|---|---:|---:|---:|
| Completed Runs | 0 | 1 | +1 |
| Failure Rate | 0% | 0% | 0 pp |
| Manual Steps Removed | 0 | 4 | +4 |
| Time Saved | 0.0 h | 1.6 h | +1.6 h |
| Estimated Value | EUR 0 | EUR 136 | +EUR 136 |

## Executive KPI Snapshot (Current)

| KPI | Current Value |
|---|---:|
| Quote->Order Conversion Rate | 100% |
| Median Approval Time | 0 minutes |
| Revenue-at-Risk | EUR 0 |
| Time Saved | 1.6 hours |
| Manual Steps Removed | 4 |
| Estimated Value | EUR 136 |

## Ops Reliability Snapshot (Current)

| KPI | Current Value |
|---|---:|
| Odoo quote sync runs | 1 total, 0 failed (0% failure) |
| Dynamics lead sync runs | 1 total, 1 failed (100% failure) |
| Retries | 0 |
| Dead-letter events | 1 |
| Replays | 0 |
| Incident MTTR | 0 minutes |

## Trust and Control Evidence

1. Full launch traceability is present (session, steps, gates, overrides, timestamps).
2. Critical gates were green at launch (`workspace_isolation`, `required_connectors`, `dry_run_success`).
3. Non-critical risk gates were overridden with approval and reason (audit captured).

## Open Risks (Known, Controlled)

1. Dynamics connector currently marked `unhealthy` (`forced connector degradation`).
2. Mapping drift review step is still blocked with `90` drift items.
3. SLA warning is active: completed runs (`1`) below minimum target (`3`).

## 14-Day Stabilization Plan (Required Before Expansion)

1. Recover Dynamics health to `healthy` and close/replay dead-letter path.
2. Resolve mapping drift backlog (start with high-impact fields) and remove override dependency.
3. Execute at least 3 completed runs to clear SLA minimum and validate repeatability.

## Commercial Recommendation

Proceed with the managed 6-week pilot package:

- Managed onboarding
- Managed cloud runtime
- Weekly optimization and KPI review
- Priority support

Commercial frame:

- Monthly fee: EUR 1,500-EUR 3,000
- Setup fee: as agreed (waivable on annual commitment)
- Expansion trigger: only after KPI and reliability thresholds are met

## Decision Request

Approve continuation of the paid pilot under the 14-day stabilization gate, then move to expansion review once:

1. Dynamics is healthy
2. Mapping drift is reduced to accepted level
3. Minimum completed-run SLA is met

# Incident Response Playbook

## Severity Levels
- P1: Customer-blocking outage or data isolation breach risk
- P2: Significant workflow degradation with workaround
- P3: Minor degradation without customer-blocking impact

## Response Flow
1. Confirm scope (tenant/workspace, affected workflows, first-failure timestamp).
2. Contain impact (disable failing template, pause failing webhook path).
3. Stabilize (retry failed runs, route around unhealthy worker, invalidate bad cache entries).
4. Recover (resume normal flow and verify KPI stability).
5. Communicate (customer update with root-cause status and ETA).
6. Record postmortem and corrective actions.

## Required Artifacts
- Incident timeline
- Affected run IDs
- Root cause
- Corrective action owner and deadline

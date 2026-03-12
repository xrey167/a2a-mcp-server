# SLO and SLA Baseline (Pilot)

## SLO Baseline
- Workflow run success rate: >= 97% (rolling 30 days)
- P95 workflow orchestration latency (control-plane overhead): <= 2.5s
- Availability of orchestrator API endpoints: >= 99.5% monthly

## SLA Baseline (Pilot Cohort)
- Incident acknowledgement: <= 1 hour (business hours)
- Incident updates: every 4 hours for P1/P2 incidents
- Target recovery for P1: <= 8 hours
- Post-incident report: within 2 business days

## Evidence Sources
- `a2a://metrics`
- `a2a://audit`
- `a2a://traces`
- `a2a://agency-roi`

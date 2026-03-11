# Customer Onboarding Process (Ready-to-Ship)

## Promise
Go from signed pilot to first stable live workflow in 10 business days, with measurable KPI baseline and launch history.

## ICP Fit (Entry Gate)
- SMB/mid-market agency or consultancy.
- Has recurring client-delivery process (reporting, approval, handoff).
- Uses at least one supported system (`odoo`, `business-central`, `dynamics`).
- Agrees pilot KPI baseline and success criteria before build starts.

## Roles
- Customer Ops Lead: process owner, approves workflow behavior.
- Customer Admin: credentials/access and security approvals.
- Your Onboarding Lead: project owner, weekly steering.
- Your Solutions Engineer: connector + workflow setup.

## Phase 1: Kickoff and Qualification (Day 0-1)
1. Confirm business outcome:
   - target process
   - target SLA
   - current pain points
2. Confirm technical feasibility:
   - connector availability
   - API permissions
   - data mapping complexity
3. Define baseline KPIs:
   - cycle time
   - manual steps
   - failure rate
   - runs/week
4. Lock pilot scope:
   - exactly one workflow for go-live
   - optional second workflow as stretch goal

Exit criterion:
- Signed kickoff checklist and baseline KPI snapshot.

## Phase 2: Environment and Security Setup (Day 1-3)
1. Create workspace and assign roles.
2. Configure connector auth:
   - `POST /v1/connectors/{odoo|business-central|dynamics}/connect`
3. Validate connector health:
   - `GET /v1/connectors/status`
   - `GET /v1/connectors/kpis`
4. Validate renewal and trust layer:
   - `POST /v1/connectors/renew-due` (`dryRun`)
   - `GET /v1/connectors/pilot-readiness`

Exit criterion:
- At least one connector healthy, readiness blockers known or cleared.

## Phase 3: Workflow Setup and Dry Run (Day 3-6)
1. Select template:
   - reporting, approval, or handoff
2. Customize template with customer data mappings.
3. Execute dry run and inspect traceability:
   - workflow run IDs
   - approvals
   - retry behavior
4. Fix failures and rerun until stable.

Exit criterion:
- Workflow dry run succeeds twice consecutively with expected output.

## Phase 4: Pilot Launch and Monitoring (Day 6-10)
1. Final readiness check:
   - `GET /v1/connectors/pilot-readiness?requiredTrustScore=80`
2. Launch:
   - `POST /v1/connectors/launch-pilot`
3. Validate launch history:
   - `GET /v1/connectors/pilot-launches`
4. Weekly optimization loop:
   - remove manual steps
   - reduce failure/retry noise
   - tighten SLA

Exit criterion:
- First production run completed and documented in launch history.

## Weekly Cadence (During Pilot)
- Weekly 30-min Ops Review:
  - KPI deltas
  - blocker review
  - workflow tuning actions
- Weekly Exec Summary:
  - ROI signal
  - incidents and mitigations
  - expansion recommendation

## Definition of Done (Pilot)
1. Non-technical ops lead can trigger and supervise one template workflow.
2. Every run is traceable (who/what/when/result + retry path).
3. No cross-client data leakage in permissions model.
4. KPI improvement shown versus baseline in at least one primary metric.

## Expansion Path
- Week 3-4: add second workflow in same customer account.
- Post-pilot: move to recurring monthly subscription (platform + module fee).

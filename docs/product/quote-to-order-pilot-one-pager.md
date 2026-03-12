# Quote-to-Order Pilot One-Pager

Use this page to close paid pilots with SMB/mid-market buyers.
It is optimized for Sales/Ops/CFO stakeholders and keeps the decision simple.

## 1) Copy/Paste Closing Template

### [Customer Name]: Revenue Throughput + Risk Control in 6 Weeks

**Prepared for:** [Decision Maker Name, Title]  
**Prepared by:** [Your Name]  
**Date:** [YYYY-MM-DD]  
**Pilot Window:** 6 weeks  
**Product:** Quote-to-Order Command Center (Odoo + Business Central + Dynamics)

### Why this matters now

[Customer Name] wants faster quote-to-order throughput without adding headcount or risk.  
Today, delays in approvals, stalled conversions, and sync failures create revenue drag and manual rework.

### What we will change in 6 weeks

1. Connect Odoo, Business Central, and Dynamics into one command center.
2. Automate quote approval and conversion tracking with SLA guardrails.
3. Run end-to-end traceability (who/what/when/result) with retry/fix path.
4. Establish baseline-vs-current KPI tracking from ERP data.

### Success criteria (pilot acceptance)

1. Non-technical ops lead runs quote-to-order flow without engineering help.
2. Every run has full traceability and replay/fix path.
3. Workspace permissions isolate cross-client access.
4. Measurable KPI delta vs baseline is shown.

### Executive KPI scorecard (baseline vs current)

| KPI | Baseline | Current | Delta | Business meaning |
|---|---:|---:|---:|---|
| Quote->Order Conversion Rate | [x]% | [y]% | [+/-z] pp | Revenue throughput |
| Median Approval Time | [x h] | [y h] | [-z%] | Faster cycle time |
| Revenue-at-Risk | [EUR x] | [EUR y] | [-EUR z] | Less pipeline leakage |
| Time Saved | [x h/week] | [y h/week] | [+z h] | Capacity recovered |
| Manual Steps Removed | [x] | [y] | [-z] | Lower process cost |
| Estimated Value | [EUR x/mo] | [EUR y/mo] | [+EUR z] | ROI anchor |
| Time-to-First-Order-Conversion | [x days] | [y days] | [-z days] | Faster time-to-value |
| Value Recovered from Stalled Quotes | [EUR x] | [EUR y] | [+EUR z] | Revenue recovered |
| Breach Cost Avoided | [EUR x] | [EUR y] | [+EUR z] | Risk/cost reduction |

### Ops reliability scorecard

| KPI | Current | Target |
|---|---:|---:|
| Sync Throughput (runs/day) | [x] | [target] |
| Failure Rate (%) | [x]% | [target]% |
| Retry Success Rate (%) | [x]% | [target]% |
| DLQ Replay Resolution (%) | [x]% | [target]% |
| SLA Breaches/week | [x] | [target] |
| Incident MTTR | [x min] | [target min] |

### Commercial offer

- **Package:** Managed onboarding + managed cloud + weekly optimization
- **Monthly fee:** EUR 1,500-EUR 3,000
- **Setup fee:** [EUR x] (waived on annual commitment)
- **Pilot decision gate:** expand only after KPI improvement proof

### Investment logic (simple)

- **Monthly investment:** [EUR x]
- **Measured monthly value:** [EUR y]
- **Net monthly impact:** [EUR y - x]
- **ROI multiple:** [y / x]
- **Payback period:** [investment / monthly value] months

### Recommended decision

Approve the 6-week pilot for [Customer Name] now.  
Target outcome: first measurable quote-to-order KPI uplift within 30 days.

### Next step

Book a 45-minute pilot kickoff with Ops + Sales + Finance on [date].

---

## 2) Draft for Current Launch

This draft is prefilled from the current wizard state and can be sent after KPI values are pasted.

### Launch Co: Revenue Throughput + Risk Control in 6 Weeks

**Customer:** Launch Co  
**Wizard Session:** `180f25f1-6fb3-4db0-81b8-b7bfc4f3c5f9`  
**Launch Status:** `launched`  
**Product:** Quote-to-Order Command Center

### Current proof points

1. Quote-to-order wizard session reached launch state.
2. Session passed launch readiness gates (`canLaunchProduction=true`).
3. Three-ERP command-center flow is enabled in the onboarding wizard.

### Fill now before external send

1. Paste Executive KPI values from `GET /v1/wizard/sessions/:id/report`.
2. Paste Ops reliability KPIs from the same report payload.
3. Finalize investment row with agreed setup + monthly fee.
4. Add named kickoff date and decision owner.

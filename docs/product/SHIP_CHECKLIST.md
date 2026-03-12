# Ready-to-Ship Checklist (ERP Expansion)

Use this checklist before every release candidate.

## 1) Product Scope Freeze
- [ ] Wave scope is explicit (`quote-to-order`, `lead-to-cash`, or `collections`).
- [ ] Connector scope is explicit (`odoo`, `business-central`, `dynamics`).
- [ ] Odoo qualification rule is enforced (API-capable/custom plan only).

## 2) Reliability and Security Gates
- [ ] Connector health baseline is green (`GET /v1/connectors/status`).
- [ ] Renewal backlog is zero (`POST /v1/connectors/renew-due` dry run + `GET /v1/connectors/renewals`).
- [ ] Snapshot manifest verifies (`POST /v1/connectors/renewals/verify`).
- [ ] Pilot readiness passes target threshold (`GET /v1/connectors/pilot-readiness`).
- [ ] Workspace isolation and RBAC checks are validated in staging.

## 3) Commercial Readiness
- [ ] Sales packet renders correctly (`GET /v1/connectors/sales-packet?format=email`).
- [ ] Pilot success criteria are documented per customer (time saved, failure rate, manual steps removed).
- [ ] Price packaging is clear (platform fee + module fee + onboarding fee/waiver).
- [ ] Pilot proposal, one-pager, and ROI calculator are up to date.

## 4) Release Validation
- [ ] Tests pass:
  - [ ] `bun test src/__tests__/erp-platform.test.ts src/__tests__/config-timeouts.test.ts src/__tests__/skill-tier.test.ts src/__tests__/auth.test.ts`
- [ ] Build passes:
  - [ ] `bun build src/server.ts --target bun`
- [ ] API smoke checks pass:
  - [ ] `GET /v1/connectors/pilot-readiness`
  - [ ] `POST /v1/connectors/launch-pilot` (dry run)
  - [ ] `GET /v1/connectors/pilot-launches`

## 5) Go-Live Operations
- [ ] On-call owner and backup owner are assigned.
- [ ] Incident and rollback runbooks are linked in the release ticket.
- [ ] Monitoring dashboards and alert thresholds are enabled.
- [ ] Customer communication template is prepared (launch + incident update format).

## 6) Exit Criteria (Ship)
- [ ] No P1/P2 open incidents.
- [ ] Pilot launch path tested end-to-end in production-like environment.
- [ ] First 24h post-release check scheduled (connector health, run outcomes, retries, blockers).

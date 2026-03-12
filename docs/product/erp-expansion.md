# ERP Expansion Plan (Odoo + Business Central + Dynamics)

## Product Portfolio (Wave Launch)

1. Quote-to-Order Accelerator (weeks 1-8)
2. Lead-to-Cash Sync Hub (weeks 9-16)
3. Collections Copilot (weeks 17-24)

## Connector Contract

Every connector implements:

- `connect`
- `ingest_events`
- `sync_record`
- `sync_activity`
- `health_status`

Two-way sync is the default (ingest + writeback).

## Reliability Guarantees

- Idempotency keys on sync operations
- Exponential backoff with Retry-After support
- Dead-letter capture for non-recoverable sync failures
- Token expiry warnings and connector health status
- Business Central subscription renewal endpoint (`/v1/connectors/business-central/renew`)

## Odoo Qualification Rule

Odoo onboarding is restricted to API-capable Custom plan deployments.

## Commercial Packaging

- Base platform subscription
- Per-product module add-ons
- Connector onboarding fee (waivable for annual agreements)

## GTM Channels

- Direct managed SaaS sales from day 1
- AppSource submission and listing motion in parallel

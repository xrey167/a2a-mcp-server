import { describe, expect, test, beforeEach } from "bun:test";
import {
  buildOnboardingReport,
  buildConnectorRenewalSnapshot,
  captureOnboardingSnapshot,
  connectConnector,
  createOnboardingSession,
  createPilotLaunchRun,
  escalateWorkflowSlaBreaches,
  exportConnectorRenewalsCsv,
  getCommercialKpis,
  getConnectorKpis,
  getConnectorStatus,
  getProductKpis,
  getWorkflowSlaStatus,
  listOnboardingSessions,
  listConnectorRenewals,
  listMasterDataMappings,
  listPilotLaunchRuns,
  listWorkflowSlaIncidents,
  decideQuoteToOrderApproval,
  getExecutiveAnalytics,
  getOpsAnalytics,
  getQuoteToOrderPipeline,
  recordCommercialEvent,
  recordWorkflowRun,
  renewDueConnectors,
  renewBusinessCentralSubscription,
  resetErpPlatformForTests,
  syncMasterDataEntity,
  syncQuoteToOrderOrder,
  syncQuoteToOrderQuote,
  syncConnector,
  updateMasterDataMapping,
  updatePilotLaunchRun,
  updateWorkflowSlaIncidentStatus,
  updateWorkflowRun,
  workflowDefinitionFor,
} from "../erp-platform.js";

describe("erp-platform", () => {
  beforeEach(() => {
    resetErpPlatformForTests();
  });

  test("odoo connection requires custom plan", () => {
    expect(() => connectConnector("odoo", {
      authMode: "api-key",
      config: { apiKey: "k" },
      metadata: { odooPlan: "standard" },
    })).toThrow("Custom plan");
  });

  test("connector status shows healthy after connect", () => {
    const status = connectConnector("dynamics", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: { tenantId: "tenant", tokenExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() },
    });

    expect(status.connector).toBe("dynamics");
    expect(status.health).toBe("healthy");
    expect(status.enabled).toBe(true);
    expect(getConnectorStatus("dynamics").tokenStatus).toBe("ok");
  });

  test("sync uses idempotency key and does not duplicate execution", async () => {
    connectConnector("business-central", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: { webhookExpiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() },
    });

    let executions = 0;
    const exec = async () => {
      executions += 1;
      return { ok: true };
    };

    const first = await syncConnector("business-central", {
      direction: "two-way",
      entityType: "quote",
      externalId: "Q-1",
      idempotencyKey: "idem-q1",
      payload: { amount: 100 },
      maxRetries: 2,
    }, exec);

    const second = await syncConnector("business-central", {
      direction: "two-way",
      entityType: "quote",
      externalId: "Q-1",
      idempotencyKey: "idem-q1",
      payload: { amount: 100 },
      maxRetries: 2,
    }, exec);

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(executions).toBe(1);
  });

  test("retryable errors are retried and then succeed", async () => {
    connectConnector("dynamics", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: {},
    });

    let attempts = 0;
    const res = await syncConnector("dynamics", {
      direction: "ingest",
      entityType: "lead",
      payload: { lead: "L-1" },
      maxRetries: 3,
    }, async () => {
      attempts += 1;
      if (attempts < 2) {
        const err = new Error("rate limited") as Error & { statusCode: number; retryAfterMs: number };
        err.statusCode = 429;
        err.retryAfterMs = 1;
        throw err;
      }
      return { ok: true };
    });

    expect(res.status).toBe("success");
    expect(res.attempts).toBe(2);
  });

  test("non-retryable failures end in failed status", async () => {
    connectConnector("odoo", {
      authMode: "api-key",
      config: { apiKey: "k" },
      metadata: { odooPlan: "custom" },
    });

    const result = await syncConnector("odoo", {
      direction: "writeback",
      entityType: "invoice",
      externalId: "INV-7",
      payload: { amount: 42 },
      maxRetries: 0,
    }, async () => {
      throw new Error("bad request");
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("bad request");
    expect(getConnectorStatus("odoo").health).toBe("unhealthy");
  });

  test("workflow definitions are generated per product", () => {
    const quote = workflowDefinitionFor("quote-to-order", { customerName: "Acme" });
    const lead = workflowDefinitionFor("lead-to-cash", { customerName: "Beta" });
    const collections = workflowDefinitionFor("collections", { customerName: "Gamma" });

    expect(quote.steps.length).toBeGreaterThan(0);
    expect(lead.name).toContain("Lead");
    expect(collections.description).toContain("Overdue");
  });

  test("product KPIs return shaped metrics", async () => {
    connectConnector("dynamics", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: {},
    });

    await syncConnector("dynamics", {
      direction: "ingest",
      entityType: "lead",
      externalId: "L-7",
      payload: { value: 1 },
      maxRetries: 1,
    }, async () => ({ ok: true }));

    const kpis = getProductKpis("lead-to-cash");
    expect(kpis).toHaveProperty("workflowRuns");
    expect(kpis).toHaveProperty("sync");
    expect(kpis).toHaveProperty("revenueSignal");
  });

  test("native dynamics adapter calls configured endpoint", async () => {
    connectConnector("dynamics", {
      authMode: "oauth",
      config: {
        baseUrl: "https://example.crm.dynamics.com",
        accessToken: "tok",
      },
      metadata: {},
    });

    const originalFetch = globalThis.fetch;
    let calledUrl = "";
    let calledMethod = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calledUrl = String(input);
      calledMethod = String(init?.method ?? "GET");
      return new Response(JSON.stringify({ id: "lead-1", ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const result = await syncConnector("dynamics", {
        direction: "writeback",
        entityType: "lead",
        payload: { subject: "New lead" },
        maxRetries: 1,
      });

      expect(result.status).toBe("success");
      expect(calledMethod).toBe("POST");
      expect(calledUrl).toContain("/api/data/v9.2/leads");
      expect(result.result).toHaveProperty("mode", "native");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("business central renewal updates renewal status", async () => {
    connectConnector("business-central", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: { webhookExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
    });

    const before = getConnectorStatus("business-central");
    expect(before.renewalDue).toBe(true);

    const after = await renewBusinessCentralSubscription();
    expect(after.renewalDue).toBe(false);
  });

  test("business central adapter retries on 429 with retry-after", async () => {
    connectConnector("business-central", {
      authMode: "oauth",
      config: { baseUrl: "https://api.businesscentral.dynamics.com", accessToken: "tok" },
      metadata: {},
    });

    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const result = await syncConnector("business-central", {
        direction: "two-way",
        entityType: "order",
        payload: { orderNo: "SO-1" },
        maxRetries: 2,
      });
      expect(result.status).toBe("success");
      expect(result.attempts).toBe(2);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("renew-due dry run reports backlog without changes", async () => {
    connectConnector("business-central", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: { webhookExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
    });

    const result = await renewDueConnectors({ dryRun: true });
    expect(result.due).toBe(1);
    expect(result.renewed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.dryRun).toBe(true);
  });

  test("renew-due performs renewal when due", async () => {
    connectConnector("business-central", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: { webhookExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
    });

    const result = await renewDueConnectors();
    expect(result.due).toBe(1);
    expect(result.renewed).toBe(1);
    expect(result.failed).toBe(0);
    expect(getConnectorStatus("business-central").renewalDue).toBe(false);
  });

  test("connector kpis include renewal success and failure rates", async () => {
    connectConnector("business-central", {
      authMode: "oauth",
      config: {
        baseUrl: "https://api.businesscentral.dynamics.com",
        accessToken: "tok",
        notificationUrl: "https://hooks.example.com/bc",
        resource: "companies(11111111-1111-1111-1111-111111111111)/salesOrders",
      },
      metadata: { webhookExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("fail", { status: 500 })) as typeof fetch;
    try {
      await expect(renewBusinessCentralSubscription()).rejects.toThrow("HTTP 500");
    } finally {
      globalThis.fetch = originalFetch;
    }

    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "sub-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    try {
      const renewed = await renewBusinessCentralSubscription();
      expect(renewed.health).toBe("healthy");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const kpis = getConnectorKpis();
    expect((kpis.renewals as { totalRuns: number }).totalRuns).toBe(2);
    expect((kpis.renewals as { failedRuns: number }).failedRuns).toBe(1);
    expect((kpis.renewals as { successfulRuns: number }).successfulRuns).toBe(1);
    expect((kpis.renewals as { successRatePct: number }).successRatePct).toBe(50);
  });

  test("renewal feed supports filtering and pagination cursor", async () => {
    connectConnector("business-central", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: { webhookExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
    });

    await renewBusinessCentralSubscription();
    await renewBusinessCentralSubscription();

    const page1 = listConnectorRenewals({ connector: "business-central", status: "success", limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0].connectorType).toBe("business-central");
    expect(page1.items[0].status).toBe("success");
    expect(page1.nextBefore).toBeTruthy();

    const page2 = listConnectorRenewals({
      connector: "business-central",
      status: "success",
      limit: 1,
      before: page1.nextBefore,
    });
    expect(page2.items).toHaveLength(1);
  });

  test("renewal CSV export returns header and rows", async () => {
    connectConnector("business-central", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: { webhookExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
    });

    await renewBusinessCentralSubscription();
    const csv = exportConnectorRenewalsCsv({ connector: "business-central", status: "success", limit: 10 });
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("id,connector_type,status,error,previous_expires_at,renewed_expires_at,created_at");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toContain(",business-central,success,");
  });

  test("renewal snapshot bundles kpis and csv", async () => {
    connectConnector("business-central", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: { webhookExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
    });

    await renewBusinessCentralSubscription();
    const snapshot = buildConnectorRenewalSnapshot({ limit: 100 });
    expect(snapshot.rowCount).toBeGreaterThan(0);
    expect(snapshot.csv.startsWith("id,connector_type,status,error,previous_expires_at,renewed_expires_at,created_at")).toBe(true);
    expect((snapshot.kpis.connectors as { total: number }).total).toBeGreaterThanOrEqual(1);
  });

  test("odoo adapter falls back to simulated mode when base URL missing", async () => {
    connectConnector("odoo", {
      authMode: "api-key",
      config: { apiKey: "secret" },
      metadata: { odooPlan: "custom" },
    });

    const result = await syncConnector("odoo", {
      direction: "ingest",
      entityType: "lead",
      payload: {},
      maxRetries: 1,
    });

    expect(result.status).toBe("success");
    expect(result.result).toHaveProperty("mode", "simulated");
  });

  test("pilot launch runs can be created and listed", () => {
    const firstId = createPilotLaunchRun({
      status: "blocked",
      readiness: { ready: false },
      error: "blocked",
    });
    const secondId = createPilotLaunchRun({
      status: "dry_run",
      readiness: { ready: true },
      delivery: { mode: "dry_run" },
    });

    const feed = listPilotLaunchRuns({ limit: 10 });
    expect(feed.items.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(feed.items.map((item) => item.id));
    expect(ids.has(firstId)).toBe(true);
    expect(ids.has(secondId)).toBe(true);
  });

  test("pilot launch runs can be updated and filtered by status", () => {
    const id = createPilotLaunchRun({
      status: "ready",
      readiness: { ready: true },
    });
    updatePilotLaunchRun(id, {
      status: "launched",
      salesPacket: { format: "email" },
      delivery: { channel: "email", delivered: true },
    });

    const launched = listPilotLaunchRuns({ status: "launched", limit: 10 });
    expect(launched.items.length).toBe(1);
    expect(launched.items[0].id).toBe(id);
    expect(launched.items[0].salesPacket).toHaveProperty("format", "email");
  });

  test("onboarding report captures baseline/current from tracked ERP data", async () => {
    const session = createOnboardingSession({
      customerName: "Acme GmbH",
      product: "lead-to-cash",
      connector: "dynamics",
    });
    const baseline = captureOnboardingSnapshot({
      onboardingId: session.id,
      phase: "baseline",
    });
    expect(baseline.phase).toBe("baseline");

    connectConnector("dynamics", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: {},
    });

    const runId = recordWorkflowRun("lead-to-cash", "running", null, { customerName: "Acme GmbH" });
    updateWorkflowRun(runId, "completed");
    await syncConnector("dynamics", {
      direction: "ingest",
      entityType: "lead",
      externalId: "L-42",
      payload: { source: "web" },
      maxRetries: 1,
    }, async () => ({ ok: true }));

    const report = buildOnboardingReport({
      onboardingId: session.id,
      autoCaptureCurrent: true,
    });

    expect((report.session as { id: string }).id).toBe(session.id);
    expect(report).toHaveProperty("baseline");
    expect(report).toHaveProperty("current");
    expect(report).toHaveProperty("delta");
    const sessions = listOnboardingSessions({ status: "active", limit: 10 });
    expect(sessions.items.length).toBeGreaterThanOrEqual(1);
  });

  test("commercial KPIs track wave funnel targets", () => {
    for (let i = 0; i < 10; i += 1) {
      recordCommercialEvent({
        product: "quote-to-order",
        stage: "qualified_call",
        customerName: `Call-${i + 1}`,
      });
    }
    for (let i = 0; i < 3; i += 1) {
      recordCommercialEvent({
        product: "quote-to-order",
        stage: "proposal_sent",
        customerName: `Proposal-${i + 1}`,
        valueEur: 2500,
      });
    }
    recordCommercialEvent({
      product: "quote-to-order",
      stage: "pilot_signed",
      customerName: "Signed-1",
      valueEur: 3000,
    });

    const kpis = getCommercialKpis({ product: "quote-to-order" });
    const funnel = kpis.funnel as { qualifiedCalls: number; proposalsSent: number; pilotsSigned: number };
    const progress = kpis.progress as { targetReached: boolean };
    expect(funnel.qualifiedCalls).toBe(10);
    expect(funnel.proposalsSent).toBe(3);
    expect(funnel.pilotsSigned).toBe(1);
    expect(progress.targetReached).toBe(true);
  });

  test("workflow SLA status/escalation works across modules", () => {
    const q1 = recordWorkflowRun("quote-to-order", "running", null, {});
    updateWorkflowRun(q1, "failed", "approval timeout");
    const q2 = recordWorkflowRun("quote-to-order", "running", null, {});
    updateWorkflowRun(q2, "failed", "erp sync failed");
    const q3 = recordWorkflowRun("quote-to-order", "running", null, {});
    updateWorkflowRun(q3, "completed");

    const status = getWorkflowSlaStatus({ product: "quote-to-order" });
    const item = (status.items as Array<{ breach: boolean; severity: string }>)[0];
    expect(item.breach).toBe(true);
    expect(item.severity).not.toBe("ok");

    const escalation = escalateWorkflowSlaBreaches({ product: "quote-to-order", minIntervalMinutes: 120 });
    expect((escalation as { escalatedCount: number }).escalatedCount).toBeGreaterThan(0);

    const incidents = listWorkflowSlaIncidents({ product: "quote-to-order", status: "open", limit: 20 });
    expect(incidents.items.length).toBeGreaterThan(0);
  });

  test("quote-to-order state machine supports quote->approval->order->fulfilled flow", () => {
    const q = syncQuoteToOrderQuote("ws-1", {
      connectorType: "dynamics",
      quoteExternalId: "Q-100",
      approvalExternalId: "APR-1",
      amount: 1200,
      state: "submitted",
      approvalDeadlineAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      conversionDeadlineAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      idempotencyKey: "q100-v1",
      payload: { owner: "alice" },
    });
    expect((q as { duplicate: boolean }).duplicate).toBe(false);

    const approval = decideQuoteToOrderApproval("ws-1", "APR-1", {
      decision: "approved",
      idempotencyKey: "q100-approval",
    });
    expect((approval as { record: { state: string } }).record.state).toBe("approved");

    const order = syncQuoteToOrderOrder("ws-1", {
      connectorType: "dynamics",
      quoteExternalId: "Q-100",
      orderExternalId: "SO-100",
      state: "converted_to_order",
      idempotencyKey: "q100-order",
    });
    expect((order as { record: { state: string } }).record.state).toBe("converted_to_order");

    syncQuoteToOrderOrder("ws-1", {
      connectorType: "dynamics",
      quoteExternalId: "Q-100",
      orderExternalId: "SO-100",
      state: "fulfilled",
      idempotencyKey: "q100-fulfilled",
    });
    const pipeline = getQuoteToOrderPipeline("ws-1");
    const metrics = pipeline.metrics as { quoteToOrderConversionRatePct: number; valueRecoveredFromStalledQuotes: number };
    expect(metrics.quoteToOrderConversionRatePct).toBeGreaterThan(0);
    expect(metrics.valueRecoveredFromStalledQuotes).toBeGreaterThanOrEqual(0);
  });

  test("master data sync detects drift and mappings can be updated", () => {
    const syncResult = syncMasterDataEntity("ws-md", "customer", {
      connectorType: "odoo",
      records: [
        {
          externalId: "C-1",
          payload: {
            company_name: "Acme",
            vat_no: "DE123",
          },
        },
      ],
      idempotencyKey: "md-1",
    });
    expect((syncResult as { syncedRecords: number }).syncedRecords).toBe(1);
    expect((syncResult as { driftDetected: boolean }).driftDetected).toBe(true);

    const mappings = listMasterDataMappings({ workspaceId: "ws-md", entity: "customer", connectorType: "odoo" });
    expect(mappings.items.length).toBeGreaterThan(0);
    const first = mappings.items[0];
    const updated = updateMasterDataMapping(first.id, { unifiedField: "customer_name", driftStatus: "ok" });
    expect(updated.mappingVersion).toBeGreaterThan(first.mappingVersion);
  });

  test("incident lifecycle update and dashboards include new metrics", () => {
    syncQuoteToOrderQuote("ws-life", {
      connectorType: "business-central",
      quoteExternalId: "Q-LIFE",
      state: "submitted",
      approvalDeadlineAt: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: "life-q",
    });
    const esc = escalateWorkflowSlaBreaches({ product: "quote-to-order", minIntervalMinutes: 1 });
    const created = (esc.created as Array<{ id: string }>);
    expect(created.length).toBeGreaterThan(0);
    const incident = updateWorkflowSlaIncidentStatus(created[0].id, "resolved");
    expect(incident.status).toBe("resolved");

    const exec = getExecutiveAnalytics({ workspaceId: "ws-life" });
    expect(exec).toHaveProperty("quoteToOrderConversionRatePct");
    const ops = getOpsAnalytics({});
    expect(ops).toHaveProperty("reliability");
    expect(ops).toHaveProperty("sla");
  });
});

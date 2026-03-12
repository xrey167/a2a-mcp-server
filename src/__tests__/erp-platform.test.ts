import { describe, expect, test, beforeEach } from "bun:test";
import {
  buildOnboardingReport,
  buildConnectorRenewalSnapshot,
  captureOnboardingSnapshot,
  createWizardSessionState,
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
  listWizardSessionStates,
  listWorkflowSlaIncidents,
  decideQuoteToOrderApproval,
  getExecutiveAnalytics,
  getForecastQualityAnalytics,
  getQuotePersonalityInsights,
  getQuoteCommunicationAnalytics,
  getQuoteCommunicationThreadSignals,
  getRevenueGraphEntity,
  getRevenueIntelligenceAnalytics,
  getOpsAnalytics,
  getQuoteToOrderPipeline,
  getTrustConsentStatus,
  getWizardSessionReport,
  getWizardSessionState,
  launchWizardSession,
  overrideWizardGate,
  recordWizardConnectorConnection,
  recordCommercialEvent,
  recordWorkflowRun,
  renewDueConnectors,
  renewBusinessCentralSubscription,
  resetErpPlatformForTests,
  runWizardConnectorTest,
  runWizardMasterDataAutoSync,
  runWizardQuoteToOrderDryRun,
  runQuoteFollowupEngine,
  syncMasterDataEntity,
  upsertQuoteMailboxConnection,
  listQuoteMailboxConnections,
  refreshQuoteMailboxConnection,
  disableQuoteMailboxConnection,
  importQuoteMailboxCommunications,
  ingestQuoteCommunication,
  approveQuoteAutopilotProposal,
  createQuoteNextActionRecommendation,
  writebackQuoteFollowupAction,
  writebackQuoteFollowupBatch,
  pullQuoteMailboxCommunications,
  rejectQuoteAutopilotProposal,
  runQuoteDealRescue,
  syncQuoteCommunicationThreads,
  syncRevenueGraphWorkspace,
  runScheduledFollowupWritebacks,
  syncQuoteToOrderOrder,
  syncQuoteToOrderQuote,
  syncConnector,
  updateMasterDataMapping,
  updateQuoteFollowupAction,
  updateTrustConsent,
  updatePilotLaunchRun,
  updateWorkflowSlaIncidentStatus,
  updateWorkflowRun,
  listQuoteFollowupActions,
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

  test("communication ingest classifies sentiment/intents and estimates deal probability", () => {
    syncQuoteToOrderQuote("ws-comm", {
      connectorType: "odoo",
      quoteExternalId: "Q-COMM-1",
      state: "submitted",
      amount: 9000,
      idempotencyKey: "comm-q1",
    });

    const event = ingestQuoteCommunication("ws-comm", "Q-COMM-1", {
      channel: "email",
      direction: "inbound",
      subject: "Budget issue before approval",
      bodyText: "This is too expensive, we need a discount before we can proceed.",
      idempotencyKey: "comm-e1",
    }) as {
      event: {
        sentiment: string;
        followupNeeded: boolean;
        intentTags: string[];
        estimatedDealProbabilityPct: number;
        personalityType?: string;
        personalityConfidence?: number;
      };
    };

    expect(event.event.sentiment).toBe("negative");
    expect(event.event.followupNeeded).toBe(true);
    expect(event.event.intentTags).toContain("pricing_objection");
    expect(event.event.estimatedDealProbabilityPct).toBeLessThan(70);
    expect(event.event.personalityType).toMatch(/^[EI][SN][TF][JP]$/);
    expect(event.event.personalityType?.[2]).toBe("T");
    expect(event.event.personalityConfidence).toBeGreaterThan(0.3);
  });

  test("auto follow-up engine creates prioritized actions and avoids duplicates", () => {
    syncQuoteToOrderQuote("ws-follow", {
      connectorType: "business-central",
      quoteExternalId: "Q-FOLLOW-1",
      state: "submitted",
      amount: 12000,
      idempotencyKey: "follow-q1",
    });
    ingestQuoteCommunication("ws-follow", "Q-FOLLOW-1", {
      channel: "email",
      direction: "inbound",
      subject: "PO approved",
      bodyText: "Go ahead, purchase order approved.",
      idempotencyKey: "follow-e1",
    });

    const now = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    const first = runQuoteFollowupEngine("ws-follow", {
      followupAfterHours: 24,
      now,
      maxActions: 20,
    }) as { createdCount: number; created: Array<{ actionType: string; priority: string }> };
    expect(first.createdCount).toBe(1);
    expect(first.created[0].actionType).toBe("call_followup");
    expect(first.created[0].priority).toBe("critical");

    const second = runQuoteFollowupEngine("ws-follow", {
      followupAfterHours: 24,
      now,
      maxActions: 20,
    }) as { createdCount: number };
    expect(second.createdCount).toBe(0);
  });

  test("communication analytics expose sentiment and deal-probability coverage", () => {
    syncQuoteToOrderQuote("ws-analytics", {
      connectorType: "dynamics",
      quoteExternalId: "Q-AN-1",
      state: "submitted",
      amount: 3000,
      idempotencyKey: "an-q1",
    });
    ingestQuoteCommunication("ws-analytics", "Q-AN-1", {
      channel: "email",
      direction: "inbound",
      subject: "Need contract review",
      bodyText: "Legal review required before approval.",
      idempotencyKey: "an-e1",
    });
    ingestQuoteCommunication("ws-analytics", "Q-AN-1", {
      channel: "email",
      direction: "outbound",
      subject: "Re: contract review",
      bodyText: "Sharing contract details and next steps.",
      idempotencyKey: "an-e2",
    });

    const run = runQuoteFollowupEngine("ws-analytics", {
      followupAfterHours: 1,
      now: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    }) as { created: Array<{ id: string }> };
    expect(run.created.length).toBeGreaterThan(0);
    const actionId = run.created[0].id;

    const listed = listQuoteFollowupActions("ws-analytics", { status: "open", limit: 10 });
    expect(listed.items.length).toBeGreaterThan(0);

    const updated = updateQuoteFollowupAction("ws-analytics", actionId, {
      status: "done",
      note: "Replied and aligned",
    }) as { status: string };
    expect(updated.status).toBe("done");

    const analytics = getQuoteCommunicationAnalytics("ws-analytics", { stagnationHours: 1 }) as {
      communication: { totalEvents: number; sentiment: { negative: number } };
      dealProbability: { averagePct: number; scoringModel: string };
      followups: { byStatus: { done: number } };
      personality: {
        model: string;
        sampledQuotes: number;
        dominantType: string | null;
        distribution: Array<{ type: string; count: number }>;
      };
    };
    expect(analytics.communication.totalEvents).toBe(2);
    expect(analytics.communication.sentiment.negative).toBeGreaterThanOrEqual(1);
    expect(analytics.dealProbability.averagePct).toBeGreaterThanOrEqual(0);
    expect(analytics.dealProbability.scoringModel).toBe("heuristic+workspace_calibration_v1");
    expect(analytics.followups.byStatus.done).toBe(1);
    expect(analytics.personality.model).toBe("heuristic_mbti_v1");
    expect(analytics.personality.sampledQuotes).toBeGreaterThanOrEqual(1);
    expect(analytics.personality.distribution.length).toBeGreaterThanOrEqual(1);
  });

  test("personality insights expose dominant type and playbook", () => {
    syncQuoteToOrderQuote("ws-persona", {
      connectorType: "odoo",
      quoteExternalId: "Q-PER-1",
      state: "submitted",
      amount: 4500,
      idempotencyKey: "per-q1",
    });
    syncQuoteToOrderQuote("ws-persona", {
      connectorType: "odoo",
      quoteExternalId: "Q-PER-2",
      state: "submitted",
      amount: 9800,
      idempotencyKey: "per-q2",
    });
    ingestQuoteCommunication("ws-persona", "Q-PER-1", {
      channel: "email",
      direction: "inbound",
      subject: "Please share exact numbers and timeline",
      bodyText: "We need concrete costs, compliance details, and final deadline this week.",
      idempotencyKey: "per-e1",
    });
    ingestQuoteCommunication("ws-persona", "Q-PER-2", {
      channel: "email",
      direction: "inbound",
      subject: "Quick strategic sync",
      bodyText: "Let's discuss future potential and options in a short call.",
      idempotencyKey: "per-e2",
    });

    const insights = getQuotePersonalityInsights("ws-persona", {
      limit: 10,
      minConfidence: 0.3,
    }) as {
      model: string;
      sampledQuotes: number;
      dominantType: string | null;
      averageConfidence: number;
      distribution: Array<{ type: string; count: number }>;
      communicationPlaybook: string | null;
    };

    expect(insights.model).toBe("heuristic_mbti_v1");
    expect(insights.sampledQuotes).toBeGreaterThanOrEqual(2);
    expect(insights.dominantType).toMatch(/^[EI][SN][TF][JP]$/);
    expect(insights.averageConfidence).toBeGreaterThan(0.3);
    expect(insights.distribution.length).toBeGreaterThanOrEqual(1);
    expect(typeof insights.communicationPlaybook === "string" || insights.communicationPlaybook === null).toBe(true);
  });

  test("mailbox import ingests gmail messages with quote-id inference and dedupe", () => {
    syncQuoteToOrderQuote("ws-mail", {
      connectorType: "odoo",
      quoteExternalId: "Q-MAIL-1",
      state: "submitted",
      amount: 8000,
      idempotencyKey: "mail-q1",
    });

    const first = importQuoteMailboxCommunications("ws-mail", {
      provider: "gmail",
      workspaceDomains: ["ourco.example"],
      messages: [
        {
          messageId: "gmail-1",
          threadId: "th-1",
          subject: "Re: update for Q-MAIL-1",
          bodyText: "Can you share an update?",
          fromAddress: "buyer@customer.example",
          toAddress: "sales@ourco.example",
          receivedAt: new Date().toISOString(),
        },
      ],
    }) as {
      ingestedCount: number;
      duplicateCount: number;
      skippedCount: number;
      ingested: Array<{ direction: string; event: { metadata: { mailboxProvider: string } } }>;
    };

    expect(first.ingestedCount).toBe(1);
    expect(first.duplicateCount).toBe(0);
    expect(first.skippedCount).toBe(0);
    expect(first.ingested[0].direction).toBe("inbound");
    expect(first.ingested[0].event.metadata.mailboxProvider).toBe("gmail");

    const second = importQuoteMailboxCommunications("ws-mail", {
      provider: "gmail",
      workspaceDomains: ["ourco.example"],
      messages: [
        {
          messageId: "gmail-1",
          subject: "Re: update for Q-MAIL-1",
          bodyText: "Can you share an update?",
          fromAddress: "buyer@customer.example",
          toAddress: "sales@ourco.example",
          receivedAt: new Date().toISOString(),
        },
      ],
    }) as { ingestedCount: number; duplicateCount: number };

    expect(second.ingestedCount).toBe(0);
    expect(second.duplicateCount).toBe(1);
  });

  test("mailbox import can auto-create quote and run follow-up engine", () => {
    const result = importQuoteMailboxCommunications("ws-mail-auto", {
      provider: "outlook",
      defaultConnectorType: "dynamics",
      workspaceDomains: ["ourco.example"],
      autoCreateSubmittedQuote: true,
      runFollowupEngine: true,
      followupAfterHours: 1,
      now: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      messages: [
        {
          messageId: "outlook-1",
          subject: "Budget issue for Q-MAIL-AUTO-1",
          bodyText: "This is too expensive, we need a discount before approval.",
          fromAddress: "buyer@customer.example",
          toAddress: "owner@ourco.example",
          receivedAt: new Date().toISOString(),
        },
      ],
    }) as {
      autoCreatedQuoteCount: number;
      autoCreatedQuotes: string[];
      followups?: { createdCount: number; created: Array<{ quoteExternalId: string; actionType: string }> };
    };

    expect(result.autoCreatedQuoteCount).toBe(1);
    expect(result.autoCreatedQuotes).toContain("Q-MAIL-AUTO-1");
    expect(result.followups?.createdCount).toBe(1);
    expect(result.followups?.created[0].quoteExternalId).toBe("Q-MAIL-AUTO-1");
    expect(result.followups?.created[0].actionType).toBe("call_followup");
  });

  test("mailbox pull ingests gmail API messages into communication pipeline", async () => {
    syncQuoteToOrderQuote("ws-pull", {
      connectorType: "odoo",
      quoteExternalId: "Q-PULL-1",
      state: "submitted",
      amount: 7000,
      idempotencyKey: "pull-q1",
    });
    const originalFetch = globalThis.fetch;
    const bodyData = Buffer.from("Need update for Q-PULL-1?", "utf8").toString("base64url");
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/gmail/v1/users/me/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "msg-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/gmail/v1/users/me/messages/msg-1")) {
        return new Response(JSON.stringify({
          id: "msg-1",
          threadId: "thread-1",
          snippet: "Need update",
          payload: {
            headers: [
              { name: "Subject", value: "Re: Q-PULL-1 next step" },
              { name: "From", value: "buyer@customer.example" },
              { name: "To", value: "sales@ourco.example" },
              { name: "Date", value: "Wed, 11 Mar 2026 18:00:00 +0000" },
            ],
            body: { data: bodyData },
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;
    try {
      const pulled = await pullQuoteMailboxCommunications("ws-pull", {
        provider: "gmail",
        accessToken: "token",
        userId: "me",
        limit: 10,
        workspaceDomains: ["ourco.example"],
        runFollowupEngine: false,
      }) as {
        pulledCount: number;
        import: { ingestedCount: number; duplicateCount: number };
      };
      expect(pulled.pulledCount).toBe(1);
      expect(pulled.import.ingestedCount).toBe(1);
      expect(pulled.import.duplicateCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("mailbox connections support upsert/list/refresh/disable lifecycle", async () => {
    const saved = upsertQuoteMailboxConnection("ws-mailbox", {
      provider: "gmail",
      userId: "me",
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      refreshToken: "refresh-token-1",
      accessToken: "access-token-1",
      accessTokenExpiresAt: new Date(Date.now() - 30_000).toISOString(),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    }) as { enabled: boolean; hasRefreshToken: boolean };
    expect(saved.enabled).toBe(true);
    expect(saved.hasRefreshToken).toBe(true);

    const listed = listQuoteMailboxConnections("ws-mailbox", { provider: "gmail" }) as { items: Array<{ provider: string; enabled: boolean }> };
    expect(listed.items.length).toBe(1);
    expect(listed.items[0].provider).toBe("gmail");
    expect(listed.items[0].enabled).toBe(true);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({
          access_token: "access-token-2",
          refresh_token: "refresh-token-2",
          expires_in: 3600,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;
    try {
      const refreshed = await refreshQuoteMailboxConnection("ws-mailbox", "gmail", {
        userId: "me",
        force: true,
      }) as { tokenSource: string; connection: { hasAccessToken: boolean; hasRefreshToken: boolean; enabled: boolean } };
      expect(refreshed.tokenSource).toBe("refreshed");
      expect(refreshed.connection.hasAccessToken).toBe(true);
      expect(refreshed.connection.hasRefreshToken).toBe(true);
      expect(refreshed.connection.enabled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const disabled = disableQuoteMailboxConnection("ws-mailbox", "gmail", { userId: "me" }) as { status: string };
    expect(disabled.status).toBe("disabled");
    const listedAfterDisable = listQuoteMailboxConnections("ws-mailbox", { provider: "gmail" }) as { items: Array<{ enabled: boolean }> };
    expect(listedAfterDisable.items.length).toBe(1);
    expect(listedAfterDisable.items[0].enabled).toBe(false);
  });

  test("mailbox pull uses stored mailbox connection when access token is omitted", async () => {
    syncQuoteToOrderQuote("ws-pull-stored", {
      connectorType: "odoo",
      quoteExternalId: "Q-PULL-STORED-1",
      state: "submitted",
      amount: 9100,
      idempotencyKey: "pull-stored-q1",
    });
    upsertQuoteMailboxConnection("ws-pull-stored", {
      provider: "gmail",
      userId: "sales@ourco.example",
      accessToken: "stored-token",
      accessTokenExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });

    const originalFetch = globalThis.fetch;
    const bodyData = Buffer.from("Status update for Q-PULL-STORED-1?", "utf8").toString("base64url");
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/gmail/v1/users/sales%40ourco.example/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "msg-stored-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/gmail/v1/users/sales%40ourco.example/messages/msg-stored-1")) {
        return new Response(JSON.stringify({
          id: "msg-stored-1",
          threadId: "thread-stored-1",
          snippet: "Status update",
          payload: {
            headers: [
              { name: "Subject", value: "Re: Q-PULL-STORED-1 next step" },
              { name: "From", value: "buyer@customer.example" },
              { name: "To", value: "sales@ourco.example" },
              { name: "Date", value: "Wed, 11 Mar 2026 18:00:00 +0000" },
            ],
            body: { data: bodyData },
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not-found", { status: 404 });
    }) as typeof fetch;
    try {
      const pulled = await pullQuoteMailboxCommunications("ws-pull-stored", {
        provider: "gmail",
        userId: "me",
        useStoredConnection: true,
        limit: 10,
        workspaceDomains: ["ourco.example"],
      }) as {
        userId: string;
        tokenSource: string;
        pulledCount: number;
        import: { ingestedCount: number; duplicateCount: number };
      };
      expect(pulled.userId).toBe("sales@ourco.example");
      expect(pulled.tokenSource).toBe("stored_access_token");
      expect(pulled.pulledCount).toBe(1);
      expect(pulled.import.ingestedCount).toBe(1);
      expect(pulled.import.duplicateCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("follow-up writeback pushes activity to connector and updates action state", async () => {
    connectConnector("odoo", {
      authMode: "api-key",
      config: { apiKey: "k" },
      metadata: { odooPlan: "custom" },
    });
    syncQuoteToOrderQuote("ws-wb", {
      connectorType: "odoo",
      quoteExternalId: "Q-WB-1",
      state: "submitted",
      amount: 6000,
      idempotencyKey: "wb-q1",
    });
    ingestQuoteCommunication("ws-wb", "Q-WB-1", {
      channel: "email",
      direction: "inbound",
      subject: "Budget issue",
      bodyText: "This is too expensive and we need a discount.",
      idempotencyKey: "wb-e1",
    });
    const run = runQuoteFollowupEngine("ws-wb", {
      followupAfterHours: 1,
      now: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      maxActions: 10,
    }) as { created: Array<{ id: string }> };
    const actionId = run.created[0]?.id;
    expect(actionId).toBeTruthy();

    const written = await writebackQuoteFollowupAction("ws-wb", actionId, {
      statusOnSuccess: "sent",
      assignedTo: "ops",
      note: "Synced to ERP task",
    }) as {
      action: { status: string; writeback: { status: string; connector: string } };
      writeback: { status: string; connectorType: string };
    };

    expect(written.writeback.status).toBe("success");
    expect(written.writeback.connectorType).toBe("odoo");
    expect(written.action.status).toBe("sent");
    expect(written.action.writeback.status).toBe("success");
    expect(written.action.writeback.connector).toBe("odoo");
  });

  test("follow-up batch writeback processes open actions", async () => {
    connectConnector("dynamics", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: {},
    });
    for (const quoteExternalId of ["Q-BATCH-1", "Q-BATCH-2"]) {
      syncQuoteToOrderQuote("ws-wb-batch", {
        connectorType: "dynamics",
        quoteExternalId,
        state: "submitted",
        amount: 4000,
        idempotencyKey: `batch-${quoteExternalId}`,
      });
      ingestQuoteCommunication("ws-wb-batch", quoteExternalId, {
        channel: "email",
        direction: "inbound",
        subject: `${quoteExternalId} status update?`,
        bodyText: "Can you share an update?",
        idempotencyKey: `batch-msg-${quoteExternalId}`,
      });
    }
    runQuoteFollowupEngine("ws-wb-batch", {
      followupAfterHours: 1,
      now: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      maxActions: 10,
    });

    const result = await writebackQuoteFollowupBatch("ws-wb-batch", {
      status: "open",
      limit: 10,
      statusOnSuccess: "sent",
      assignedTo: "ops",
    }) as { processedCount: number; failedCount: number };

    expect(result.processedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    const sent = listQuoteFollowupActions("ws-wb-batch", { status: "sent", limit: 10 });
    expect(sent.items.length).toBe(2);
  });

  test("scheduled follow-up writeback processes open actions across workspaces", async () => {
    connectConnector("odoo", {
      authMode: "api-key",
      config: { apiKey: "k" },
      metadata: { odooPlan: "custom" },
    });
    for (const workspaceId of ["ws-auto-a", "ws-auto-b"]) {
      syncQuoteToOrderQuote(workspaceId, {
        connectorType: "odoo",
        quoteExternalId: `Q-${workspaceId}`,
        state: "submitted",
        amount: 5200,
        idempotencyKey: `q-${workspaceId}`,
      });
      ingestQuoteCommunication(workspaceId, `Q-${workspaceId}`, {
        channel: "email",
        direction: "inbound",
        subject: `Q-${workspaceId} status`,
        bodyText: "Can you share an update?",
        idempotencyKey: `msg-${workspaceId}`,
      });
      runQuoteFollowupEngine(workspaceId, {
        followupAfterHours: 1,
        now: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      });
    }
    const result = await runScheduledFollowupWritebacks({
      limitPerWorkspace: 5,
      statusOnSuccess: "sent",
    }) as { workspaceCount: number; processedCount: number; failedCount: number };
    expect(result.workspaceCount).toBeGreaterThanOrEqual(2);
    expect(result.processedCount).toBe(2);
    expect(result.failedCount).toBe(0);
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

  test("wizard session creation bootstraps onboarding baseline", () => {
    const session = createWizardSessionState({
      workspaceId: "ws-wizard-a",
      customerName: "Wizard Agency",
      product: "quote-to-order",
      createdBy: "ops@agency.test",
    }) as { id: string; onboardingId: string; steps: Array<{ id: string; status: string }> };

    expect(session.id).toBeTruthy();
    expect(session.onboardingId).toBeTruthy();
    const baselineStep = session.steps.find((step) => step.id === "baseline");
    expect(baselineStep?.status).toBe("done");

    const list = listWizardSessionStates({ workspaceId: "ws-wizard-a", limit: 10 });
    expect(list.items.length).toBeGreaterThanOrEqual(1);
  });

  test("wizard production launch is blocked by critical gates when connectors/dry-run are missing", () => {
    const session = createWizardSessionState({
      workspaceId: "ws-wizard-b",
      customerName: "Blocked Co",
      product: "quote-to-order",
    }) as { id: string };

    expect(() => launchWizardSession(session.id, { mode: "production" })).toThrow("critical gates");
  });

  test("wizard supports override flow for non-critical gates and launches after approval", async () => {
    connectConnector("odoo", {
      authMode: "api-key",
      config: { apiKey: "k" },
      metadata: { odooPlan: "custom" },
    });
    connectConnector("business-central", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: { webhookExpiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() },
    });
    connectConnector("dynamics", {
      authMode: "oauth",
      config: { clientId: "id" },
      metadata: {},
    });

    const session = createWizardSessionState({
      workspaceId: "ws-wizard-c",
      customerName: "Launch Co",
      product: "quote-to-order",
    }) as { id: string };

    recordWizardConnectorConnection(session.id, "odoo");
    recordWizardConnectorConnection(session.id, "business-central");
    recordWizardConnectorConnection(session.id, "dynamics");

    const testResult = await runWizardConnectorTest(session.id, "odoo", {});
    expect(testResult).toHaveProperty("syncResult");

    const md = runWizardMasterDataAutoSync(session.id, {});
    expect(md).toHaveProperty("summary");

    const dryRun = runWizardQuoteToOrderDryRun(session.id, { amount: 1200, currency: "EUR" });
    expect(dryRun).toHaveProperty("workflowRunId");

    await syncConnector("dynamics", {
      direction: "ingest",
      entityType: "lead",
      payload: { forced: true },
      maxRetries: 0,
    }, async () => {
      throw new Error("forced connector degradation");
    });

    expect(() => launchWizardSession(session.id, { mode: "production" })).toThrow("requires overrides");

    overrideWizardGate(session.id, "connector_health", { reason: "Known transient issue, monitored", approvedBy: "ops-lead" });
    overrideWizardGate(session.id, "mapping_drift", { reason: "Mapping review accepted for pilot", approvedBy: "ops-lead" });
    const launched = launchWizardSession(session.id, { mode: "production" }) as { session: { status: string } };
    expect(launched.session.status).toBe("launched");

    const refreshed = getWizardSessionState(session.id) as { status: string };
    expect(refreshed.status).toBe("launched");

    const report = getWizardSessionReport(session.id);
    expect(report).toHaveProperty("executive");
    expect(report).toHaveProperty("ops");
    expect(report).toHaveProperty("onboarding");
  });

  test("revenue graph sync builds cross-entity graph with neighbors", () => {
    syncQuoteToOrderQuote("ws-graph", {
      connectorType: "odoo",
      quoteExternalId: "Q-GR-1",
      customerExternalId: "ACC-001",
      amount: 5000,
      state: "approved",
      idempotencyKey: "graph-q1",
    });
    syncQuoteToOrderOrder("ws-graph", {
      connectorType: "odoo",
      quoteExternalId: "Q-GR-1",
      orderExternalId: "SO-GR-1",
      state: "converted_to_order",
      idempotencyKey: "graph-o1",
    });
    ingestQuoteCommunication("ws-graph", "Q-GR-1", {
      channel: "email",
      direction: "inbound",
      subject: "Need update for Q-GR-1",
      bodyText: "Can we proceed this week?",
      fromAddress: "buyer@customer.example",
      toAddress: "owner@yourcompany.com",
      idempotencyKey: "graph-e1",
    });

    const sync = syncRevenueGraphWorkspace("ws-graph", { mode: "full", includeCommunications: true });
    expect((sync as { counts: { entityUpserts: number } }).counts.entityUpserts).toBeGreaterThan(0);

    const quoteNode = getRevenueGraphEntity("ws-graph", "quote", "Q-GR-1", { includeNeighbors: true }) as {
      entity: { entityType: string };
      neighbors: Array<{ entityType: string }>;
      relations: Array<{ relation: string }>;
    };
    expect(quoteNode.entity.entityType).toBe("quote");
    expect(quoteNode.neighbors.some((n) => n.entityType === "order")).toBe(true);
    expect(quoteNode.relations.some((r) => r.relation === "converts_to_order")).toBe(true);
  });

  test("thread sync and thread signals expose structured communication intelligence", async () => {
    syncQuoteToOrderQuote("ws-thread", {
      connectorType: "dynamics",
      quoteExternalId: "Q-TH-1",
      state: "submitted",
      amount: 12000,
      idempotencyKey: "th-q1",
    });
    ingestQuoteCommunication("ws-thread", "Q-TH-1", {
      channel: "email",
      direction: "inbound",
      subject: "Budget concern",
      bodyText: "This is too expensive and we need procurement review.",
      fromAddress: "buyer@customer.example",
      toAddress: "sales@yourcompany.com",
      externalThreadId: "thread-42",
      occurredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      idempotencyKey: "th-e1",
    });
    ingestQuoteCommunication("ws-thread", "Q-TH-1", {
      channel: "email",
      direction: "outbound",
      subject: "Re: Budget concern",
      bodyText: "Sharing ROI and legal details.",
      fromAddress: "sales@yourcompany.com",
      toAddress: "buyer@customer.example",
      externalThreadId: "thread-42",
      occurredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      idempotencyKey: "th-e2",
    });

    const threadSync = await syncQuoteCommunicationThreads("ws-thread", { source: "existing", limit: 10 });
    expect((threadSync as { threadCount: number }).threadCount).toBeGreaterThanOrEqual(1);

    const signals = getQuoteCommunicationThreadSignals("ws-thread", "thread-42", { includeEvents: true }) as {
      objectionCategories: string[];
      followupLikelihoodPct: number;
      responseLatency: { sampledPairs: number };
      personality: { explanation: unknown };
    };
    expect(signals.objectionCategories).toContain("pricing");
    expect(signals.followupLikelihoodPct).toBeGreaterThan(0);
    expect(signals.responseLatency.sampledPairs).toBeGreaterThanOrEqual(1);
    expect(signals.personality.explanation).toBeTruthy();
  });

  test("next-action proposal honors consent guardrail and supports approval/rejection lifecycle", async () => {
    syncQuoteToOrderQuote("ws-auto", {
      connectorType: "business-central",
      quoteExternalId: "Q-AUTO-1",
      state: "submitted",
      amount: 9000,
      idempotencyKey: "auto-q1",
    });
    ingestQuoteCommunication("ws-auto", "Q-AUTO-1", {
      channel: "email",
      direction: "inbound",
      subject: "Need discount before approval",
      bodyText: "This is too expensive for our budget.",
      fromAddress: "buyer@customer.example",
      toAddress: "sales@yourcompany.com",
      idempotencyKey: "auto-e1",
    });

    const recommendation = createQuoteNextActionRecommendation("ws-auto", {
      quoteExternalId: "Q-AUTO-1",
      mode: "create_proposal",
      requireApproval: true,
    }) as { proposal: { id: string } };
    const proposalId = recommendation.proposal.id;

    updateTrustConsent({
      workspaceId: "ws-auto",
      contactKey: "buyer@customer.example",
      status: "opt_out",
      purposes: ["deal_communication"],
      source: "manual",
      updatedBy: "privacy-officer",
    });
    await expect(approveQuoteAutopilotProposal("ws-auto", proposalId, {
      approvedBy: "ops-lead",
      execute: true,
    })).rejects.toThrow("opted out");

    const rejected = rejectQuoteAutopilotProposal("ws-auto", proposalId, {
      rejectedBy: "ops-lead",
      reason: "Consent restriction",
    }) as { proposal: { status: string } };
    expect(rejected.proposal.status).toBe("rejected");

    updateTrustConsent({
      workspaceId: "ws-auto",
      contactKey: "buyer@customer.example",
      status: "opt_in",
      purposes: ["deal_communication"],
      source: "manual",
      updatedBy: "privacy-officer",
    });
    const second = createQuoteNextActionRecommendation("ws-auto", {
      quoteExternalId: "Q-AUTO-1",
      mode: "create_proposal",
      requireApproval: true,
    }) as { proposal: { id: string } };
    const approved = await approveQuoteAutopilotProposal("ws-auto", second.proposal.id, {
      approvedBy: "ops-lead",
      execute: true,
    }) as { proposal: { status: string }; executionResult: { executionMode: string } };
    expect(approved.proposal.status).toBe("executed");
    expect(typeof approved.executionResult.executionMode).toBe("string");

    const consentStatus = getTrustConsentStatus({ workspaceId: "ws-auto", contactKey: "buyer@customer.example" }) as {
      summary: { opt_in: number };
      items: Array<{ status: string }>;
    };
    expect(consentStatus.summary.opt_in).toBeGreaterThanOrEqual(1);
    expect(consentStatus.items[0].status).toBe("opt_in");
  });

  test("deal rescue run and revenue analytics expose recovery and forecast metrics", () => {
    syncQuoteToOrderQuote("ws-ri", {
      connectorType: "dynamics",
      quoteExternalId: "Q-RI-STALE",
      state: "submitted",
      amount: 15000,
      idempotencyKey: "ri-q-stale",
    });
    ingestQuoteCommunication("ws-ri", "Q-RI-STALE", {
      channel: "email",
      direction: "inbound",
      subject: "Re: quote",
      bodyText: "We will come back next quarter.",
      occurredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      idempotencyKey: "ri-e-stale",
    });

    syncQuoteToOrderQuote("ws-ri", {
      connectorType: "dynamics",
      quoteExternalId: "Q-RI-WON",
      state: "fulfilled",
      amount: 8000,
      idempotencyKey: "ri-q-won",
    });
    ingestQuoteCommunication("ws-ri", "Q-RI-WON", {
      channel: "email",
      direction: "inbound",
      subject: "ready to buy",
      bodyText: "PO approved and ready to proceed.",
      idempotencyKey: "ri-e-won",
    });

    syncQuoteToOrderQuote("ws-ri", {
      connectorType: "dynamics",
      quoteExternalId: "Q-RI-LOST",
      state: "rejected",
      amount: 3000,
      idempotencyKey: "ri-q-lost",
    });
    ingestQuoteCommunication("ws-ri", "Q-RI-LOST", {
      channel: "email",
      direction: "inbound",
      subject: "not interested",
      bodyText: "Not interested anymore, budget frozen.",
      idempotencyKey: "ri-e-lost",
    });

    const rescue = runQuoteDealRescue("ws-ri", {
      mode: "batch",
      minStagnationHours: 24,
      maxQuotes: 10,
      dryRun: false,
    }) as { identifiedQuotes: Array<unknown>; proposalCount: number };
    expect(rescue.identifiedQuotes.length).toBeGreaterThanOrEqual(1);
    expect(rescue.proposalCount).toBeGreaterThanOrEqual(1);

    const forecast = getForecastQualityAnalytics({ workspaceId: "ws-ri", minSamples: 1 }) as {
      sampleSize: number;
      meanAbsoluteErrorPct: number;
      calibration: Array<{ bucket: string }>;
    };
    expect(forecast.sampleSize).toBeGreaterThanOrEqual(2);
    expect(forecast.meanAbsoluteErrorPct).toBeGreaterThanOrEqual(0);
    expect(forecast.calibration.length).toBeGreaterThan(0);

    const revenue = getRevenueIntelligenceAnalytics({ workspaceId: "ws-ri" }) as {
      metrics: { recoveredRevenueEur: number; followupSlaAdherencePct: number };
      forecast: { sampleSize: number };
    };
    expect(revenue.metrics.recoveredRevenueEur).toBeGreaterThanOrEqual(0);
    expect(revenue.metrics.followupSlaAdherencePct).toBeGreaterThanOrEqual(0);
    expect(revenue.forecast.sampleSize).toBeGreaterThanOrEqual(2);
  });
});

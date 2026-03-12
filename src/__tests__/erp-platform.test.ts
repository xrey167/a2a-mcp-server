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
  getQuotePersonalityProfile,
  recordQuotePersonalityFeedback,
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
  createQuotePersonalityReplyRecommendation,
  createQuoteNextActionRecommendation,
  listQuoteAutopilotProposals,
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
  getCustomer360Profile,
  getCustomer360Health,
  getCustomer360Timeline,
  getCustomer360Segments,
  getCustomer360ChurnRisk,
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

  test("personality profile endpoint returns explainable profile per contact", () => {
    syncQuoteToOrderQuote("ws-profile", {
      connectorType: "odoo",
      quoteExternalId: "Q-PROF-1",
      state: "submitted",
      amount: 5100,
      idempotencyKey: "prof-q1",
    });
    ingestQuoteCommunication("ws-profile", "Q-PROF-1", {
      channel: "email",
      direction: "inbound",
      subject: "Need exact compliance timeline",
      bodyText: "Please send concrete cost numbers and final decision deadline.",
      fromAddress: "buyer@customer.example",
      toAddress: "ops@ourco.example",
      idempotencyKey: "prof-e1",
    });
    ingestQuoteCommunication("ws-profile", "Q-PROF-1", {
      channel: "email",
      direction: "inbound",
      subject: "Reminder for final contract details",
      bodyText: "We need exact legal/compliance checklist before approval.",
      fromAddress: "buyer@customer.example",
      toAddress: "ops@ourco.example",
      idempotencyKey: "prof-e2",
    });

    const profile = getQuotePersonalityProfile("ws-profile", "buyer@customer.example", {
      includeRecentEvents: true,
      eventLimit: 10,
      autoRecompute: true,
    }) as {
      profile: {
        personalityType: string | null;
        confidence: number;
        sampleCount: number;
        explanation: { model: string };
      };
      recentEvents: unknown[];
      communicationPlaybook: string;
      feedback: { summary: { total: number } };
    };

    expect(profile.profile.personalityType).toMatch(/^[EI][SN][TF][JP]$/);
    expect(profile.profile.confidence).toBeGreaterThan(0.3);
    expect(profile.profile.sampleCount).toBeGreaterThanOrEqual(2);
    expect(profile.profile.explanation.model).toBe("heuristic_mbti_v1");
    expect(profile.recentEvents.length).toBeGreaterThanOrEqual(1);
    expect(typeof profile.communicationPlaybook).toBe("string");
    expect(profile.feedback.summary.total).toBe(0);
  });

  test("personality feedback updates feedback summary and keeps learning loop data", () => {
    syncQuoteToOrderQuote("ws-profile-fb", {
      connectorType: "dynamics",
      quoteExternalId: "Q-PROF-FB-1",
      state: "submitted",
      amount: 7800,
      idempotencyKey: "prof-fb-q1",
    });
    ingestQuoteCommunication("ws-profile-fb", "Q-PROF-FB-1", {
      channel: "email",
      direction: "inbound",
      subject: "Can we align on next step?",
      bodyText: "Please propose final next action and owner today.",
      fromAddress: "buyer2@customer.example",
      toAddress: "ops@ourco.example",
      idempotencyKey: "prof-fb-e1",
    });

    const feedback = recordQuotePersonalityFeedback("ws-profile-fb", {
      contactKey: "buyer2@customer.example",
      quoteExternalId: "Q-PROF-FB-1",
      actionType: "followup_email",
      outcome: "positive",
      replyReceived: true,
      convertedToOrder: true,
      note: "Customer responded quickly and approved next step.",
      recordedBy: "ops-lead",
      applyLearning: true,
    }) as {
      status: string;
      feedback: {
        outcome: string;
        convertedToOrder: boolean;
      };
      profile: {
        personalityType: string | null;
      } | null;
    };

    expect(feedback.status).toBe("recorded");
    expect(feedback.feedback.outcome).toBe("positive");
    expect(feedback.feedback.convertedToOrder).toBe(true);
    expect(feedback.profile === null || typeof feedback.profile.personalityType === "string" || feedback.profile.personalityType === null).toBe(true);

    const profile = getQuotePersonalityProfile("ws-profile-fb", "buyer2@customer.example", {
      includeRecentEvents: false,
      autoRecompute: false,
    }) as {
      feedback: {
        summary: {
          total: number;
          positive: number;
          replyRatePct: number;
          conversionRatePct: number;
        };
      };
    };

    expect(profile.feedback.summary.total).toBeGreaterThanOrEqual(1);
    expect(profile.feedback.summary.positive).toBeGreaterThanOrEqual(1);
    expect(profile.feedback.summary.replyRatePct).toBeGreaterThan(0);
    expect(profile.feedback.summary.conversionRatePct).toBeGreaterThan(0);
  });

  test("personality reply recommendation returns variants and can create approval proposal", () => {
    syncQuoteToOrderQuote("ws-personality-reply", {
      connectorType: "odoo",
      quoteExternalId: "Q-PR-1",
      state: "submitted",
      amount: 11200,
      idempotencyKey: "pr-q1",
    });
    ingestQuoteCommunication("ws-personality-reply", "Q-PR-1", {
      channel: "email",
      direction: "inbound",
      subject: "Need final budget certainty",
      bodyText: "This looks expensive. Please send final numbers and who owns approvals.",
      fromAddress: "buyer@customer.example",
      toAddress: "sales@ourco.example",
      idempotencyKey: "pr-e1",
    });

    const recommendation = createQuotePersonalityReplyRecommendation("ws-personality-reply", {
      quoteExternalId: "Q-PR-1",
      tone: "empathetic",
      variantCount: 3,
      selectedVariantIndex: 1,
      createProposal: true,
      requireApproval: true,
      assignedTo: "ops-lead",
    }) as {
      contactKey: string | null;
      variants: Array<{ label: string; expectedReplyLikelihoodPct: number }>;
      selectedVariantIndex: number;
      selectedVariant: { label: string };
      proposal: { id: string; actionType: string; status: string } | null;
      personality: { confidence: number };
    };

    expect(recommendation.contactKey).toBe("buyer@customer.example");
    expect(recommendation.variants.length).toBe(3);
    expect(recommendation.selectedVariantIndex).toBe(1);
    expect(typeof recommendation.selectedVariant.label).toBe("string");
    expect(recommendation.variants[0].expectedReplyLikelihoodPct).toBeGreaterThan(0);
    expect(recommendation.personality.confidence).toBeGreaterThanOrEqual(0);
    expect(recommendation.proposal?.actionType).toBe("followup_email");
    expect(recommendation.proposal?.status).toBe("draft");

    const queue = listQuoteAutopilotProposals("ws-personality-reply", {
      status: "draft",
      limit: 10,
    }) as {
      items: Array<{ id: string; actionType: string; status: string }>;
      summary: { draft: number };
      queue: { nextDraftProposalId: string | null };
    };
    expect(queue.items.length).toBeGreaterThanOrEqual(1);
    expect(queue.items[0].actionType).toBe("followup_email");
    expect(queue.items[0].status).toBe("draft");
    expect(queue.summary.draft).toBeGreaterThanOrEqual(1);
    expect(typeof queue.queue.nextDraftProposalId === "string" || queue.queue.nextDraftProposalId === null).toBe(true);
  });

  test("autopilot proposal queue listing filters draft and approved states", async () => {
    syncQuoteToOrderQuote("ws-proposal-queue", {
      connectorType: "business-central",
      quoteExternalId: "Q-PQ-1",
      state: "submitted",
      amount: 8400,
      idempotencyKey: "pq-q1",
    });
    ingestQuoteCommunication("ws-proposal-queue", "Q-PQ-1", {
      channel: "email",
      direction: "inbound",
      subject: "Need decision by Friday",
      bodyText: "Please share next step and owner for legal review.",
      fromAddress: "buyer@customer.example",
      toAddress: "sales@ourco.example",
      idempotencyKey: "pq-e1",
    });

    const nextAction = createQuoteNextActionRecommendation("ws-proposal-queue", {
      quoteExternalId: "Q-PQ-1",
      mode: "create_proposal",
      requireApproval: true,
    }) as { proposal: { id: string } };
    const personality = createQuotePersonalityReplyRecommendation("ws-proposal-queue", {
      quoteExternalId: "Q-PQ-1",
      tone: "direct",
      variantCount: 2,
      createProposal: true,
      selectedVariantIndex: 0,
      requireApproval: true,
    }) as { proposal: { id: string } | null };

    const draftBefore = listQuoteAutopilotProposals("ws-proposal-queue", {
      status: "draft",
      limit: 10,
    }) as { items: Array<{ id: string }> };
    expect(draftBefore.items.length).toBeGreaterThanOrEqual(2);

    const approved = await approveQuoteAutopilotProposal("ws-proposal-queue", nextAction.proposal.id, {
      approvedBy: "ops-lead",
      execute: false,
    }) as { proposal: { id: string; status: string } };
    expect(approved.proposal.status).toBe("approved");

    const draftAfter = listQuoteAutopilotProposals("ws-proposal-queue", {
      status: "draft",
      limit: 10,
    }) as { items: Array<{ id: string }> };
    expect(draftAfter.items.some((item) => item.id === nextAction.proposal.id)).toBe(false);
    expect(personality.proposal).not.toBeNull();
    expect(draftAfter.items.some((item) => item.id === personality.proposal?.id)).toBe(true);

    const approvedQueue = listQuoteAutopilotProposals("ws-proposal-queue", {
      status: "approved",
      limit: 10,
    }) as { items: Array<{ id: string; status: string }> };
    expect(approvedQueue.items.some((item) => item.id === nextAction.proposal.id && item.status === "approved")).toBe(true);
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

  // ─── Customer 360 ──────────────────────────────────────────────────────────

  test("Customer 360 profile: 'new' segment for brand-new customer with ≤ 2 quotes", () => {
    syncQuoteToOrderQuote("ws-c360-new", {
      connectorType: "dynamics",
      quoteExternalId: "Q-C360-N1",
      state: "submitted",
      amount: 5000,
      customerExternalId: "CUST-NEW",
      idempotencyKey: "c360-n1",
    });

    const profile = getCustomer360Profile("ws-c360-new", "CUST-NEW") as Record<string, unknown>;
    expect(profile.segment).toBe("new");
    expect(profile.fromCache).toBe(false);
    expect((profile.quotes as Record<string, number>).total).toBe(1);
  });

  test("Customer 360 profile: 'at_risk' segment when health score is below 40 (all-rejected quotes, no comms)", () => {
    // 3 rejected quotes → no revenue, no active quotes, no comms → healthScore ≈ 34 → at_risk
    for (let i = 1; i <= 3; i++) {
      syncQuoteToOrderQuote("ws-c360-risk", {
        connectorType: "dynamics",
        quoteExternalId: `Q-C360-RISK-${i}`,
        state: "rejected",
        amount: 1000,
        customerExternalId: "CUST-RISK",
        idempotencyKey: `c360-risk-${i}`,
      });
    }

    const profile = getCustomer360Profile("ws-c360-risk", "CUST-RISK") as Record<string, unknown>;
    expect(profile.segment).toBe("at_risk");
    const healthScore = (profile.health as Record<string, number>).score;
    expect(healthScore).toBeGreaterThanOrEqual(20); // not churning
    expect(healthScore).toBeLessThan(40);           // at_risk threshold
  });

  test("Customer 360 profile: 'loyal' segment when health ≥ 60 and convertedQuotes ≥ 2", () => {
    // 2 converted + 1 draft → conversionRate > 0.5, no comms, healthScore ≈ 63 → loyal
    syncQuoteToOrderQuote("ws-c360-loyal", {
      connectorType: "dynamics",
      quoteExternalId: "Q-C360-L1",
      state: "fulfilled",
      amount: 1000,
      customerExternalId: "CUST-LOYAL",
      idempotencyKey: "c360-l1",
    });
    syncQuoteToOrderQuote("ws-c360-loyal", {
      connectorType: "dynamics",
      quoteExternalId: "Q-C360-L2",
      state: "converted_to_order",
      amount: 1000,
      customerExternalId: "CUST-LOYAL",
      idempotencyKey: "c360-l2",
    });
    syncQuoteToOrderQuote("ws-c360-loyal", {
      connectorType: "dynamics",
      quoteExternalId: "Q-C360-L3",
      state: "draft",
      amount: 1000,
      customerExternalId: "CUST-LOYAL",
      idempotencyKey: "c360-l3",
    });

    const profile = getCustomer360Profile("ws-c360-loyal", "CUST-LOYAL") as Record<string, unknown>;
    expect(profile.segment).toBe("loyal");
    expect((profile.quotes as Record<string, number>).converted).toBe(2);
    expect((profile.health as Record<string, number>).score).toBeGreaterThanOrEqual(60);
  });

  test("Customer 360 profile: 'champion' segment for high-health, high-conversion customer with many positive comms", () => {
    // 4 quotes: 2 fulfilled, 2 draft → conversionRate = 0.5 ✓
    for (let i = 1; i <= 2; i++) {
      syncQuoteToOrderQuote("ws-c360-champ", {
        connectorType: "dynamics",
        quoteExternalId: `Q-C360-C${i}`,
        state: "fulfilled",
        amount: 1000,
        customerExternalId: "CUST-CHAMP",
        idempotencyKey: `c360-champ-q${i}`,
      });
    }
    for (let i = 3; i <= 4; i++) {
      syncQuoteToOrderQuote("ws-c360-champ", {
        connectorType: "dynamics",
        quoteExternalId: `Q-C360-C${i}`,
        state: "draft",
        amount: 1000,
        customerExternalId: "CUST-CHAMP",
        idempotencyKey: `c360-champ-q${i}`,
      });
    }

    // 10 positive-sentiment comms ("go ahead" → ready_to_buy → positive)
    for (let i = 1; i <= 10; i++) {
      ingestQuoteCommunication("ws-c360-champ", "Q-C360-C1", {
        channel: "email",
        direction: "inbound",
        bodyText: "go ahead with the purchase order",
        idempotencyKey: `c360-champ-e${i}`,
      });
    }

    const profile = getCustomer360Profile("ws-c360-champ", "CUST-CHAMP") as Record<string, unknown>;
    expect(profile.segment).toBe("champion");
    expect((profile.health as Record<string, number>).score).toBeGreaterThanOrEqual(80);
    expect((profile.revenue as Record<string, number>).conversionRate).toBe(0.5);
  });

  test("Customer 360 profile: 'promising' segment as default for mid-health customer", () => {
    // 3 draft quotes → totalQuotes > 2 (not new), healthScore ≈ 41 (not at_risk, champion, or loyal)
    for (let i = 1; i <= 3; i++) {
      syncQuoteToOrderQuote("ws-c360-prm", {
        connectorType: "dynamics",
        quoteExternalId: `Q-C360-PRM-${i}`,
        state: "draft",
        amount: 500,
        customerExternalId: "CUST-PRM",
        idempotencyKey: `c360-prm-${i}`,
      });
    }

    const profile = getCustomer360Profile("ws-c360-prm", "CUST-PRM") as Record<string, unknown>;
    expect(profile.segment).toBe("promising");
  });

  test("Customer 360 profile: second call within 1 hour returns fromCache=true", () => {
    syncQuoteToOrderQuote("ws-c360-cache", {
      connectorType: "dynamics",
      quoteExternalId: "Q-C360-CACHE",
      state: "submitted",
      amount: 3000,
      customerExternalId: "CUST-CACHE",
      idempotencyKey: "c360-cache-q1",
    });

    const first = getCustomer360Profile("ws-c360-cache", "CUST-CACHE") as Record<string, unknown>;
    expect(first.fromCache).toBe(false);

    const second = getCustomer360Profile("ws-c360-cache", "CUST-CACHE") as Record<string, unknown>;
    expect(second.fromCache).toBe(true);
  });

  test("Customer 360 profile: forceRefresh=true bypasses cache and recomputes", () => {
    syncQuoteToOrderQuote("ws-c360-force", {
      connectorType: "dynamics",
      quoteExternalId: "Q-C360-FORCE",
      state: "draft",
      amount: 2000,
      customerExternalId: "CUST-FORCE",
      idempotencyKey: "c360-force-q1",
    });

    const first = getCustomer360Profile("ws-c360-force", "CUST-FORCE") as Record<string, unknown>;
    expect(first.fromCache).toBe(false);

    const cached = getCustomer360Profile("ws-c360-force", "CUST-FORCE") as Record<string, unknown>;
    expect(cached.fromCache).toBe(true);

    const refreshed = getCustomer360Profile("ws-c360-force", "CUST-FORCE", true) as Record<string, unknown>;
    expect(refreshed.fromCache).toBe(false);
  });

  test("Customer 360 profile: 1 snapshot per day — multiple same-day calls produce exactly one health history entry", () => {
    syncQuoteToOrderQuote("ws-c360-snap", {
      connectorType: "dynamics",
      quoteExternalId: "Q-C360-SNAP",
      state: "submitted",
      amount: 2500,
      customerExternalId: "CUST-SNAP",
      idempotencyKey: "c360-snap-q1",
    });

    getCustomer360Profile("ws-c360-snap", "CUST-SNAP");       // computes fresh, creates snapshot
    getCustomer360Profile("ws-c360-snap", "CUST-SNAP");       // cache hit, no new snapshot
    getCustomer360Profile("ws-c360-snap", "CUST-SNAP", true); // forceRefresh same day → still only 1 snapshot

    const health = getCustomer360Health("ws-c360-snap", "CUST-SNAP") as {
      history: Array<{ score: number; date: string }>;
    };
    expect(health.history.length).toBe(1);
  });

  test("Customer 360 profile: health dimensions are all within [0, 100]", () => {
    syncQuoteToOrderQuote("ws-c360-hdim", {
      connectorType: "dynamics",
      quoteExternalId: "Q-C360-HDIM",
      state: "submitted",
      amount: 7500,
      customerExternalId: "CUST-HDIM",
      idempotencyKey: "c360-hdim-q1",
    });

    const profile = getCustomer360Profile("ws-c360-hdim", "CUST-HDIM") as Record<string, unknown>;
    const h = profile.health as Record<string, number>;
    for (const dim of ["score", "engagement", "revenue", "sentiment", "responsiveness"]) {
      expect(h[dim]).toBeGreaterThanOrEqual(0);
      expect(h[dim]).toBeLessThanOrEqual(100);
    }
  });

  test("Customer 360 health: custom engagement-only weights change aggregated score to equal engagement dimension", () => {
    syncQuoteToOrderQuote("ws-c360-hw", {
      connectorType: "dynamics",
      quoteExternalId: "Q-C360-HW",
      state: "submitted",
      amount: 3000,
      customerExternalId: "CUST-HW",
      idempotencyKey: "c360-hw-q1",
    });
    getCustomer360Profile("ws-c360-hw", "CUST-HW"); // ensure profile exists first

    const defaultHealth = getCustomer360Health("ws-c360-hw", "CUST-HW") as {
      score: number;
      dimensions: { engagement: number; revenue: number; sentiment: number; responsiveness: number };
      weights: Record<string, number>;
      history: Array<{ score: number; date: string }>;
    };

    // With engagement weight = 1.0 and all others = 0, score equals the engagement dimension
    const engagementOnly = getCustomer360Health("ws-c360-hw", "CUST-HW", {
      engagement: 1,
      revenue: 0,
      sentiment: 0,
      responsiveness: 0,
    }) as { score: number };

    expect(engagementOnly.score).toBe(defaultHealth.dimensions.engagement);
    expect(defaultHealth.history.length).toBeGreaterThanOrEqual(1);
    expect(defaultHealth.history[0]).toHaveProperty("score");
    expect(defaultHealth.history[0]).toHaveProperty("date");
  });

  test("Customer 360 timeline: returns quote and communication events sorted DESC by timestamp", () => {
    syncQuoteToOrderQuote("ws-c360-tl", {
      connectorType: "dynamics",
      quoteExternalId: "Q-C360-TL1",
      state: "submitted",
      amount: 5000,
      customerExternalId: "CUST-TL",
      idempotencyKey: "c360-tl-q1",
    });
    ingestQuoteCommunication("ws-c360-tl", "Q-C360-TL1", {
      channel: "email",
      direction: "inbound",
      bodyText: "Looking forward to the demo",
      idempotencyKey: "c360-tl-e1",
    });

    const timeline = getCustomer360Timeline("ws-c360-tl", "CUST-TL") as {
      count: number;
      items: Array<{ type: string; timestamp: string }>;
    };

    expect(timeline.count).toBeGreaterThanOrEqual(2); // at least quote_created + communication
    const timestamps = timeline.items.map((i) => i.timestamp);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1] >= timestamps[i]).toBe(true); // DESC order
    }
    expect(timeline.items.some((i) => i.type === "quote_created")).toBe(true);
    expect(timeline.items.some((i) => i.type === "communication")).toBe(true);
  });

  test("Customer 360 timeline: 'since' filter excludes events before the cutoff date", () => {
    syncQuoteToOrderQuote("ws-c360-since", {
      connectorType: "dynamics",
      quoteExternalId: "Q-C360-SINCE",
      state: "submitted",
      amount: 5000,
      customerExternalId: "CUST-SINCE",
      idempotencyKey: "c360-since-q1",
    });

    // Old communication (2 days ago)
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    ingestQuoteCommunication("ws-c360-since", "Q-C360-SINCE", {
      channel: "email",
      direction: "inbound",
      bodyText: "Checking in on the quote",
      occurredAt: twoDaysAgo,
      idempotencyKey: "c360-since-old",
    });

    // Recent communication (now)
    ingestQuoteCommunication("ws-c360-since", "Q-C360-SINCE", {
      channel: "email",
      direction: "outbound",
      bodyText: "Following up with updated pricing",
      idempotencyKey: "c360-since-new",
    });

    // Filter to yesterday onwards — should exclude the 2-days-ago comm
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const filtered = getCustomer360Timeline("ws-c360-since", "CUST-SINCE", { since: yesterday }) as {
      items: Array<{ type: string; timestamp: string }>;
      totalAvailable: number;
    };

    // All returned items must be at or after the cutoff
    for (const item of filtered.items) {
      expect(item.timestamp >= yesterday).toBe(true);
    }
    // The 2-days-ago communication must not appear in results
    expect(filtered.items.some((i) => i.timestamp < yesterday)).toBe(false);
    // Only 2 items survive the filter: quote_created (now) + outbound comm (now)
    expect(filtered.items.length).toBe(2);
  });

  test("Customer 360 timeline: interactionTypes filter returns only the requested event types", () => {
    syncQuoteToOrderQuote("ws-c360-types", {
      connectorType: "dynamics",
      quoteExternalId: "Q-C360-TYPES",
      state: "submitted",
      amount: 4000,
      customerExternalId: "CUST-TYPES",
      idempotencyKey: "c360-types-q1",
    });
    ingestQuoteCommunication("ws-c360-types", "Q-C360-TYPES", {
      channel: "email",
      direction: "inbound",
      bodyText: "Need more details please",
      idempotencyKey: "c360-types-e1",
    });

    // Request only quote_created events — communications must be absent
    const quoteOnly = getCustomer360Timeline("ws-c360-types", "CUST-TYPES", {
      interactionTypes: ["quote_created"],
    }) as { items: Array<{ type: string }> };

    expect(quoteOnly.items.length).toBeGreaterThanOrEqual(1);
    expect(quoteOnly.items.every((i) => i.type === "quote_created")).toBe(true);
  });

  test("Customer 360 timeline: limit caps the returned result count", () => {
    for (let i = 1; i <= 5; i++) {
      syncQuoteToOrderQuote("ws-c360-lim", {
        connectorType: "dynamics",
        quoteExternalId: `Q-C360-LIM-${i}`,
        state: "submitted",
        amount: 1000,
        customerExternalId: "CUST-LIM",
        idempotencyKey: `c360-lim-q${i}`,
      });
    }

    const limited = getCustomer360Timeline("ws-c360-lim", "CUST-LIM", { limit: 2 }) as {
      count: number;
      totalAvailable: number;
      items: Array<unknown>;
    };

    expect(limited.count).toBe(2);
    expect(limited.items).toHaveLength(2);
    expect(limited.totalAvailable).toBeGreaterThan(2);
  });

  test("Customer 360 segments: auto-computes profiles and returns segment summary for all workspace customers", () => {
    const wsId = "ws-c360-segs";
    syncQuoteToOrderQuote(wsId, {
      connectorType: "dynamics",
      quoteExternalId: "Q-SEG-1",
      state: "submitted",
      amount: 2000,
      customerExternalId: "CUST-SEG-A",
      idempotencyKey: "seg-q1",
    });
    syncQuoteToOrderQuote(wsId, {
      connectorType: "dynamics",
      quoteExternalId: "Q-SEG-2",
      state: "submitted",
      amount: 3000,
      customerExternalId: "CUST-SEG-B",
      idempotencyKey: "seg-q2",
    });

    const result = getCustomer360Segments({ workspaceId: wsId }) as {
      count: number;
      summary: Record<string, number>;
      items: Array<{ customerExternalId: string; segment: string; healthScore: number }>;
    };

    expect(result.count).toBe(2);
    const totalInSummary = Object.values(result.summary).reduce((a, b) => a + b, 0);
    expect(totalInSummary).toBe(2);
    expect(result.items.every((i) => typeof i.segment === "string")).toBe(true);
    // Items are ordered by health_score DESC
    const scores = result.items.map((i) => i.healthScore);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  test("Customer 360 segments: segment filter returns only matching customers", () => {
    const wsId = "ws-c360-segfil";

    // 'new' customer — 1 quote
    syncQuoteToOrderQuote(wsId, {
      connectorType: "dynamics",
      quoteExternalId: "Q-SF-NEW",
      state: "submitted",
      amount: 2000,
      customerExternalId: "CUST-SF-NEW",
      idempotencyKey: "sf-new-q1",
    });

    // 'at_risk' customer — 3 rejected quotes, no comms → healthScore ≈ 34
    for (let i = 1; i <= 3; i++) {
      syncQuoteToOrderQuote(wsId, {
        connectorType: "dynamics",
        quoteExternalId: `Q-SF-RISK-${i}`,
        state: "rejected",
        amount: 1000,
        customerExternalId: "CUST-SF-RISK",
        idempotencyKey: `sf-risk-q${i}`,
      });
    }

    // Pre-compute so both are stored before filtering
    getCustomer360Profile(wsId, "CUST-SF-NEW");
    getCustomer360Profile(wsId, "CUST-SF-RISK");

    const newOnly = getCustomer360Segments({ workspaceId: wsId, segment: "new" }) as {
      items: Array<{ customerExternalId: string }>;
      segmentFilter: string;
    };
    expect(newOnly.segmentFilter).toBe("new");
    expect(newOnly.items.every((i) => i.customerExternalId === "CUST-SF-NEW")).toBe(true);

    const atRiskOnly = getCustomer360Segments({ workspaceId: wsId, segment: "at_risk" }) as {
      items: Array<{ customerExternalId: string }>;
    };
    expect(atRiskOnly.items.some((i) => i.customerExternalId === "CUST-SF-RISK")).toBe(true);
  });

  test("Customer 360 churn risk: single-customer view returns structured risk data", () => {
    syncQuoteToOrderQuote("ws-c360-churn1", {
      connectorType: "dynamics",
      quoteExternalId: "Q-CHURN1",
      state: "submitted",
      amount: 5000,
      customerExternalId: "CUST-CHURN1",
      idempotencyKey: "churn1-q1",
    });

    const result = getCustomer360ChurnRisk({
      workspaceId: "ws-c360-churn1",
      customerExternalId: "CUST-CHURN1",
    }) as {
      churnRisk: { riskPct: number; factors: string[] };
      healthScore: number;
      segment: string;
      lastInteractionAt: string | null;
    };

    expect(typeof result.churnRisk.riskPct).toBe("number");
    expect(result.churnRisk.riskPct).toBeGreaterThanOrEqual(0);
    expect(result.churnRisk.riskPct).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.churnRisk.factors)).toBe(true);
    expect(typeof result.healthScore).toBe("number");
    expect(typeof result.segment).toBe("string");
  });

  test("Customer 360 churn risk: high rejection rate triggers 'high_rejection_rate' factor", () => {
    // rejectionRate = 2/3 > 0.5 → high_rejection_rate (+15 pts)
    syncQuoteToOrderQuote("ws-c360-rej", {
      connectorType: "dynamics",
      quoteExternalId: "Q-REJ-1",
      state: "rejected",
      amount: 2000,
      customerExternalId: "CUST-REJ",
      idempotencyKey: "rej-q1",
    });
    syncQuoteToOrderQuote("ws-c360-rej", {
      connectorType: "dynamics",
      quoteExternalId: "Q-REJ-2",
      state: "rejected",
      amount: 2000,
      customerExternalId: "CUST-REJ",
      idempotencyKey: "rej-q2",
    });
    syncQuoteToOrderQuote("ws-c360-rej", {
      connectorType: "dynamics",
      quoteExternalId: "Q-REJ-3",
      state: "draft",
      amount: 2000,
      customerExternalId: "CUST-REJ",
      idempotencyKey: "rej-q3",
    });

    const result = getCustomer360ChurnRisk({
      workspaceId: "ws-c360-rej",
      customerExternalId: "CUST-REJ",
    }) as { churnRisk: { riskPct: number; factors: string[] } };

    expect(result.churnRisk.factors).toContain("high_rejection_rate");
    expect(result.churnRisk.riskPct).toBeGreaterThanOrEqual(15);
  });

  test("Customer 360 churn risk: declining sentiment triggers 'sentiment_declining_fast' factor", () => {
    syncQuoteToOrderQuote("ws-c360-snt", {
      connectorType: "dynamics",
      quoteExternalId: "Q-SNT-1",
      state: "submitted",
      amount: 3000,
      customerExternalId: "CUST-SNT",
      idempotencyKey: "snt-q1",
    });

    // 2 old positive comms (30 days ago) + 2 recent negative comms → sentimentTrend ≈ -2
    const oldBase = Date.now() - 30 * 86_400_000;
    for (let i = 1; i <= 2; i++) {
      ingestQuoteCommunication("ws-c360-snt", "Q-SNT-1", {
        channel: "email",
        direction: "inbound",
        bodyText: "go ahead with the purchase order",
        occurredAt: new Date(oldBase + i * 60_000).toISOString(),
        idempotencyKey: `snt-pos-${i}`,
      });
    }
    const recentBase = Date.now() - 60_000;
    for (let i = 1; i <= 2; i++) {
      ingestQuoteCommunication("ws-c360-snt", "Q-SNT-1", {
        channel: "email",
        direction: "inbound",
        bodyText: "not interested anymore, stop contacting us",
        occurredAt: new Date(recentBase + i * 60_000).toISOString(),
        idempotencyKey: `snt-neg-${i}`,
      });
    }

    const result = getCustomer360ChurnRisk({
      workspaceId: "ws-c360-snt",
      customerExternalId: "CUST-SNT",
    }) as { churnRisk: { riskPct: number; factors: string[] } };

    expect(result.churnRisk.factors).toContain("sentiment_declining_fast");
    expect(result.churnRisk.riskPct).toBeGreaterThanOrEqual(25);
  });

  test("Customer 360 churn risk: batch view returns only customers above threshold, ordered by risk DESC", () => {
    const wsId = "ws-c360-batch";

    // High-risk customer: 3 rejected quotes → rejectionRate = 1.0 → high_rejection_rate (15 pts)
    for (let i = 1; i <= 3; i++) {
      syncQuoteToOrderQuote(wsId, {
        connectorType: "dynamics",
        quoteExternalId: `Q-BATCH-HIGH-${i}`,
        state: "rejected",
        amount: 1000,
        customerExternalId: "CUST-HIGH-RISK",
        idempotencyKey: `batch-high-${i}`,
      });
    }

    // Low-risk customer: 1 active quote, no rejections → churnRisk = 0
    syncQuoteToOrderQuote(wsId, {
      connectorType: "dynamics",
      quoteExternalId: "Q-BATCH-LOW",
      state: "submitted",
      amount: 3000,
      customerExternalId: "CUST-LOW-RISK",
      idempotencyKey: "batch-low-q1",
    });

    // Pre-compute profiles so churn_risk_pct is stored in DB
    getCustomer360Profile(wsId, "CUST-HIGH-RISK");
    getCustomer360Profile(wsId, "CUST-LOW-RISK");

    // Threshold of 10 — high-risk (15 pts) should appear, low-risk (0 pts) should not
    const result = getCustomer360ChurnRisk({ workspaceId: wsId, threshold: 10 }) as {
      count: number;
      items: Array<{ customerExternalId: string; churnRiskPct: number }>;
    };

    const highRiskItem = result.items.find((i) => i.customerExternalId === "CUST-HIGH-RISK");
    expect(highRiskItem).toBeDefined();
    expect(highRiskItem!.churnRiskPct).toBeGreaterThanOrEqual(15);

    expect(result.items.some((i) => i.customerExternalId === "CUST-LOW-RISK")).toBe(false);

    // Items ordered by churnRiskPct DESC
    const riskValues = result.items.map((i) => i.churnRiskPct);
    for (let i = 1; i < riskValues.length; i++) {
      expect(riskValues[i - 1]).toBeGreaterThanOrEqual(riskValues[i]);
    }
  });
});

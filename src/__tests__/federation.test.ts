import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import Fastify from "fastify";
import { FederationManager } from "../federation.js";

// Spin up a mock A2A agent for testing
function createMockAgent(port: number, name: string, skills: Array<{ id: string; name: string; description: string }>) {
  const app = Fastify({ logger: false });
  app.get("/.well-known/agent.json", async () => ({
    name,
    url: `http://localhost:${port}`,
    description: `Mock ${name} agent`,
    skills,
  }));
  app.get("/healthz", async () => ({ status: "ok" }));
  app.post("/a2a", async (req) => {
    const body = req.body as any;
    return {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        id: body.params?.id ?? "test",
        status: { state: "completed" },
        artifacts: [{ parts: [{ type: "text", text: `Hello from ${name}` }] }],
      },
    };
  });
  return app;
}

describe("FederationManager", () => {
  let mockApp1: ReturnType<typeof Fastify>;
  let mockApp2: ReturnType<typeof Fastify>;
  const PORT1 = 19081;
  const PORT2 = 19082;

  beforeEach(async () => {
    mockApp1 = createMockAgent(PORT1, "agent-alpha", [
      { id: "alpha_search", name: "Search", description: "Full-text search" },
      { id: "alpha_index", name: "Index", description: "Index documents" },
    ]);
    mockApp2 = createMockAgent(PORT2, "agent-beta", [
      { id: "beta_translate", name: "Translate", description: "Text translation" },
    ]);
    await Promise.all([
      mockApp1.listen({ port: PORT1, host: "127.0.0.1" }),
      mockApp2.listen({ port: PORT2, host: "127.0.0.1" }),
    ]);
  });

  afterEach(async () => {
    await Promise.all([
      mockApp1.close(),
      mockApp2.close(),
    ]);
  });

  test("discovers peers and reports them", async () => {
    const fm = new FederationManager({
      peers: [`http://localhost:${PORT1}`, `http://localhost:${PORT2}`],
      healthIntervalMs: 60_000, // don't trigger during test
    });
    await fm.start();
    fm.stop();

    const agents = fm.getAgents();
    expect(agents.length).toBe(2);
    expect(agents.map(a => a.card.name).sort()).toEqual(["agent-alpha", "agent-beta"]);
  });

  test("healthy agents are available", async () => {
    const fm = new FederationManager({
      peers: [`http://localhost:${PORT1}`],
      healthIntervalMs: 60_000,
    });
    await fm.start();
    fm.stop();

    expect(fm.getHealthyAgents().length).toBe(1);
    expect(fm.getHealthyAgents()[0].healthy).toBe(true);
  });

  test("findBySkill returns agents with matching skill", async () => {
    const fm = new FederationManager({
      peers: [`http://localhost:${PORT1}`, `http://localhost:${PORT2}`],
      healthIntervalMs: 60_000,
    });
    await fm.start();
    fm.stop();

    const searchAgents = fm.findBySkill("alpha_search");
    expect(searchAgents.length).toBe(1);
    expect(searchAgents[0].card.name).toBe("agent-alpha");

    const translateAgents = fm.findBySkill("beta_translate");
    expect(translateAgents.length).toBe(1);
    expect(translateAgents[0].card.name).toBe("agent-beta");

    const noMatch = fm.findBySkill("nonexistent_skill");
    expect(noMatch.length).toBe(0);
  });

  test("search finds agents by name", async () => {
    const fm = new FederationManager({
      peers: [`http://localhost:${PORT1}`, `http://localhost:${PORT2}`],
      healthIntervalMs: 60_000,
    });
    await fm.start();
    fm.stop();

    const results = fm.search("alpha");
    expect(results.length).toBe(1);
    expect(results[0].card.name).toBe("agent-alpha");
  });

  test("search finds agents by skill description", async () => {
    const fm = new FederationManager({
      peers: [`http://localhost:${PORT1}`, `http://localhost:${PORT2}`],
      healthIntervalMs: 60_000,
    });
    await fm.start();
    fm.stop();

    const results = fm.search("translation");
    expect(results.length).toBe(1);
    expect(results[0].card.name).toBe("agent-beta");
  });

  test("getAllSkills returns skills from all healthy agents", async () => {
    const fm = new FederationManager({
      peers: [`http://localhost:${PORT1}`, `http://localhost:${PORT2}`],
      healthIntervalMs: 60_000,
    });
    await fm.start();
    fm.stop();

    const skills = fm.getAllSkills();
    expect(skills.length).toBe(3); // 2 from alpha + 1 from beta
    expect(skills.map(s => s.skillId).sort()).toEqual(["alpha_index", "alpha_search", "beta_translate"]);
  });

  test("getSummary provides correct counts", async () => {
    const fm = new FederationManager({
      peers: [`http://localhost:${PORT1}`, `http://localhost:${PORT2}`],
      healthIntervalMs: 60_000,
    });
    await fm.start();
    fm.stop();

    const summary = fm.getSummary();
    expect(summary.total).toBe(2);
    expect(summary.healthy).toBe(2);
    expect(summary.unhealthy).toBe(0);
    expect(summary.totalSkills).toBe(3);
    expect(summary.agents.length).toBe(2);
  });

  test("handles unreachable peers gracefully", async () => {
    const fm = new FederationManager({
      peers: [`http://localhost:${PORT1}`, "http://localhost:19999"], // 19999 doesn't exist
      healthIntervalMs: 60_000,
      discoveryTimeoutMs: 1000,
    });
    await fm.start();
    fm.stop();

    expect(fm.getAgents().length).toBe(1);
    expect(fm.getAgents()[0].card.name).toBe("agent-alpha");
  });

  test("addPeer discovers a new peer dynamically", async () => {
    const fm = new FederationManager({
      peers: [`http://localhost:${PORT1}`],
      healthIntervalMs: 60_000,
    });
    await fm.start();
    expect(fm.getAgents().length).toBe(1);

    const added = await fm.addPeer(`http://localhost:${PORT2}`);
    expect(added).not.toBeNull();
    expect(added!.card.name).toBe("agent-beta");
    expect(fm.getAgents().length).toBe(2);
    fm.stop();
  });

  test("removePeer removes a known peer", async () => {
    const fm = new FederationManager({
      peers: [`http://localhost:${PORT1}`, `http://localhost:${PORT2}`],
      healthIntervalMs: 60_000,
    });
    await fm.start();
    expect(fm.getAgents().length).toBe(2);

    const removed = fm.removePeer(`http://localhost:${PORT1}`);
    expect(removed).toBe(true);
    expect(fm.getAgents().length).toBe(1);
    fm.stop();
  });

  test("latency is recorded on discovery", async () => {
    const fm = new FederationManager({
      peers: [`http://localhost:${PORT1}`],
      healthIntervalMs: 60_000,
    });
    await fm.start();
    fm.stop();

    const agent = fm.getAgents()[0];
    expect(agent.latencyMs).toBeGreaterThanOrEqual(0);
    expect(agent.latencyMs).toBeLessThan(5000);
  });
});

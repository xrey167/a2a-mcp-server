import { describe, test, expect, afterEach } from "bun:test";
import { createFrameworkWorker, createLangChainWorker, createCrewAIWorker } from "../adapters/langchain.js";
import type { FrameworkWorker } from "../adapters/langchain.js";

describe("Framework adapter", () => {
  let worker: FrameworkWorker | null = null;
  const PORT = 19181;

  afterEach(async () => {
    if (worker) {
      await worker.stop();
      worker = null;
    }
  });

  test("creates a worker with correct agent card", () => {
    worker = createFrameworkWorker({
      name: "test-framework",
      port: PORT,
      description: "A test framework adapter",
      skills: [
        { id: "test_run", name: "Run Test", description: "Run a test" },
        { id: "test_check", name: "Check", description: "Check results" },
      ],
      handler: async () => "ok",
    });

    expect(worker.card.name).toBe("test-framework-agent");
    expect(worker.card.url).toBe(`http://localhost:${PORT}`);
    expect(worker.card.skills.length).toBe(2);
    expect(worker.card.skills[0].id).toBe("test_run");
  });

  test("serves agent card at well-known URL", async () => {
    worker = createFrameworkWorker({
      name: "card-test",
      port: PORT,
      skills: [{ id: "s1", name: "S1", description: "Skill 1" }],
      handler: async () => "ok",
    });
    await worker.start();

    const res = await fetch(`http://localhost:${PORT}/.well-known/agent.json`);
    expect(res.ok).toBe(true);
    const card = await res.json();
    expect(card.name).toBe("card-test-agent");
    expect(card.skills.length).toBe(1);
  });

  test("health check returns status", async () => {
    worker = createFrameworkWorker({
      name: "health-test",
      port: PORT,
      skills: [{ id: "s1", name: "S1", description: "d" }],
      handler: async () => "ok",
    });
    await worker.start();

    const res = await fetch(`http://localhost:${PORT}/healthz`);
    expect(res.ok).toBe(true);
    const health = await res.json() as any;
    expect(health.status).toBe("ok");
    expect(health.agent).toBe("health-test-agent");
    expect(health.uptime).toBeGreaterThanOrEqual(0);
  });

  test("custom health check is used", async () => {
    worker = createFrameworkWorker({
      name: "custom-health",
      port: PORT,
      skills: [{ id: "s1", name: "S1", description: "d" }],
      handler: async () => "ok",
      healthCheck: async () => ({ gpu: true, model: "loaded" }),
    });
    await worker.start();

    const res = await fetch(`http://localhost:${PORT}/healthz`);
    const health = await res.json() as any;
    expect(health.gpu).toBe(true);
    expect(health.model).toBe("loaded");
  });

  test("handles A2A task with skill routing", async () => {
    worker = createFrameworkWorker({
      name: "skill-test",
      port: PORT,
      skills: [
        { id: "greet", name: "Greet", description: "Greet" },
        { id: "farewell", name: "Farewell", description: "Farewell" },
      ],
      handler: async (skillId, args, message) => {
        if (skillId === "greet") return `Hello, ${args.name ?? "world"}!`;
        if (skillId === "farewell") return `Goodbye, ${args.name ?? "world"}!`;
        return "unknown";
      },
    });
    await worker.start();

    const res = await fetch(`http://localhost:${PORT}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-1",
        method: "tasks/send",
        params: {
          id: "task-1",
          skillId: "greet",
          args: { name: "Alice" },
          message: { role: "user", parts: [{ kind: "text", text: "Hi", metadata: { skillId: "greet", args: { name: "Alice" } } }] },
        },
      }),
    });

    expect(res.ok).toBe(true);
    const result = await res.json() as any;
    expect(result.result.status.state).toBe("completed");
    expect(result.result.artifacts[0].parts[0].text).toBe("Hello, Alice!");
  });

  test("handles handler errors gracefully", async () => {
    worker = createFrameworkWorker({
      name: "error-test",
      port: PORT,
      skills: [{ id: "fail", name: "Fail", description: "Always fails" }],
      handler: async () => { throw new Error("something broke"); },
    });
    await worker.start();

    const res = await fetch(`http://localhost:${PORT}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-2",
        method: "tasks/send",
        params: {
          id: "task-2",
          message: { role: "user", parts: [{ kind: "text", text: "test", metadata: { skillId: "fail" } }] },
        },
      }),
    });

    expect(res.ok).toBe(true);
    const result = await res.json() as any;
    expect(result.result.status.state).toBe("failed");
    expect(result.result.status.message.parts[0].text).toContain("something broke");
  });

  test("createLangChainWorker is an alias for createFrameworkWorker", () => {
    expect(createLangChainWorker).toBe(createFrameworkWorker);
  });

  test("createCrewAIWorker is an alias for createFrameworkWorker", () => {
    expect(createCrewAIWorker).toBe(createFrameworkWorker);
  });

  test("defaults to first skill when none specified", async () => {
    worker = createFrameworkWorker({
      name: "default-skill",
      port: PORT,
      skills: [{ id: "default_action", name: "Default", description: "default" }],
      handler: async (skillId) => `ran: ${skillId}`,
    });
    await worker.start();

    const res = await fetch(`http://localhost:${PORT}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-3",
        method: "tasks/send",
        params: {
          id: "task-3",
          message: { role: "user", parts: [{ kind: "text", text: "hello" }] },
        },
      }),
    });

    const result = await res.json() as any;
    expect(result.result.status.state).toBe("completed");
    expect(result.result.artifacts[0].parts[0].text).toBe("ran: default_action");
  });
});

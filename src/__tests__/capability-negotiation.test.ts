import { describe, test, expect, beforeEach } from "bun:test";
import { registerCapability, negotiate, listCapabilities, getCapabilityStats, updateAgentHealth, resetCapabilities } from "../capability-negotiation.js";

beforeEach(() => resetCapabilities());

describe("Capability Negotiation", () => {
  test("register and list", () => {
    registerCapability("ask_claude", "ai-agent", { agentUrl: "http://localhost:8083", version: "2.0.0" });
    const caps = listCapabilities();
    expect(caps).toHaveLength(1);
    expect(caps[0].skillId).toBe("ask_claude");
    expect(caps[0].version).toBe("2.0.0");
  });

  test("negotiate picks best version", () => {
    registerCapability("ask_claude", "ai-agent-v1", { agentUrl: "http://localhost:8083", version: "1.0.0" });
    registerCapability("ask_claude", "ai-agent-v2", { agentUrl: "http://localhost:8084", version: "2.1.0" });
    const result = negotiate("ask_claude");
    expect(result.best?.agentName).toBe("ai-agent-v2");
    expect(result.candidates).toHaveLength(2);
  });

  test("negotiate filters by minVersion", () => {
    registerCapability("ask_claude", "agent-old", { agentUrl: "http://localhost:8083", version: "1.0.0" });
    registerCapability("ask_claude", "agent-new", { agentUrl: "http://localhost:8084", version: "2.0.0" });
    const result = negotiate("ask_claude", { minVersion: "2.0.0" });
    expect(result.candidates).toHaveLength(1);
    expect(result.best?.agentName).toBe("agent-new");
  });

  test("negotiate filters by required features", () => {
    registerCapability("fetch_url", "web-basic", { agentUrl: "http://localhost:8082", features: ["http"] });
    registerCapability("fetch_url", "web-advanced", { agentUrl: "http://localhost:8083", features: ["http", "streaming"] });
    const result = negotiate("fetch_url", { requiredFeatures: ["streaming"] });
    expect(result.candidates).toHaveLength(1);
    expect(result.best?.agentName).toBe("web-advanced");
  });

  test("negotiate considers health", () => {
    registerCapability("ask_claude", "healthy-agent", { agentUrl: "http://localhost:8083" });
    registerCapability("ask_claude", "unhealthy-agent", { agentUrl: "http://localhost:8084" });
    updateAgentHealth("unhealthy-agent", false);
    const result = negotiate("ask_claude", { healthAware: true });
    expect(result.best?.agentName).toBe("healthy-agent");
  });

  test("negotiate considers load", () => {
    const cap1 = registerCapability("ask_claude", "busy-agent", { agentUrl: "http://localhost:8083", maxConcurrency: 5 });
    cap1.activeCalls = 5; // at capacity
    registerCapability("ask_claude", "idle-agent", { agentUrl: "http://localhost:8084", maxConcurrency: 5 });
    const result = negotiate("ask_claude", { loadAware: true });
    expect(result.best?.agentName).toBe("idle-agent");
  });

  test("negotiate returns null for unknown skill", () => {
    const result = negotiate("nonexistent");
    expect(result.best).toBeNull();
    expect(result.candidates).toHaveLength(0);
  });

  test("priority bonus", () => {
    registerCapability("test_skill", "low-priority", { agentUrl: "http://localhost:8083", priority: 0 });
    registerCapability("test_skill", "high-priority", { agentUrl: "http://localhost:8084", priority: 5 });
    const result = negotiate("test_skill");
    expect(result.best?.agentName).toBe("high-priority");
  });

  test("stats track correctly", () => {
    registerCapability("a", "agent1", { agentUrl: "http://localhost:8083" });
    registerCapability("a", "agent2", { agentUrl: "http://localhost:8084" });
    registerCapability("b", "agent1", { agentUrl: "http://localhost:8083" });
    const stats = getCapabilityStats();
    expect(stats.totalSkills).toBe(2);
    expect(stats.totalCapabilities).toBe(3);
    expect(stats.skillsWithMultipleProviders).toBe(1);
  });
});

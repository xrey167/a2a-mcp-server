import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// We test the a2a module's sendTask and discoverAgent functions
// by mocking global fetch

describe("A2A helpers", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sendTask sends correct JSON-RPC payload", async () => {
    let capturedBody: any = null;

    globalThis.fetch = (async (url: any, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        result: {
          artifacts: [{ parts: [{ kind: "text", text: "ok" }] }],
        },
      }), { headers: { "Content-Type": "application/json" } });
    }) as any;

    const { sendTask } = await import("../a2a.js");
    const result = await sendTask("http://localhost:9999", {
      skillId: "test_skill",
      message: { role: "user", parts: [{ text: "hello" }] },
    });

    expect(result).toBe("ok");
    expect(capturedBody.jsonrpc).toBe("2.0");
    expect(capturedBody.method).toBe("tasks/send");
    expect(capturedBody.params.skillId).toBe("test_skill");
    expect(capturedBody.params.message.parts[0].text).toBe("hello");
  });

  test("sendTask throws on error response", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        error: { message: "skill not found" },
      }), { headers: { "Content-Type": "application/json" } });
    }) as any;

    const { sendTask } = await import("../a2a.js");
    expect(
      sendTask("http://localhost:9999", {
        message: { role: "user", parts: [{ text: "x" }] },
      })
    ).rejects.toThrow("skill not found");
  });

  test("discoverAgent fetches agent card", async () => {
    const mockCard = {
      name: "test-agent",
      description: "A test agent",
      url: "http://localhost:9999",
      version: "1.0.0",
      capabilities: { streaming: false },
      skills: [{ id: "test", name: "Test", description: "test" }],
    };

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify(mockCard), {
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const { discoverAgent } = await import("../a2a.js");
    const card = await discoverAgent("http://localhost:9999");
    expect(card.name).toBe("test-agent");
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("test");
  });
});

/**
 * Tests for ACP NDJSON transport layer.
 *
 * Run with: bun test src/__tests__/acp-transport.test.ts
 */

import { describe, test, expect } from "bun:test";
import { handlePossibleResponse } from "../acp-transport.js";

describe("handlePossibleResponse", () => {
  test("ignores non-objects", () => {
    expect(handlePossibleResponse(null)).toBe(false);
    expect(handlePossibleResponse("string")).toBe(false);
    expect(handlePossibleResponse(42)).toBe(false);
  });

  test("ignores requests (have method field)", () => {
    expect(handlePossibleResponse({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    })).toBe(false);
  });

  test("ignores notifications (no id)", () => {
    expect(handlePossibleResponse({
      jsonrpc: "2.0",
      method: "session/update",
    })).toBe(false);
  });

  test("ignores responses with unknown id", () => {
    expect(handlePossibleResponse({
      jsonrpc: "2.0",
      id: 999,
      result: "ok",
    })).toBe(false);
  });
});

describe("ACP type definitions", () => {
  test("content block types are valid", () => {
    const textBlock = { type: "text" as const, text: "hello" };
    const imageBlock = { type: "image" as const, data: "base64...", mimeType: "image/png" };
    const linkBlock = { type: "resource_link" as const, uri: "file:///tmp/test.ts" };

    expect(textBlock.type).toBe("text");
    expect(imageBlock.type).toBe("image");
    expect(linkBlock.type).toBe("resource_link");
  });

  test("session update types are valid", () => {
    const assistantMsg = {
      kind: "assistant_message" as const,
      content: [{ type: "text" as const, text: "hello" }],
    };
    const toolCall = {
      kind: "tool_call" as const,
      toolCallId: "test-id",
      title: "Running shell",
      operationKind: "execute" as const,
      status: "in_progress" as const,
    };
    const toolUpdate = {
      kind: "tool_call_update" as const,
      toolCallId: "test-id",
      status: "completed" as const,
    };

    expect(assistantMsg.kind).toBe("assistant_message");
    expect(toolCall.kind).toBe("tool_call");
    expect(toolUpdate.kind).toBe("tool_call_update");
  });
});

describe("JSON-RPC message format", () => {
  test("request format is valid", () => {
    const request = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "0.11.0",
        clientInfo: { name: "test", version: "1.0" },
      },
    };

    expect(request.jsonrpc).toBe("2.0");
    expect(request.method).toBe("initialize");
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
  });

  test("response format is valid", () => {
    const response = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: {
        protocolVersion: "0.11.0",
        agentInfo: { name: "a2a-mcp-bridge", version: "1.0.0" },
      },
    };

    expect(response.jsonrpc).toBe("2.0");
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  test("error response format is valid", () => {
    const errorResponse = {
      jsonrpc: "2.0" as const,
      id: 1,
      error: { code: -32601, message: "Method not found" },
    };

    expect(errorResponse.error.code).toBe(-32601);
    expect(JSON.parse(JSON.stringify(errorResponse))).toEqual(errorResponse);
  });

  test("NDJSON line format — each message is one line of JSON", () => {
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "0.11.0" } },
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "abc" } },
    ];

    for (const msg of messages) {
      const line = JSON.stringify(msg);
      expect(line).not.toContain("\n");
      expect(JSON.parse(line)).toEqual(msg);
    }
  });
});

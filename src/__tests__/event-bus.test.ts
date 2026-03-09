import { describe, test, expect, beforeEach } from "bun:test";
import { publish, subscribe, unsubscribe, replay, listSubscriptions, getDeadLetters, getEventBusStats, resetEventBus } from "../event-bus.js";

beforeEach(() => resetEventBus());

describe("Event Bus", () => {
  test("publish and subscribe", async () => {
    const received: any[] = [];
    subscribe("test.topic", (event) => { received.push(event); });
    await publish("test.topic", { hello: "world" });
    expect(received).toHaveLength(1);
    expect(received[0].topic).toBe("test.topic");
    expect(received[0].data).toEqual({ hello: "world" });
  });

  test("wildcard * matches one segment", async () => {
    const received: any[] = [];
    subscribe("agent.*.completed", (event) => { received.push(event); });
    await publish("agent.shell.completed", {});
    await publish("agent.web.completed", {});
    await publish("agent.shell.failed", {}); // should not match
    expect(received).toHaveLength(2);
  });

  test("wildcard # matches multiple segments", async () => {
    const received: any[] = [];
    subscribe("workflow.#", (event) => { received.push(event); });
    await publish("workflow.step.1.done", {});
    await publish("workflow.completed", {});
    expect(received).toHaveLength(2);
  });

  test("unsubscribe stops delivery", async () => {
    const received: any[] = [];
    const subId = subscribe("test.*", (event) => { received.push(event); });
    await publish("test.first", {});
    expect(received).toHaveLength(1);
    unsubscribe(subId);
    await publish("test.second", {});
    expect(received).toHaveLength(1);
  });

  test("replay returns matching events", async () => {
    await publish("log.info", { msg: "first" });
    await publish("log.error", { msg: "second" });
    await publish("log.info", { msg: "third" });
    const events = replay("log.info");
    expect(events).toHaveLength(2);
  });

  test("dead letters on handler error", async () => {
    subscribe("fail.topic", () => { throw new Error("boom"); });
    await publish("fail.topic", {});
    const dl = getDeadLetters();
    expect(dl).toHaveLength(1);
    expect(dl[0].error).toBe("boom");
  });

  test("filter matches event fields", async () => {
    const received: any[] = [];
    subscribe("events.*", (e) => { received.push(e); }, { filter: { "data.status": "completed" } });
    await publish("events.task", { status: "completed" });
    await publish("events.task", { status: "failed" }); // should not match
    expect(received).toHaveLength(1);
  });

  test("stats track correctly", async () => {
    subscribe("a.*", () => {});
    subscribe("b.#", () => {});
    await publish("a.test", {});
    const stats = getEventBusStats();
    expect(stats.subscriptions).toBe(2);
    expect(stats.historySize).toBe(1);
  });

  test("listSubscriptions returns active subs", () => {
    subscribe("x.y", () => {}, { name: "my-sub" });
    const subs = listSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].name).toBe("my-sub");
  });
});

import { describe, test, expect, afterEach } from "bun:test";
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  addMember,
  removeMember,
  updateWorkspace,
  getKnowledgeDir,
  deleteWorkspace,
  closeWorkspaceDb,
} from "../workspace.js";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const KNOWLEDGE_BASE_DIR = join(process.env.HOME ?? homedir(), ".a2a-mcp", "workspaces");

describe("workspace", () => {
  const testWsIds: string[] = [];

  afterEach(() => {
    // Clean up test workspaces from SQLite and remove any on-disk knowledge dirs.
    for (const id of testWsIds) {
      deleteWorkspace(id);
      const workspaceDir = join(KNOWLEDGE_BASE_DIR, id);
      const knowledgeDir = join(workspaceDir, "knowledge");
      if (existsSync(knowledgeDir)) rmSync(knowledgeDir, { recursive: true });
    }
    testWsIds.length = 0;
  });

  test("createWorkspace creates a new workspace", () => {
    const ws = createWorkspace("Test Team", "a2a_k_abc12", "Alice", { description: "A test workspace" });
    testWsIds.push(ws.id);
    expect(ws.id).toMatch(/^ws_/);
    expect(ws.name).toBe("Test Team");
    expect(ws.members).toHaveLength(1);
    expect(ws.members[0].role).toBe("owner");
    expect(ws.members[0].keyPrefix).toBe("a2a_k_abc12");
  });

  test("getWorkspace retrieves a workspace", () => {
    const ws = createWorkspace("Retrieve Test", "prefix1", "Bob");
    testWsIds.push(ws.id);
    const retrieved = getWorkspace(ws.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Retrieve Test");
  });

  test("getWorkspace returns null for nonexistent", () => {
    expect(getWorkspace("ws_nonexistent")).toBeNull();
  });

  test("listWorkspaces returns all workspaces", () => {
    const ws1 = createWorkspace("WS1", "p1", "Alice");
    const ws2 = createWorkspace("WS2", "p2", "Bob");
    testWsIds.push(ws1.id, ws2.id);
    const all = listWorkspaces();
    const ids = all.map(w => w.id);
    expect(ids).toContain(ws1.id);
    expect(ids).toContain(ws2.id);
  });

  test("addMember adds a new member", () => {
    const ws = createWorkspace("Add Test", "owner1", "Owner");
    testWsIds.push(ws.id);
    const updated = addMember(ws.id, "member1", "Charlie", "member");
    expect(updated!.members).toHaveLength(2);
    expect(updated!.members[1].name).toBe("Charlie");
    expect(updated!.members[1].role).toBe("member");
  });

  test("addMember is idempotent", () => {
    const ws = createWorkspace("Idempotent", "owner1", "Owner");
    testWsIds.push(ws.id);
    addMember(ws.id, "member1", "Charlie");
    const again = addMember(ws.id, "member1", "Charlie");
    expect(again!.members).toHaveLength(2);
  });

  test("removeMember removes a member", () => {
    const ws = createWorkspace("Remove Test", "owner1", "Owner");
    testWsIds.push(ws.id);
    addMember(ws.id, "member1", "Charlie");
    const updated = removeMember(ws.id, "member1");
    expect(updated!.members).toHaveLength(1);
  });

  test("updateWorkspace updates settings", () => {
    const ws = createWorkspace("Update Test", "owner1", "Owner");
    testWsIds.push(ws.id);
    const updated = updateWorkspace(ws.id, {
      name: "Renamed",
      env: { FOO: "bar" },
      allowedSkills: ["delegate"],
    });
    expect(updated!.name).toBe("Renamed");
    expect(updated!.env).toEqual({ FOO: "bar" });
    expect(updated!.allowedSkills).toEqual(["delegate"]);
  });

  test("updateWorkspace ignores undefined fields, preserves existing values", () => {
    const ws = createWorkspace("Preserve Test", "owner1", "Owner", { description: "original" });
    testWsIds.push(ws.id);
    // Pass undefined for name — should NOT overwrite the existing name
    const updated = updateWorkspace(ws.id, {
      name: undefined,
      description: "updated",
    });
    expect(updated!.name).toBe("Preserve Test");
    expect(updated!.description).toBe("updated");
  });

  test("getKnowledgeDir creates knowledge directory", () => {
    const ws = createWorkspace("Knowledge Test", "owner1", "Owner");
    testWsIds.push(ws.id);
    const dir = getKnowledgeDir(ws.id);
    expect(existsSync(dir)).toBe(true);
    expect(dir).toContain("knowledge");
  });

  test("getKnowledgeDir rejects path traversal in workspaceId", () => {
    expect(() => getKnowledgeDir("../../etc/passwd")).toThrow("Invalid workspace ID");
    expect(() => getKnowledgeDir("ws_../../evil")).toThrow("Invalid workspace ID");
    expect(() => getKnowledgeDir("../sibling")).toThrow("Invalid workspace ID");
    expect(() => getKnowledgeDir("ws_UPPERCASE1")).toThrow("Invalid workspace ID");
    expect(() => getKnowledgeDir("ws_abc; rm -rf /")).toThrow("Invalid workspace ID");
  });
});

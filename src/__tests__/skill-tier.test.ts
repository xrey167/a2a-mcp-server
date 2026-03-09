import { describe, test, expect, beforeEach } from "bun:test";
import { isSkillLicensed, getSkillTier, getSkillsByTier, getLicenseInfo, resetLicense } from "../skill-tier.js";

describe("skill-tier", () => {
  beforeEach(() => {
    resetLicense();
    // Ensure no license env var interferes
    delete process.env.A2A_LICENSE_KEY;
  });

  test("free skills are always licensed", () => {
    expect(isSkillLicensed("delegate")).toBe(true);
    expect(isSkillLicensed("list_agents")).toBe(true);
    expect(isSkillLicensed("remember")).toBe(true);
    expect(isSkillLicensed("cache_stats")).toBe(true);
  });

  test("pro skills are not licensed on free tier", () => {
    expect(isSkillLicensed("workflow_execute")).toBe(false);
    expect(isSkillLicensed("collaborate")).toBe(false);
    expect(isSkillLicensed("factory_workflow")).toBe(false);
  });

  test("enterprise skills are not licensed on free tier", () => {
    expect(isSkillLicensed("register_webhook")).toBe(false);
    expect(isSkillLicensed("list_traces")).toBe(false);
    expect(isSkillLicensed("audit_query")).toBe(false);
    expect(isSkillLicensed("audit_stats")).toBe(false);
    expect(isSkillLicensed("workspace_manage")).toBe(false);
  });

  test("pro license unlocks pro skills", () => {
    process.env.A2A_LICENSE_KEY = Buffer.from(JSON.stringify({ tier: "pro" })).toString("base64");
    resetLicense();
    expect(isSkillLicensed("workflow_execute")).toBe(true);
    expect(isSkillLicensed("collaborate")).toBe(true);
    // But not enterprise
    expect(isSkillLicensed("register_webhook")).toBe(false);
  });

  test("enterprise license unlocks everything", () => {
    process.env.A2A_LICENSE_KEY = Buffer.from(JSON.stringify({ tier: "enterprise" })).toString("base64");
    resetLicense();
    expect(isSkillLicensed("workflow_execute")).toBe(true);
    expect(isSkillLicensed("register_webhook")).toBe(true);
    expect(isSkillLicensed("list_traces")).toBe(true);
    expect(isSkillLicensed("audit_stats")).toBe(true);
    expect(isSkillLicensed("workspace_manage")).toBe(true);
  });

  test("expired license falls back to free", () => {
    process.env.A2A_LICENSE_KEY = Buffer.from(JSON.stringify({
      tier: "enterprise",
      expiresAt: Date.now() - 86400_000, // expired yesterday
    })).toString("base64");
    resetLicense();
    expect(isSkillLicensed("delegate")).toBe(true);
    expect(isSkillLicensed("workflow_execute")).toBe(false);
  });

  test("getSkillTier returns correct tiers", () => {
    expect(getSkillTier("delegate")).toBe("free");
    expect(getSkillTier("workflow_execute")).toBe("pro");
    expect(getSkillTier("register_webhook")).toBe("enterprise");
    expect(getSkillTier("audit_stats")).toBe("enterprise");
    expect(getSkillTier("workspace_manage")).toBe("enterprise");
    expect(getSkillTier("unknown_skill")).toBe("free"); // default
  });

  test("getSkillsByTier returns grouped skills", () => {
    const tiers = getSkillsByTier();
    expect(tiers.free.length).toBeGreaterThan(0);
    expect(tiers.pro.length).toBeGreaterThan(0);
    expect(tiers.enterprise.length).toBeGreaterThan(0);
    expect(tiers.free).toContain("delegate");
    expect(tiers.pro).toContain("workflow_execute");
    expect(tiers.enterprise).toContain("register_webhook");
  });

  test("getLicenseInfo returns safe display info", () => {
    const info = getLicenseInfo();
    expect(info.tier).toBe("free");
    expect(info.expired).toBe(false);
  });
});

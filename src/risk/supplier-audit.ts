/**
 * Supplier Audit Checklist Generator
 *
 * Generates audit checklists tailored to the supplier's risk profile.
 * Pre-populates data from ERP (vendor health, certifications, open issues).
 */

import type { RiskScore, VendorHealthScore } from "../erp/types.js";

function log(msg: string) {
  process.stderr.write(`[supplier-audit] ${msg}\n`);
}

export interface AuditItem {
  id: string;
  question: string;
  type: "yes_no" | "score_1_5" | "text" | "evidence_required";
  standard: string;
  prePopulated?: string;
  previousResult?: string;
}

export interface AuditSection {
  id: string;
  name: string;
  weight: number;
  required: boolean;
  items: AuditItem[];
}

export interface AuditVendorProfile {
  healthScore: number;
  deliveryPerformance: number;
  qualityRate: number;
  openComplaints: number;
  lastAuditDate: string | null;
  certifications: string[];
  componentsCritical: number;
  singleSourceItems: string[];
  esgRating: string | null;
}

export interface AuditChecklist {
  vendorId: string;
  vendorName: string;
  auditType: "full" | "focused" | "re-audit";
  riskProfile: "high" | "medium" | "low";
  sections: AuditSection[];
  vendorProfile: AuditVendorProfile;
  generatedAt: string;
}

export function generateAuditChecklist(
  vendorId: string,
  vendorName: string,
  riskScore: RiskScore,
  vendorHealth: VendorHealthScore,
  options?: { auditType?: "full" | "focused" | "re-audit"; standards?: string[]; esgRating?: string; singleSourceItems?: string[] },
): AuditChecklist {
  const riskProfile = riskScore.overallScore >= 60 ? "high" : riskScore.overallScore >= 30 ? "medium" : "low";
  const auditType = options?.auditType ?? (riskProfile === "high" ? "full" : "focused");

  const sections: AuditSection[] = [];

  // Section 1: Quality Management System (always required)
  sections.push({
    id: "qms",
    name: "Quality Management System",
    weight: riskProfile === "high" ? 25 : 20,
    required: true,
    items: [
      { id: "qms-1", question: "Is a QMS certified to ISO 9001:2015 or equivalent in place?", type: "yes_no", standard: "ISO 9001:2015", prePopulated: vendorHealth.flags.includes("ISO_9001") ? "Yes" : undefined },
      { id: "qms-2", question: "Are internal audits conducted at planned intervals?", type: "yes_no", standard: "ISO 9001:2015 §9.2" },
      { id: "qms-3", question: "Is there a documented corrective action process?", type: "yes_no", standard: "ISO 9001:2015 §10.2" },
      { id: "qms-4", question: "Rate the maturity of process documentation (1=minimal, 5=excellent)", type: "score_1_5", standard: "ISO 9001:2015 §7.5" },
      ...(riskProfile === "high" ? [
        { id: "qms-5", question: "Is IATF 16949 certification maintained?", type: "yes_no" as const, standard: "IATF 16949:2016" },
        { id: "qms-6", question: "Provide evidence of management review outputs", type: "evidence_required" as const, standard: "ISO 9001:2015 §9.3" },
      ] : []),
    ],
  });

  // Section 2: Delivery Performance (always required)
  sections.push({
    id: "delivery",
    name: "Delivery Performance",
    weight: 20,
    required: true,
    items: [
      { id: "del-1", question: "On-time delivery rate over last 12 months?", type: "text", standard: "KPI", prePopulated: `${vendorHealth.onTimeDeliveryPct}%` },
      { id: "del-2", question: "Average lead time variance (days)?", type: "text", standard: "KPI", prePopulated: `${vendorHealth.avgLeadTimeVarianceDays} days` },
      { id: "del-3", question: "Is there a capacity planning process?", type: "yes_no", standard: "Best Practice" },
      { id: "del-4", question: "Rate supply chain visibility (1=none, 5=real-time)", type: "score_1_5", standard: "Best Practice" },
    ],
  });

  // Section 3: Financial Strength (medium/high risk)
  if (riskProfile !== "low") {
    sections.push({
      id: "financial",
      name: "Financial Strength",
      weight: riskProfile === "high" ? 15 : 10,
      required: riskProfile === "high",
      items: [
        { id: "fin-1", question: "Provide latest audited financial statements", type: "evidence_required", standard: "Due Diligence" },
        { id: "fin-2", question: "Current ratio (current assets / current liabilities)?", type: "text", standard: "Financial Analysis" },
        { id: "fin-3", question: "Is the company profitable over the last 3 years?", type: "yes_no", standard: "Financial Analysis" },
        ...(riskProfile === "high" ? [
          { id: "fin-4", question: "Debt-to-equity ratio?", type: "text" as const, standard: "Financial Analysis" },
          { id: "fin-5", question: "Credit rating (if available)?", type: "text" as const, standard: "Financial Analysis" },
        ] : []),
      ],
    });
  }

  // Section 4: Capacity Reserve (medium/high risk)
  if (riskProfile !== "low") {
    sections.push({
      id: "capacity",
      name: "Capacity Reserve",
      weight: 10,
      required: riskProfile === "high",
      items: [
        { id: "cap-1", question: "Current capacity utilization rate?", type: "text", standard: "Best Practice" },
        { id: "cap-2", question: "Can capacity be increased by 20% within 4 weeks?", type: "yes_no", standard: "Best Practice" },
        { id: "cap-3", question: "Are key machines/tools redundant?", type: "yes_no", standard: "Best Practice" },
      ],
    });
  }

  // Section 5: Sub-Supplier Management (high risk only)
  if (riskProfile === "high") {
    sections.push({
      id: "sub-suppliers",
      name: "Sub-Supplier Management",
      weight: 10,
      required: true,
      items: [
        { id: "sub-1", question: "Is there a documented sub-supplier qualification process?", type: "yes_no", standard: "ISO 9001:2015 §8.4" },
        { id: "sub-2", question: "Are critical sub-suppliers regularly audited?", type: "yes_no", standard: "Best Practice" },
        { id: "sub-3", question: "List single-source sub-suppliers", type: "text", standard: "Risk Management" },
        { id: "sub-4", question: "Is there a sub-supplier contingency plan?", type: "yes_no", standard: "Best Practice" },
      ],
    });
  }

  // Section 6: Business Continuity (high risk only)
  if (riskProfile === "high") {
    sections.push({
      id: "bcp",
      name: "Business Continuity Planning",
      weight: 10,
      required: true,
      items: [
        { id: "bcp-1", question: "Is a Business Continuity Plan documented and tested?", type: "yes_no", standard: "ISO 22301" },
        { id: "bcp-2", question: "RTO (Recovery Time Objective) for critical processes?", type: "text", standard: "ISO 22301" },
        { id: "bcp-3", question: "Is there disaster recovery infrastructure?", type: "yes_no", standard: "Best Practice" },
        { id: "bcp-4", question: "Provide evidence of last BCP test", type: "evidence_required", standard: "ISO 22301" },
      ],
    });
  }

  // Section 7: ESG & Sustainability (medium/high risk)
  if (riskProfile !== "low") {
    sections.push({
      id: "esg",
      name: "ESG & Sustainability",
      weight: riskProfile === "high" ? 15 : 10,
      required: true,
      items: [
        { id: "esg-1", question: "Is there an environmental management system (ISO 14001)?", type: "yes_no", standard: "ISO 14001:2015" },
        { id: "esg-2", question: "Are Scope 1/2 emissions measured and reported?", type: "yes_no", standard: "GHG Protocol" },
        { id: "esg-3", question: "Is there a code of conduct covering labor rights?", type: "yes_no", standard: "ILO Core Conventions" },
        { id: "esg-4", question: "Rate ESG maturity (1=none, 5=integrated)", type: "score_1_5", standard: "CSRD/LkSG", prePopulated: options?.esgRating ?? undefined },
      ],
    });
  }

  // Section 8: IT Security (high risk only)
  if (riskProfile === "high") {
    sections.push({
      id: "it-security",
      name: "IT Security",
      weight: 5,
      required: false,
      items: [
        { id: "it-1", question: "Is ISO 27001 or equivalent certification in place?", type: "yes_no", standard: "ISO 27001" },
        { id: "it-2", question: "Are cybersecurity incident response procedures documented?", type: "yes_no", standard: "NIST CSF" },
        { id: "it-3", question: "Is data exchanged via encrypted channels?", type: "yes_no", standard: "Best Practice" },
      ],
    });
  }

  const checklist: AuditChecklist = {
    vendorId,
    vendorName,
    auditType,
    riskProfile,
    sections,
    vendorProfile: {
      healthScore: vendorHealth.overallScore,
      deliveryPerformance: vendorHealth.onTimeDeliveryPct,
      qualityRate: 100 - (riskScore.dimensions.quality ?? 0),
      openComplaints: 0,
      lastAuditDate: null,
      certifications: vendorHealth.flags.filter((f) => f.startsWith("ISO") || f.startsWith("IATF")),
      componentsCritical: 0,
      singleSourceItems: options?.singleSourceItems ?? [],
      esgRating: options?.esgRating ?? null,
    },
    generatedAt: new Date().toISOString(),
  };

  log(`generated ${auditType} audit checklist for ${vendorName} (risk: ${riskProfile}, ${sections.length} sections)`);
  return checklist;
}

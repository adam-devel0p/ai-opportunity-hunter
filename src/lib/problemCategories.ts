/**
 * Problem category seed list (spec §25). Inspiration only, fed into the Opportunity Analysis
 * Agent's prompt (Phase 6) — `opportunities.problemCategory` stores free text and is never
 * constrained to this list (spec §25: "Claude must remain capable of discovering novel problems
 * outside the predefined categories").
 */
export const PROBLEM_CATEGORY_SEED_LIST = [
  "lead qualification",
  "customer enquiry handling",
  "document processing",
  "customer intake",
  "support automation",
  "booking",
  "scheduling",
  "quote generation",
  "sales follow-up",
  "email classification/routing",
  "reporting",
  "invoice processing",
  "reconciliation",
  "CRM data entry",
  "candidate intake",
  "candidate screening support",
  "knowledge retrieval",
  "internal search",
  "onboarding",
  "compliance paperwork",
  "content transformation",
  "translation",
  "data extraction",
  "customer self-service",
  "maintenance request routing",
  "order handling",
  "inventory/admin workflows",
  "review/reputation workflows",
  "repetitive internal communication",
] as const;

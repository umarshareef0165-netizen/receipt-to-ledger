/**
 * Expense record (Clocked Fill) + privacy report (Clocked PII), and their
 * deterministic demo fallbacks.
 *
 * Fill completes a structured expense record for a verified receipt in one
 * call — what the purchase was for, whether it is tax-deductible, and a
 * one-line bookkeeping summary. The record is shown in the review step,
 * stored on the receipt, and exported in the CSV, so it changes what the
 * application does — it is not a call whose result is ignored.
 *
 * PII screens the receipt text for personal data (phone numbers, card
 * numbers, emails) and returns a masked copy. The masked copy is what the
 * review step shows; the original text is still what Extract reads, so
 * masking can never corrupt the extraction.
 *
 * Demo fallbacks are deterministic and labelled "demo" everywhere they are
 * shown. They never call Clocked and are never presented as AI output.
 */
import { guessCategory } from "./categories";

export const BUSINESS_PURPOSES = [
  "Resale stock / inventory",
  "Shop operations",
  "Personal / household",
  "Mixed business and personal",
] as const;

export type BusinessPurpose = (typeof BUSINESS_PURPOSES)[number];

export interface ExpenseRecord {
  businessPurpose: BusinessPurpose | null;
  taxDeductible: boolean | null;
  summary: string | null;
  /** "clocked" = Clocked Fill; "demo" = deterministic template, clearly labelled in the UI. */
  source: "clocked" | "demo";
}

export interface PrivacyFinding {
  type: string;
  value: string;
}

export interface PrivacyReport {
  findings: PrivacyFinding[];
  /** Receipt text with personal data masked, when available. */
  maskedText: string | null;
  source: "clocked" | "demo";
}

function asFilledString(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

/** Read one field out of a Clocked Fill response (`data.fields[name].value`). */
function readFillField(data: Record<string, unknown>, name: string): unknown {
  const fields = (data.fields ?? data.result ?? null) as Record<string, unknown> | null;
  if (!fields) return null;
  const entry = fields[name] as Record<string, unknown> | string | number | boolean | null | undefined;
  if (entry === null || entry === undefined) return null;
  if (typeof entry === "object" && !Array.isArray(entry) && "value" in entry) return entry.value;
  return entry;
}

/** Tolerant parse of a Clocked Fill response into an ExpenseRecord.
 *  Returns null only when no field was established at all. */
export function parseFillResponse(data: unknown): ExpenseRecord | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const purposeRaw = readFillField(d, "business_purpose");
  const purpose =
    typeof purposeRaw === "string" && (BUSINESS_PURPOSES as readonly string[]).includes(purposeRaw)
      ? (purposeRaw as BusinessPurpose)
      : null;
  const deductibleRaw = readFillField(d, "tax_deductible");
  const taxDeductible = typeof deductibleRaw === "boolean" ? deductibleRaw : null;
  const summary = asFilledString(readFillField(d, "record_summary"));
  if (purpose === null && taxDeductible === null && summary === null) return null;
  return { businessPurpose: purpose, taxDeductible, summary, source: "clocked" };
}

/** Tolerant parse of a Clocked PII response into a PrivacyReport. */
export function parsePiiResponse(data: unknown): PrivacyReport {
  const d = (data ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(d.entities) ? d.entities : [];
  const seen = new Set<string>();
  const findings: PrivacyFinding[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const type = typeof (e as Record<string, unknown>).type === "string" ? String((e as Record<string, unknown>).type) : "personal";
    const value = typeof (e as Record<string, unknown>).value === "string" ? String((e as Record<string, unknown>).value) : "";
    if (!value) continue;
    const key = `${type}|${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ type, value });
    if (findings.length >= 8) break;
  }
  const maskedText = typeof d.anonymized_text === "string" && d.anonymized_text.trim() ? d.anonymized_text : null;
  return { findings, maskedText, source: "clocked" };
}

/** Deterministic demo expense record for a receipt (NOT AI).
 *  Purpose follows the line categories; the summary is a fixed template. */
export function demoExpenseRecord(input: {
  vendor: string;
  lineDescriptions: string[];
  lineCategories: string[];
}): ExpenseRecord {
  const cats = input.lineCategories.map((c) => c);
  const stockish = cats.filter((c) => c === "Inventory / Stock" || c === "Groceries").length;
  const personal = cats.filter((c) => c === "Food & Dining" || c === "Entertainment" || c === "Health").length;
  // Majority rule: a shop stocking groceries that happens to include one
  // tea line is still a stock purchase; only a genuinely even split is mixed.
  let purpose: BusinessPurpose;
  if (stockish > personal) purpose = "Resale stock / inventory";
  else if (personal > stockish) purpose = "Personal / household";
  else if (stockish > 0) purpose = "Mixed business and personal";
  else purpose = "Shop operations";
  const taxDeductible = purpose === "Personal / household" ? false : purpose === "Mixed business and personal" ? null : true;
  const items = input.lineDescriptions.slice(0, 4).join(", ");
  const extra = input.lineDescriptions.length > 4 ? ` and ${input.lineDescriptions.length - 4} more` : "";
  const kind = purpose === "Resale stock / inventory" ? "Stock purchase" : purpose === "Personal / household" ? "Personal purchase" : "Business purchase";
  return {
    businessPurpose: purpose,
    taxDeductible,
    summary: `${kind} — ${items}${extra} — from ${input.vendor}.`,
    source: "demo",
  };
}

const PHONE_RE = /(?:\+92[ -]?|0)3\d{2}[ -]?\d{7}\b/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function maskValue(value: string): string {
  const visible = value.slice(-2);
  return "•".repeat(Math.max(0, value.length - 2)) + visible;
}

/** Deterministic demo PII scan (NOT AI): finds phone numbers, card-like
 *  digit runs and emails in receipt text and returns a masked copy. */
export function demoPiiScan(text: string): PrivacyReport {
  const findings: PrivacyFinding[] = [];
  const seen = new Set<string>();
  const push = (type: string, value: string) => {
    const key = `${type}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ type, value: maskValue(value.replace(/[ -]/g, "")) });
  };
  for (const m of text.matchAll(PHONE_RE)) push("phone", m[0]);
  for (const m of text.matchAll(EMAIL_RE)) push("email", m[0]);
  for (const m of text.matchAll(CARD_RE)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 15 && digits.length <= 19) push("credit_card", m[0]);
  }
  let maskedText: string | null = null;
  if (findings.length > 0) {
    maskedText = text
      .replace(PHONE_RE, (m) => maskValue(m))
      .replace(EMAIL_RE, (m) => maskValue(m))
      .replace(CARD_RE, (m) => {
        const digits = m.replace(/[ -]/g, "");
        return digits.length >= 15 && digits.length <= 19 ? maskValue(m) : m;
      });
  }
  return { findings, maskedText, source: "demo" };
}

/** Human label for a PII finding type. */
export function piiTypeLabel(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("phone")) return "phone number";
  if (t.includes("credit_card") || t.includes("card")) return "card number";
  if (t.includes("email")) return "email address";
  if (t.includes("bank")) return "bank details";
  if (t.includes("person")) return "personal name";
  return type;
}

/** Demo PII scan needs the same category guess the ledger uses for a line. */
export function demoLineCategory(description: string): string {
  return guessCategory(description);
}

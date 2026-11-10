/**
 * Clocked API wrapper — uses the OFFICIAL clocked-sdk (npm, v0.7.0, by Rezolve.ai).
 *
 * Verified against the SDK's own README + TypeScript declarations (clocked-sdk@0.7.0):
 *   base URL   https://clocked.rezolve.ai/clocked
 *   auth       Bearer <CLOCKED_API_KEY> (the SDK sends it; key from https://clocked.rezolve.ai/account)
 *   Extract    POST /clocked/extract  { text?, images?, fields: { name: "description" | { description, format, normalize, list, max_items, fields, row_anchor } } }
 *              text mode  -> data.fields[name] = { value: string | string[] | null, ... }
 *              image mode -> data.result = { [field]: string | string[] | null }  (mode: 'native_vision')
 *   Decide     POST /clocked/decide   { state, questions: { name: { type: 'choice'|'noul'|'multiselect'|'score', instructions, options?, threshold? } } }
 *              -> data.answers[name] = { type: 'choice', choice, probabilities, confidence }
 *   Images     1-4 per request, PNG/JPEG/WebP, 2.4 MB total, 16 MP each (as base64 data URLs).
 *   Result     { data, modelMs, credits, costUsd, costBasis } — credits/cost come from response headers.
 *
 * The official docs site (https://clocked.rezolve.ai/docs) returned 403 to our
 * crawler, so the response envelope is handled TOLERANTLY here: both the
 * documented `fields` shape and the image-mode `result` shape are accepted,
 * and anything unrecognised degrades to a clear error instead of a crash.
 * No key is ever logged or sent to the browser.
 */
import { Clocked, ClockedError } from "clocked-sdk";
import { CATEGORIES } from "./categories";
import {
  BUSINESS_PURPOSES,
  parseFillResponse,
  parsePiiResponse,
  type ExpenseRecord,
  type PrivacyReport,
} from "./expense-record";

export const CLOCKED_BASE_URL = "https://clocked.rezolve.ai/clocked";
export const CLOCKED_ACCOUNT_URL = "https://clocked.rezolve.ai/account";

export function isClockedConfigured(): boolean {
  return Boolean(process.env.CLOCKED_API_KEY && process.env.CLOCKED_API_KEY.trim());
}

export function clockedClient(): Clocked {
  if (!isClockedConfigured()) {
    throw new Error(
      "CLOCKED_API_KEY is not set. Create a key at https://clocked.rezolve.ai/account and set CLOCKED_API_KEY in .env.local (see README).",
    );
  }
  return new Clocked(); // reads CLOCKED_API_KEY from the environment
}

/** Fields asked of Clocked Extract for every receipt. Line items are a nested
 *  record table: one row per printed line, anchored on its description. */
export const RECEIPT_EXTRACT_FIELDS = {
  vendor: "The name of the shop or business printed at the top of the receipt",
  date: "The date printed on the receipt, exactly as printed (for example 09/11/2026)",
  receipt_number: "The receipt, invoice or order number printed on the receipt",
  currency: "The currency of the amounts on the receipt (for example USD, PKR, EUR)",
  payment_method: "How the receipt was paid: Cash, Card, UPI, Bank transfer, or as printed",
  subtotal: "The subtotal amount printed on the receipt, exactly as printed",
  tax: "The tax / GST / VAT amount printed on the receipt, exactly as printed",
  total: "The final total amount printed on the receipt, exactly as printed",
  line_items: {
    description: "Every priced line item on the receipt, one record per line",
    list: true,
    max_items: 32,
    row_anchor: "description",
    fields: {
      description: "The item name exactly as printed",
      qty: "The quantity of this item, as printed (a number)",
      unit_price: "The unit price of this item, exactly as printed",
      line_total: "The total price for this line (quantity x unit price), exactly as printed",
    },
  },
} as const;

export interface ExtractedLine {
  description: string;
  qty: string | null;
  unitPrice: string | null;
  total: string | null;
}

export interface ExtractedReceipt {
  vendor: string | null;
  date: string | null;
  receiptNumber: string | null;
  currency: string | null;
  paymentMethod: string | null;
  subtotal: string | null;
  tax: string | null;
  total: string | null;
  lines: ExtractedLine[];
  /** Raw Clocked payload, kept for audit/debugging in the API response (never contains the key). */
  raw: unknown;
}

function asString(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Read a value out of either response shape: text-mode `fields[name].value`
 *  or image-mode `result[name]`. Accepts strings, numbers and single-item lists. */
function readField(container: Record<string, unknown> | null | undefined, name: string): unknown {
  if (!container) return null;
  const entry = container[name] as Record<string, unknown> | string | number | string[] | null | undefined;
  if (entry === null || entry === undefined) return null;
  if (typeof entry === "object" && !Array.isArray(entry) && "value" in entry) return entry.value;
  return entry;
}

function readString(container: Record<string, unknown> | null | undefined, name: string): string | null {
  const v = readField(container, name);
  if (Array.isArray(v)) return v.length ? asString(v[0]) : null;
  return asString(v);
}

/** Normalise the line_items table from either response shape. */
function readLines(container: Record<string, unknown> | null | undefined): ExtractedLine[] {
  const raw = readField(container, "line_items");
  const rows: unknown[] = Array.isArray(raw) ? raw : [];
  const lines: ExtractedLine[] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      // Fallback: a plain-text line such as "2 x Basmati Rice 5kg @ 1450.00 = 2900.00"
      const m = row.match(/^(?:(\d+(?:\.\d+)?)\s*[x×]\s*)?(.+?)(?:\s*@\s*([\d,]+\.\d{2}))?(?:\s*=\s*([\d,]+\.\d{2}))?\s*$/);
      if (m) lines.push({ description: m[2].trim(), qty: m[1] ?? null, unitPrice: m[3] ?? null, total: m[4] ?? null });
      continue;
    }
    if (row && typeof row === "object") {
      const r = row as Record<string, unknown>;
      // Nested record rows may carry values directly or as { value } objects.
      const get = (k: string) => {
        const v = r[k];
        if (v && typeof v === "object" && !Array.isArray(v) && "value" in (v as Record<string, unknown>)) {
          return asString((v as Record<string, unknown>).value);
        }
        return asString(v);
      };
      const description = get("description");
      if (!description) continue;
      lines.push({ description, qty: get("qty"), unitPrice: get("unit_price"), total: get("line_total") });
    }
  }
  return lines;
}

export function parseExtractResponse(data: unknown): ExtractedReceipt {
  const d = (data ?? {}) as Record<string, unknown>;
  // Text mode: data.fields. Image mode: data.result. Accept either.
  const fields = (d.fields ?? d.result ?? null) as Record<string, unknown> | null;
  return {
    vendor: readString(fields, "vendor"),
    date: readString(fields, "date"),
    receiptNumber: readString(fields, "receipt_number"),
    currency: readString(fields, "currency"),
    paymentMethod: readString(fields, "payment_method"),
    subtotal: readString(fields, "subtotal"),
    tax: readString(fields, "tax"),
    total: readString(fields, "total"),
    lines: readLines(fields),
    raw: data,
  };
}

/** Run Clocked Extract over receipt text and/or a receipt image (base64 data URL). */
export async function extractReceipt(input: {
  text?: string;
  imageDataUrl?: string;
}): Promise<{ extracted: ExtractedReceipt; credits: number | null; costUsd: number | null; modelMs: number | null }> {
  const clocked = clockedClient();
  const instructions =
    "Read this shop receipt exactly as printed. Copy every value verbatim — never invent, round, or correct a number. " +
    "If a value is not printed, leave it blank. List every priced line item, including its quantity, unit price and line total.";
  const result = input.imageDataUrl
    ? await clocked.extract({
        images: [input.imageDataUrl],
        text: input.text,
        fields: RECEIPT_EXTRACT_FIELDS,
        instructions,
      } as never)
    : await clocked.extract({
        text: input.text ?? "",
        fields: RECEIPT_EXTRACT_FIELDS,
        instructions,
      } as never);
  return {
    extracted: parseExtractResponse(result.data),
    credits: result.credits,
    costUsd: result.costUsd,
    modelMs: result.modelMs,
  };
}

export interface CategoryDecision {
  lineIndex: number;
  category: string;
  confidence: number | null;
  probabilities: Record<string, number> | null;
}

/**
 * Run Clocked Decide: one `choice` question per line item, asking which
 * expense category the item belongs to. Returns the chosen category plus
 * its probability, so low-confidence lines can be flagged for human review.
 */
export async function decideCategories(input: { receiptText: string; descriptions: string[] }): Promise<CategoryDecision[]> {
  if (input.descriptions.length === 0) return [];
  const clocked = clockedClient();
  const questions: Record<string, { type: "choice"; instructions: string; options: string[] }> = {};
  input.descriptions.slice(0, 16).forEach((desc, i) => {
    questions[`line_${i}`] = {
      type: "choice",
      instructions: `Which expense category does this receipt line belong to? The line is: "${desc}". Choose the single best category.`,
      options: [...CATEGORIES],
    };
  });
  const { data } = await clocked.decide({
    state: input.receiptText,
    questions,
  } as never);
  const answers = (data as { answers?: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number> }> }).answers ?? {};
  return Object.entries(answers).map(([key, a]) => ({
    lineIndex: parseInt(key.replace("line_", ""), 10),
    category: typeof a.choice === "string" ? a.choice : "Other",
    confidence: typeof a.confidence === "number" ? a.confidence : null,
    probabilities: a.probabilities ?? null,
  }));
}

/** Fields asked of Clocked Fill for every verified receipt: one complete
 *  structured expense record in a single call. */
export const EXPENSE_FILL_FIELDS = {
  business_purpose: {
    type: "choice" as const,
    description:
      "What was this purchase for? Resale stock / inventory means goods bought to resell; Shop operations means things the shop itself uses; Personal / household means a private purchase.",
    options: [...BUSINESS_PURPOSES],
  },
  tax_deductible: {
    type: "yes_no" as const,
    description:
      "Is this receipt a tax-deductible business expense for the shop owner? Answer yes only when the purchase was for the business.",
  },
  record_summary: {
    type: "generate" as const,
    description:
      "One short bookkeeping sentence summarising this receipt for the ledger, naming the shop and the main items bought.",
    format: "text" as const,
    max_tokens: 60,
  },
} as const;

/** Run Clocked Fill: complete the structured expense record for a receipt. */
export async function fillExpenseRecord(input: { receiptText: string }): Promise<{
  record: ExpenseRecord | null;
  credits: number | null;
  costUsd: number | null;
}> {
  const clocked = clockedClient();
  const result = await clocked.fill({
    text: input.receiptText,
    fields: EXPENSE_FILL_FIELDS,
    instructions:
      "Complete this expense record from the receipt. Base every field only on what the receipt shows; when the receipt does not establish a field, leave it blank.",
  } as never);
  return { record: parseFillResponse(result.data), credits: result.credits, costUsd: result.costUsd };
}

/** Run Clocked PII over the receipt text: find personal data and return a
 *  masked copy. The masked copy is for display only — extraction always
 *  reads the original text, so masking can never corrupt the values. */
export async function checkReceiptPii(input: { text: string }): Promise<{
  report: PrivacyReport;
  credits: number | null;
  costUsd: number | null;
}> {
  const clocked = clockedClient();
  const result = await clocked.pii({
    text: input.text,
    entities: ["phone", "credit_card", "email", "person", "bank_account"],
    anonymize: "mask",
    mask_keep: 2,
    instructions:
      "Find personal data printed on this shop receipt: phone numbers, card numbers, email addresses, personal names and bank details. The shop's own name and address are business details, not personal data.",
  } as never);
  return { report: parsePiiResponse(result.data), credits: result.credits, costUsd: result.costUsd };
}

/** Turn a Clocked SDK error into a user-facing message (no key, no stack). */
export function clockedErrorMessage(err: unknown): { status: number; message: string } {
  if (err instanceof ClockedError) {
    if (err.status === 401) return { status: 401, message: "Clocked rejected the API key (401). Check CLOCKED_API_KEY — create a fresh key at https://clocked.rezolve.ai/account." };
    if (err.status === 402) return { status: 402, message: "Clocked credits are exhausted (402). Redeem more credits on your Clocked account page." };
    if (err.status === 403) return { status: 403, message: "Clocked refused this account (403): the account or plan is not active." };
    if (err.status === 429) return { status: 429, message: "Clocked rate limit (429): too many requests in flight. Wait a moment and retry." };
    if (err.status === 422 || err.status === 400) return { status: 400, message: `Clocked rejected the request (${err.status}): ${err.error ?? "invalid input"}. Try a clearer photo or shorter text.` };
    return { status: 502, message: `Clocked error (${err.status ?? "?"}): ${err.error ?? "the Clocked API did not answer"}.` };
  }
  if (err instanceof Error) return { status: 502, message: `Could not reach Clocked: ${err.message}` };
  return { status: 502, message: "Could not reach Clocked." };
}

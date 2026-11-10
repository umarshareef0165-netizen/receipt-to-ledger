import { formatCents, parseMoneyToCents, sumCents } from "./money";
import { CATEGORIES, guessCategory, type Category } from "./categories";
import type { ExpenseRecord, PrivacyReport } from "./expense-record";

export interface LedgerLine {
  id: string;
  description: string;
  qty: number;
  /** unit price, integer cents */
  unitPriceCents: number | null;
  /** line total, integer cents */
  totalCents: number | null;
  category: Category;
  /** Clocked Decide probability for the category (0-1), when the AI classified it. */
  categoryConfidence: number | null;
  /** "clocked" when Clocked Decide classified it, "keyword" when the deterministic fallback did. */
  categorySource: "clocked" | "keyword";
}

export interface Receipt {
  id: string;
  vendor: string;
  date: string; // YYYY-MM-DD when known, else "" (display "Unknown date")
  receiptNumber: string;
  currency: string;
  paymentMethod: string;
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  lines: LedgerLine[];
  /** "live" = extracted by Clocked AI; "demo" = deterministic demo parser, clearly labelled in the UI. */
  source: "live" | "demo";
  /** Clocked usage for this receipt, when live. */
  clockedCredits: number | null;
  clockedCostUsd: number | null;
  /** Structured expense record completed by Clocked Fill (or the labelled demo template). */
  expenseRecord: ExpenseRecord | null;
  /** Personal-data findings from Clocked PII (or the labelled demo scan). */
  privacy: PrivacyReport | null;
  createdAt: string; // ISO timestamp
}

export interface ReceiptCheck {
  /** Sum of line totals (integer cents) — null when any line total is missing. */
  linesSumCents: number | null;
  /** True when the lines sum to the printed subtotal (or to the printed total when no subtotal is printed). Lines never include tax, so they must NOT be compared to a tax-inclusive total. */
  totalMatchesLines: boolean | null;
  /** True when printed subtotal + tax equals the printed total exactly. */
  subtotalPlusTaxMatchesTotal: boolean | null;
  /** Human-readable problems found by exact arithmetic. */
  issues: string[];
  /** Line ids that appear twice with the same description + total inside this receipt. */
  duplicateLineIds: string[];
}

/** Verify a receipt with exact integer arithmetic. Nothing here uses floats. */
export function checkReceipt(r: Receipt): ReceiptCheck {
  const issues: string[] = [];
  const lineTotals = r.lines.map((l) => l.totalCents);
  const allKnown = lineTotals.every((t) => typeof t === "number");
  const linesSumCents = allKnown ? sumCents(lineTotals) : null;

  let totalMatchesLines: boolean | null = null;
  // Lines sum to the SUBTOTAL (they exclude tax). Only fall back to the
  // printed total when no subtotal was printed on the receipt.
  const linesReference = r.subtotalCents ?? r.totalCents;
  const linesReferenceLabel = r.subtotalCents !== null ? "subtotal" : "total";
  if (linesSumCents !== null && linesReference !== null) {
    totalMatchesLines = linesSumCents === linesReference;
    if (!totalMatchesLines) {
      issues.push(
        `Arithmetic error: lines sum to ${formatCents(linesSumCents, r.currency)} but the printed ${linesReferenceLabel} is ${formatCents(linesReference, r.currency)} (difference ${formatCents(linesSumCents - linesReference, r.currency)}).`,
      );
    }
  }

  let subtotalPlusTaxMatchesTotal: boolean | null = null;
  if (r.subtotalCents !== null && r.taxCents !== null && r.totalCents !== null) {
    subtotalPlusTaxMatchesTotal = r.subtotalCents + r.taxCents === r.totalCents;
    if (!subtotalPlusTaxMatchesTotal) {
      issues.push(
        `Arithmetic error: subtotal ${formatCents(r.subtotalCents, r.currency)} + tax ${formatCents(r.taxCents, r.currency)} ≠ total ${formatCents(r.totalCents, r.currency)}.`,
      );
    }
  }

  // Per-line qty × unit price check.
  for (const line of r.lines) {
    if (line.qty && line.unitPriceCents !== null && line.totalCents !== null) {
      const expected = Math.round(line.qty * line.unitPriceCents);
      if (expected !== line.totalCents) {
        issues.push(
          `Line "${line.description}": ${line.qty} × ${formatCents(line.unitPriceCents, r.currency)} = ${formatCents(expected, r.currency)}, but the receipt shows ${formatCents(line.totalCents, r.currency)}.`,
        );
      }
    }
    if (line.totalCents === null) issues.push(`Line "${line.description}": no total could be read — check it before trusting the ledger.`);
  }

  // Duplicate lines inside one receipt.
  const seen = new Map<string, string>();
  const duplicateLineIds: string[] = [];
  for (const line of r.lines) {
    const key = `${line.description.trim().toLowerCase()}|${line.totalCents ?? "?"}`;
    const first = seen.get(key);
    if (first) {
      duplicateLineIds.push(line.id);
      issues.push(`Possible duplicate line: "${line.description}" appears twice with the same total.`);
    } else {
      seen.set(key, line.id);
    }
  }

  if (r.lines.length === 0) issues.push("No line items were found on this receipt.");
  if (r.totalCents === null) issues.push("No printed total could be read from this receipt.");

  return { linesSumCents, totalMatchesLines, subtotalPlusTaxMatchesTotal, issues, duplicateLineIds };
}

/** A receipt already in the ledger is a likely duplicate when vendor + date + total all match. */
export function findDuplicateReceipts(candidate: Receipt, ledger: Receipt[]): Receipt[] {
  if (!candidate.vendor || !candidate.date || candidate.totalCents === null) return [];
  const normVendor = candidate.vendor.trim().toLowerCase();
  return ledger.filter(
    (r) =>
      r.id !== candidate.id &&
      r.vendor.trim().toLowerCase() === normVendor &&
      r.date === candidate.date &&
      r.totalCents === candidate.totalCents,
  );
}

export interface MonthTotal {
  month: string; // "2026-11"
  totalCents: number;
  receiptCount: number;
}

export function monthlyTotals(ledger: Receipt[]): MonthTotal[] {
  const byMonth = new Map<string, { totalCents: number; receiptCount: number }>();
  for (const r of ledger) {
    const month = r.date ? r.date.slice(0, 7) : "unknown";
    const entry = byMonth.get(month) ?? { totalCents: 0, receiptCount: 0 };
    entry.totalCents += r.totalCents ?? 0;
    entry.receiptCount += 1;
    byMonth.set(month, entry);
  }
  return [...byMonth.entries()]
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

export function categoryTotals(ledger: Receipt[]): Array<{ category: Category; totalCents: number; lineCount: number }> {
  const byCat = new Map<Category, { totalCents: number; lineCount: number }>();
  for (const r of ledger) {
    for (const line of r.lines) {
      const entry = byCat.get(line.category) ?? { totalCents: 0, lineCount: 0 };
      entry.totalCents += line.totalCents ?? 0;
      entry.lineCount += 1;
      byCat.set(line.category, entry);
    }
  }
  return CATEGORIES.filter((c) => byCat.has(c)).map((c) => ({ category: c, ...byCat.get(c)! }));
}

export interface TaxMonth {
  month: string; // "2026-11"
  /** Total of receipts Clocked Fill (or the demo template) marked tax-deductible. */
  deductibleCents: number;
  deductibleCount: number;
  totalCents: number;
}

/** Tax-ready summary: per month, how much of the ledger is deductible
 *  business spending. Receipts without an expense record are never counted
 *  as deductible — the summary never guesses. */
export function taxSummary(ledger: Receipt[]): TaxMonth[] {
  const byMonth = new Map<string, { deductibleCents: number; deductibleCount: number; totalCents: number }>();
  for (const r of ledger) {
    const month = r.date ? r.date.slice(0, 7) : "unknown";
    const entry = byMonth.get(month) ?? { deductibleCents: 0, deductibleCount: 0, totalCents: 0 };
    entry.totalCents += r.totalCents ?? 0;
    if (r.expenseRecord?.taxDeductible === true && r.totalCents !== null) {
      entry.deductibleCents += r.totalCents;
      entry.deductibleCount += 1;
    }
    byMonth.set(month, entry);
  }
  return [...byMonth.entries()]
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

/** Case-insensitive search over vendor names and line descriptions. */
export function filterLedger(ledger: Receipt[], query: string): Receipt[] {
  const q = query.trim().toLowerCase();
  if (!q) return ledger;
  return ledger.filter(
    (r) =>
      r.vendor.toLowerCase().includes(q) ||
      r.lines.some((l) => l.description.toLowerCase().includes(q)),
  );
}

/** Escape one CSV field per RFC 4180. */
export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** One row per line item — the format a bookkeeper / accountant can open in Excel or Sheets. */
export function ledgerToCsv(ledger: Receipt[]): string {
  const header = ["date", "vendor", "receipt_no", "description", "qty", "unit_price", "line_total", "category", "business_purpose", "tax_deductible", "record_summary", "payment_method", "currency", "source"];
  const rows: string[] = [header.join(",")];
  for (const r of ledger) {
    for (const line of r.lines) {
      rows.push(
        [
          r.date,
          r.vendor,
          r.receiptNumber,
          line.description,
          String(line.qty),
          line.unitPriceCents === null ? "" : (line.unitPriceCents / 100).toFixed(2),
          line.totalCents === null ? "" : (line.totalCents / 100).toFixed(2),
          line.category,
          r.expenseRecord?.businessPurpose ?? "",
          r.expenseRecord?.taxDeductible === true ? "yes" : r.expenseRecord?.taxDeductible === false ? "no" : "",
          r.expenseRecord?.summary ?? "",
          r.paymentMethod,
          r.currency,
          r.source,
        ]
          .map(csvEscape)
          .join(","),
      );
    }
  }
  return rows.join("\r\n") + "\r\n";
}

export function ledgerTotalCents(ledger: Receipt[]): number {
  return sumCents(ledger.map((r) => r.totalCents));
}

/** Build a Receipt from raw extracted strings (from Clocked or the demo parser). */
export function buildReceipt(input: {
  vendor?: string | null;
  date?: string | null;
  receiptNumber?: string | null;
  currency?: string | null;
  paymentMethod?: string | null;
  subtotal?: string | null;
  tax?: string | null;
  total?: string | null;
  lines: Array<{
    description: string;
    qty?: number | string | null;
    unitPrice?: string | null;
    total?: string | null;
    category?: string | null;
    categoryConfidence?: number | null;
    categorySource?: "clocked" | "keyword";
  }>;
  source: "live" | "demo";
  clockedCredits?: number | null;
  clockedCostUsd?: number | null;
  expenseRecord?: ExpenseRecord | null;
  privacy?: PrivacyReport | null;
}): Receipt {
  const id = `rcpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    vendor: (input.vendor ?? "").trim() || "Unknown vendor",
    date: normaliseDate(input.date),
    receiptNumber: (input.receiptNumber ?? "").trim(),
    currency: (input.currency ?? "").trim().toUpperCase() || "USD",
    paymentMethod: (input.paymentMethod ?? "").trim() || "Unknown",
    subtotalCents: parseMoneyToCents(input.subtotal),
    taxCents: parseMoneyToCents(input.tax),
    totalCents: parseMoneyToCents(input.total),
    lines: input.lines.map((l, i) => {
      const category = (CATEGORIES as readonly string[]).includes(l.category ?? "")
        ? (l.category as Category)
        : guessCategory(l.description);
      return {
        id: `${id}_line_${i}`,
        description: l.description.trim(),
        qty: parseQty(l.qty),
        unitPriceCents: parseMoneyToCents(l.unitPrice),
        totalCents: parseMoneyToCents(l.total),
        category,
        categoryConfidence: typeof l.categoryConfidence === "number" ? l.categoryConfidence : null,
        categorySource: l.categorySource ?? "keyword",
      };
    }),
    source: input.source,
    clockedCredits: input.clockedCredits ?? null,
    clockedCostUsd: input.clockedCostUsd ?? null,
    expenseRecord: input.expenseRecord ?? null,
    privacy: input.privacy ?? null,
    createdAt: new Date().toISOString(),
  };
}

function parseQty(q: number | string | null | undefined): number {
  if (typeof q === "number" && Number.isFinite(q) && q > 0) return q;
  if (typeof q === "string") {
    const n = parseFloat(q.replace(",", "."));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

/** Accept YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY-ish and "9 Nov 2026"; return YYYY-MM-DD or "". */
export function normaliseDate(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) {
    // Receipts in Pakistan / most of the world are DD/MM/YYYY; a first number > 12 settles it.
    const a = parseInt(dmy[1], 10);
    const b = parseInt(dmy[2], 10);
    const y = dmy[3];
    const day = a > 12 ? a : b > 12 ? b : a; // ambiguous: assume DD/MM
    const month = day === a ? b : a;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return "";
}

/**
 * DEMO-ONLY deterministic receipt parser.
 *
 * This is NOT AI. It only runs when the user clicks "Try the sample receipt"
 * and the UI labels its output "DEMO — parsed by a simple pattern matcher,
 * not by Clocked AI". The live path (Clocked Extract + Decide) never uses it.
 * It exists so the ledger math, duplicate checks and CSV export can be
 * tested end-to-end without an API key — and so nobody ever mistakes a
 * pattern-matched demo for a real AI extraction.
 */
import { parseMoneyToCents } from "./money";
import { guessCategory } from "./categories";

export const SAMPLE_RECEIPT_TEXT = `AL-FATAH SUPER STORE
Main Bazaar, Faisalabad
Receipt No: 4821        Date: 09/11/2026
----------------------------------------
Basmati Rice 5kg        2 x 1450.00   2900.00
Cooking Oil 1L          3 x 620.00    1860.00
Sugar 1kg               5 x 185.00     925.00
Tea 500g                1 x 740.00     740.00
----------------------------------------
Subtotal                              6425.00
GST (5%)                               321.25
TOTAL                                 6746.25
Payment: Cash
Thank you for shopping!`;

export interface DemoLine {
  description: string;
  qty: number | null;
  unitPrice: string | null;
  total: string | null;
}

export interface DemoParsed {
  vendor: string | null;
  date: string | null;
  receiptNumber: string | null;
  currency: string | null;
  paymentMethod: string | null;
  subtotal: string | null;
  tax: string | null;
  total: string | null;
  lines: DemoLine[];
}

/** Parse printed receipt text with plain regexes. Handles "2 x 1450.00 2900.00" lines. */
export function demoParseReceiptText(text: string): DemoParsed {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const vendor = lines[0] ?? null;

  const dateMatch = text.match(/(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/);
  const receiptMatch = text.match(/receipt\s*(?:no\.?|#|number)?\s*[:#]?\s*([A-Za-z0-9-]+)/i);
  const paymentMatch = text.match(/payment\s*[:\-]?\s*([A-Za-z ]+)/i);
  const subtotalMatch = text.match(/subtotal\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i);
  // Tax line: take the LAST money amount on the line that mentions GST/VAT/tax
  // (the label itself may contain a rate like "(5%)", so a single regex can't skip it).
  const taxLine = lines.find((l) => /^(gst|vat|tax)\b/i.test(l));
  const taxAmounts = taxLine ? [...taxLine.matchAll(/([\d,]+\.\d{2})/g)].map((m) => m[1]) : [];
  const taxMatch = taxAmounts.length ? taxAmounts[taxAmounts.length - 1] : null;
  const totalMatch = text.match(/(?:^|\n)\s*TOTAL\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i);

  const parsedLines: DemoLine[] = [];
  for (const line of lines) {
    // "Basmati Rice 5kg  2 x 1450.00  2900.00" or "Tea 500g  740.00"
    const m = line.match(/^(.+?)\s+(?:(\d+(?:\.\d+)?)\s*[x×]\s*([\d,]+\.\d{2})\s+)?([\d,]+\.\d{2})\s*$/);
    if (!m) continue;
    const desc = m[1].trim();
    if (/^(subtotal|total|gst|vat|tax|payment|thank|receipt|date)/i.test(desc)) continue;
    if (/^-+$/.test(desc)) continue;
    parsedLines.push({
      description: desc,
      qty: m[2] ? parseFloat(m[2]) : 1,
      unitPrice: m[3] ?? null,
      total: m[4],
    });
  }

  return {
    vendor,
    date: dateMatch ? dateMatch[1] : null,
    receiptNumber: receiptMatch ? receiptMatch[1] : null,
    currency: /Rs\.?|PKR|PKR/i.test(text) ? "PKR" : "USD",
    paymentMethod: paymentMatch ? paymentMatch[1].trim() : null,
    subtotal: subtotalMatch ? subtotalMatch[1] : null,
    tax: taxMatch,
    total: totalMatch ? totalMatch[1] : null,
    lines: parsedLines,
  };
}

/** Category for a demo line (deterministic keyword guess — labelled as such in the UI). */
export function demoCategory(description: string): string {
  return guessCategory(description);
}

/** Sanity check used by tests: the sample receipt's own arithmetic must balance exactly. */
export function sampleReceiptExpectedTotalCents(): number {
  // 2900.00 + 1860.00 + 925.00 + 740.00 = 6425.00; + 5% GST 321.25 = 6746.25
  const parsed = demoParseReceiptText(SAMPLE_RECEIPT_TEXT);
  const sum = parsed.lines.reduce((acc, l) => acc + (parseMoneyToCents(l.total) ?? 0), 0);
  return sum;
}

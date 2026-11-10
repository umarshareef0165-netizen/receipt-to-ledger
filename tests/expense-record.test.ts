import { describe, expect, it } from "vitest";
import {
  demoExpenseRecord,
  demoPiiScan,
  parseFillResponse,
  parsePiiResponse,
} from "../src/lib/expense-record";
import { demoParseReceiptText, SAMPLE_RECEIPT_TEXT } from "../src/lib/demo";
import {
  buildReceipt,
  checkReceipt,
  filterLedger,
  ledgerToCsv,
  taxSummary,
} from "../src/lib/ledger";

function sampleReceipt() {
  const parsed = demoParseReceiptText(SAMPLE_RECEIPT_TEXT);
  return buildReceipt({
    vendor: parsed.vendor,
    date: parsed.date,
    receiptNumber: parsed.receiptNumber,
    currency: parsed.currency,
    paymentMethod: parsed.paymentMethod,
    subtotal: parsed.subtotal,
    tax: parsed.tax,
    total: parsed.total,
    lines: parsed.lines.map((l) => ({ ...l, categorySource: "keyword" as const })),
    source: "demo",
  });
}

describe("parseFillResponse — tolerant of Clocked Fill shapes", () => {
  it("reads choice + yes_no + generate values", () => {
    const out = parseFillResponse({
      model: "clocked-1.0",
      fields: {
        business_purpose: { value: "Resale stock / inventory", probabilities: { "Resale stock / inventory": 0.9 } },
        tax_deductible: { value: true },
        record_summary: { value: "Stock purchase of rice, oil, sugar and tea." },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.businessPurpose).toBe("Resale stock / inventory");
    expect(out!.taxDeductible).toBe(true);
    expect(out!.summary).toBe("Stock purchase of rice, oil, sugar and tea.");
    expect(out!.source).toBe("clocked");
  });

  it("rejects a purpose outside the allowed list, keeps the rest", () => {
    const out = parseFillResponse({
      fields: {
        business_purpose: { value: "Something exotic" },
        tax_deductible: { value: false },
        record_summary: { value: null },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.businessPurpose).toBeNull();
    expect(out!.taxDeductible).toBe(false);
  });

  it("returns null when no field was established", () => {
    expect(parseFillResponse({ fields: { business_purpose: { value: null }, tax_deductible: { value: null }, record_summary: { value: null } } })).toBeNull();
    expect(parseFillResponse({ unexpected: true })).toBeNull();
    expect(parseFillResponse(null)).toBeNull();
  });
});

describe("parsePiiResponse — tolerant of Clocked PII shapes", () => {
  it("reads entities + anonymized text, dedupes repeats", () => {
    const out = parsePiiResponse({
      model: "clocked-1.0",
      entities: [
        { type: "phone", value: "03012345678", start: 10, end: 21, confidence: 0.99, source: "text" },
        { type: "phone", value: "03012345678", start: 10, end: 21, confidence: 0.99, source: "text" },
        { type: "credit_card", value: "4532123456789012", start: 30, end: 46, confidence: 0.97, source: "text" },
      ],
      counts: { phone: 1, credit_card: 1 },
      threshold: 0.5,
      anonymized_text: "Call •••••••••78, card ••••••••••••••12",
    });
    expect(out.findings).toHaveLength(2);
    expect(out.findings[0]).toEqual({ type: "phone", value: "03012345678" });
    expect(out.maskedText).toContain("••••");
    expect(out.source).toBe("clocked");
  });

  it("returns an empty report on an unrecognised envelope", () => {
    const out = parsePiiResponse({ unexpected: true });
    expect(out.findings).toEqual([]);
    expect(out.maskedText).toBeNull();
  });
});

describe("demo expense record (clearly-labelled, NOT AI)", () => {
  it("marks the sample receipt as resale stock, deductible, with a summary", () => {
    const receipt = sampleReceipt();
    const record = demoExpenseRecord({
      vendor: receipt.vendor,
      lineDescriptions: receipt.lines.map((l) => l.description),
      lineCategories: receipt.lines.map((l) => l.category),
    });
    expect(record.businessPurpose).toBe("Resale stock / inventory");
    expect(record.taxDeductible).toBe(true);
    expect(record.summary).toContain("AL-FATAH SUPER STORE");
    expect(record.summary).toContain("Basmati Rice 5kg");
    expect(record.source).toBe("demo");
  });

  it("marks a personal purchase as not deductible", () => {
    const record = demoExpenseRecord({
      vendor: "Cineplex",
      lineDescriptions: ["Movie ticket", "Popcorn"],
      lineCategories: ["Entertainment", "Food & Dining"],
    });
    expect(record.businessPurpose).toBe("Personal / household");
    expect(record.taxDeductible).toBe(false);
  });
});

describe("demo PII scan (clearly-labelled, NOT AI)", () => {
  it("finds a phone number and a card number and masks them", () => {
    const text = "Shop: 0301-2345678\nCard: 4532 1234 5678 9012\nTOTAL 100.00";
    const out = demoPiiScan(text);
    expect(out.findings.map((f) => f.type).sort()).toEqual(["credit_card", "phone"]);
    expect(out.maskedText).not.toContain("0301-2345678");
    expect(out.maskedText).not.toContain("4532 1234 5678 9012");
    expect(out.maskedText).toContain("78");
    expect(out.source).toBe("demo");
  });

  it("finds nothing on the clean sample receipt", () => {
    const out = demoPiiScan(SAMPLE_RECEIPT_TEXT);
    expect(out.findings).toEqual([]);
    expect(out.maskedText).toBeNull();
  });
});

describe("tax summary + CSV + search", () => {
  it("counts only deductible receipts in the tax summary", () => {
    const a = sampleReceipt(); // demo record will be attached below
    a.expenseRecord = demoExpenseRecord({
      vendor: a.vendor,
      lineDescriptions: a.lines.map((l) => l.description),
      lineCategories: a.lines.map((l) => l.category),
    });
    const b = buildReceipt({
      vendor: "Cineplex",
      date: "2026-11-08",
      total: "500.00",
      lines: [{ description: "Movie ticket", total: "500.00", categorySource: "keyword" as const }],
      source: "demo",
      expenseRecord: { businessPurpose: "Personal / household", taxDeductible: false, summary: "Personal purchase.", source: "demo" },
    });
    const summary = taxSummary([a, b]);
    expect(summary).toHaveLength(1);
    expect(summary[0].month).toBe("2026-11");
    expect(summary[0].deductibleCents).toBe(674625);
    expect(summary[0].deductibleCount).toBe(1);
    expect(summary[0].totalCents).toBe(674625 + 50000);
  });

  it("never counts a receipt without an expense record as deductible", () => {
    const r = sampleReceipt();
    expect(taxSummary([r])[0].deductibleCents).toBe(0);
    expect(taxSummary([r])[0].deductibleCount).toBe(0);
  });

  it("CSV carries the Fill record columns", () => {
    const a = sampleReceipt();
    a.expenseRecord = demoExpenseRecord({
      vendor: a.vendor,
      lineDescriptions: a.lines.map((l) => l.description),
      lineCategories: a.lines.map((l) => l.category),
    });
    const csv = ledgerToCsv([a]);
    const header = csv.split("\r\n")[0];
    expect(header).toContain("business_purpose,tax_deductible,record_summary");
    const firstRow = csv.split("\r\n")[1];
    expect(firstRow).toContain("Resale stock / inventory");
    expect(firstRow).toContain("yes");
  });

  it("filterLedger matches vendor and item text, case-insensitively", () => {
    const a = sampleReceipt();
    expect(filterLedger([a], "al-fatah")).toHaveLength(1);
    expect(filterLedger([a], "RICE")).toHaveLength(1);
    expect(filterLedger([a], "cinema")).toHaveLength(0);
    expect(filterLedger([a], "")).toHaveLength(1);
  });

  it("the demo receipt still balances after the new fields", () => {
    const receipt = sampleReceipt();
    receipt.expenseRecord = demoExpenseRecord({
      vendor: receipt.vendor,
      lineDescriptions: receipt.lines.map((l) => l.description),
      lineCategories: receipt.lines.map((l) => l.category),
    });
    receipt.privacy = demoPiiScan(SAMPLE_RECEIPT_TEXT);
    expect(checkReceipt(receipt).issues).toEqual([]);
  });
});

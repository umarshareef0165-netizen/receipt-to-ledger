import { describe, expect, it } from "vitest";
import { parseExtractResponse } from "../src/lib/clocked";
import { demoParseReceiptText, SAMPLE_RECEIPT_TEXT, sampleReceiptExpectedTotalCents } from "../src/lib/demo";
import { buildReceipt, checkReceipt } from "../src/lib/ledger";
import { parseMoneyToCents } from "../src/lib/money";

describe("parseExtractResponse — tolerant of both Clocked response shapes", () => {
  it("reads the documented text-mode shape (fields[name].value)", () => {
    const data = {
      model: "clocked-1.0",
      fields: {
        vendor: { value: "Al-Fatah Super Store", start: 0, end: 20, confidence: 0.99 },
        date: { value: "09/11/2026" },
        total: { value: "6746.25" },
        line_items: {
          value: null,
          items: [],
        },
      },
    };
    const out = parseExtractResponse(data);
    expect(out.vendor).toBe("Al-Fatah Super Store");
    expect(out.total).toBe("6746.25");
  });

  it("reads the image-mode shape (result[name] typed values)", () => {
    const data = {
      model: "clocked-1.0",
      mode: "native_vision",
      result: {
        vendor: "Al-Fatah Super Store",
        date: "09/11/2026",
        receipt_number: "4821",
        total: "6746.25",
        line_items: [
          { description: "Basmati Rice 5kg", qty: "2", unit_price: "1450.00", line_total: "2900.00" },
          { description: "Tea 500g", qty: "1", unit_price: "740.00", line_total: "740.00" },
        ],
      },
    };
    const out = parseExtractResponse(data);
    expect(out.vendor).toBe("Al-Fatah Super Store");
    expect(out.receiptNumber).toBe("4821");
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0].description).toBe("Basmati Rice 5kg");
    expect(out.lines[0].total).toBe("2900.00");
  });

  it("returns nulls, never crashes, on an unrecognised envelope", () => {
    const out = parseExtractResponse({ unexpected: true });
    expect(out.vendor).toBeNull();
    expect(out.lines).toEqual([]);
  });

  it("reads nested record rows carried as { value } objects", () => {
    const data = {
      fields: {
        line_items: {
          value: [
            {
              description: { value: "Sugar 1kg" },
              qty: { value: "5" },
              unit_price: { value: "185.00" },
              line_total: { value: "925.00" },
            },
          ],
        },
      },
    };
    const out = parseExtractResponse(data);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].total).toBe("925.00");
  });
});

describe("demo parser (clearly-labelled, NOT AI)", () => {
  it("parses the sample receipt: 4 lines, subtotal + GST = total", () => {
    const parsed = demoParseReceiptText(SAMPLE_RECEIPT_TEXT);
    expect(parsed.vendor).toBe("AL-FATAH SUPER STORE");
    expect(parsed.receiptNumber).toBe("4821");
    expect(parsed.lines).toHaveLength(4);
    expect(parsed.lines[0]).toEqual({ description: "Basmati Rice 5kg", qty: 2, unitPrice: "1450.00", total: "2900.00" });
    expect(parsed.subtotal).toBe("6425.00");
    expect(parsed.tax).toBe("321.25");
    expect(parsed.total).toBe("6746.25");
  });

  it("the sample receipt balances exactly in integer cents", () => {
    const parsed = demoParseReceiptText(SAMPLE_RECEIPT_TEXT);
    const receipt = buildReceipt({
      vendor: parsed.vendor, date: parsed.date, receiptNumber: parsed.receiptNumber,
      currency: parsed.currency, paymentMethod: parsed.paymentMethod,
      subtotal: parsed.subtotal, tax: parsed.tax, total: parsed.total,
      lines: parsed.lines.map((l) => ({ ...l, categorySource: "keyword" as const })),
      source: "demo",
    });
    const check = checkReceipt(receipt);
    expect(check.issues).toEqual([]);
    expect(check.linesSumCents).toBe(642500);
    expect(parseMoneyToCents(parsed.total)).toBe(674625);
    expect(sampleReceiptExpectedTotalCents()).toBe(642500);
  });
});

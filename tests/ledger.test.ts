import { describe, expect, it } from "vitest";
import {
  buildReceipt,
  categoryTotals,
  checkReceipt,
  csvEscape,
  findDuplicateReceipts,
  ledgerToCsv,
  monthlyTotals,
  normaliseDate,
  type Receipt,
} from "../src/lib/ledger";

function sampleReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return buildReceipt({
    vendor: "Al-Fatah Super Store",
    date: "2026-11-09",
    receiptNumber: "4821",
    currency: "PKR",
    paymentMethod: "Cash",
    subtotal: "6425.00",
    tax: "321.25",
    total: "6746.25",
    lines: [
      { description: "Basmati Rice 5kg", qty: 2, unitPrice: "1450.00", total: "2900.00" },
      { description: "Cooking Oil 1L", qty: 3, unitPrice: "620.00", total: "1860.00" },
      { description: "Sugar 1kg", qty: 5, unitPrice: "185.00", total: "925.00" },
      { description: "Tea 500g", qty: 1, unitPrice: "740.00", total: "740.00" },
    ],
    source: "demo",
    ...overrides,
  } as never);
}

describe("checkReceipt — exact arithmetic verification", () => {
  it("passes a balanced receipt", () => {
    const check = checkReceipt(sampleReceipt());
    expect(check.issues).toEqual([]);
    expect(check.linesSumCents).toBe(642500);
    expect(check.totalMatchesLines).toBe(true);
    expect(check.subtotalPlusTaxMatchesTotal).toBe(true);
  });

  it("flags a printed total that does not match subtotal + tax", () => {
    const r = sampleReceipt();
    r.totalCents = 670000; // 46.25 short of subtotal + tax (6746.25)
    const check = checkReceipt(r);
    expect(check.subtotalPlusTaxMatchesTotal).toBe(false);
    expect(check.issues.some((i) => i.includes("6,700.00"))).toBe(true);
  });

  it("flags subtotal + tax != total", () => {
    const r = sampleReceipt();
    r.taxCents = 30000;
    const check = checkReceipt(r);
    expect(check.subtotalPlusTaxMatchesTotal).toBe(false);
  });

  it("flags a line where qty x unit price != line total", () => {
    const r = sampleReceipt();
    r.lines[0].totalCents = 280000;
    const check = checkReceipt(r);
    expect(check.issues.some((i) => i.includes("Basmati Rice"))).toBe(true);
  });

  it("flags duplicate lines inside one receipt", () => {
    const r = sampleReceipt();
    r.lines.push({ ...r.lines[0], id: "dup-line" });
    const check = checkReceipt(r);
    expect(check.duplicateLineIds).toContain("dup-line");
    expect(check.issues.some((i) => i.includes("duplicate"))).toBe(true);
  });

  it("reports missing totals instead of inventing them", () => {
    const r = buildReceipt({
      vendor: "Shop", date: "", currency: "USD", paymentMethod: "Cash",
      lines: [{ description: "Mystery item", qty: 1, unitPrice: null, total: null }],
      source: "demo",
    });
    const check = checkReceipt(r);
    expect(check.linesSumCents).toBeNull();
    expect(check.issues.length).toBeGreaterThan(0);
  });
});

describe("findDuplicateReceipts", () => {
  it("matches same vendor + date + total, ignores different totals", () => {
    const a = sampleReceipt();
    const b = sampleReceipt();
    b.id = "other-id";
    expect(findDuplicateReceipts(b, [a])).toHaveLength(1);
    const c = sampleReceipt();
    c.id = "third-id";
    c.totalCents = 100;
    expect(findDuplicateReceipts(c, [a])).toHaveLength(0);
  });
});

describe("monthlyTotals / categoryTotals", () => {
  it("groups by month and sums exactly", () => {
    const a = sampleReceipt();
    const b = sampleReceipt();
    b.id = "b-id";
    b.date = "2026-10-02";
    b.totalCents = 10000;
    const months = monthlyTotals([a, b]);
    expect(months).toHaveLength(2);
    expect(months.find((m) => m.month === "2026-11")?.totalCents).toBe(674625);
    expect(months.find((m) => m.month === "2026-10")?.totalCents).toBe(10000);
  });

  it("totals by category", () => {
    const cats = categoryTotals([sampleReceipt()]);
    const groceries = cats.find((c) => c.category === "Groceries");
    expect(groceries).toBeDefined();
    // Rice + oil + sugar are groceries (5685.00); tea is Food & Dining (740.00).
    expect(groceries!.totalCents).toBe(568500);
    expect(cats.find((c) => c.category === "Food & Dining")?.totalCents).toBe(74000);
  });
});

describe("ledgerToCsv", () => {
  it("emits one row per line with RFC 4180 quoting", () => {
    const r = sampleReceipt();
    r.lines[0].description = 'Rice, "Basmati" 5kg';
    const csv = ledgerToCsv([r]);
    const rows = csv.trim().split("\r\n");
    expect(rows).toHaveLength(5); // header + 4 lines
    expect(rows[0]).toBe("date,vendor,receipt_no,description,qty,unit_price,line_total,category,business_purpose,tax_deductible,record_summary,payment_method,currency,source");
    expect(rows[1]).toContain('"Rice, ""Basmati"" 5kg"');
    expect(rows[1]).toContain("2900.00");
  });
});

describe("csvEscape", () => {
  it("quotes fields containing commas, quotes or newlines", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });
});

describe("normaliseDate", () => {
  it("accepts ISO and DD/MM/YYYY", () => {
    expect(normaliseDate("2026-11-09")).toBe("2026-11-09");
    expect(normaliseDate("09/11/2026")).toBe("2026-11-09");
    expect(normaliseDate("9 Nov 2026")).toBe("2026-11-09");
    expect(normaliseDate("garbage")).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { formatCents, parseMoneyToCents, sumCents } from "../src/lib/money";

describe("parseMoneyToCents — exact integer cents, never floats", () => {
  it("parses plain amounts", () => {
    expect(parseMoneyToCents("12.99")).toBe(1299);
    expect(parseMoneyToCents("$1,299.50")).toBe(129950);
    expect(parseMoneyToCents("Rs. 450")).toBe(45000);
    expect(parseMoneyToCents("6746.25")).toBe(674625);
  });
  it("handles negatives and parenthesised negatives", () => {
    expect(parseMoneyToCents("-15.00")).toBe(-1500);
    expect(parseMoneyToCents("(12.50)")).toBe(-1250);
  });
  it("handles European decimal commas", () => {
    expect(parseMoneyToCents("12,99")).toBe(1299);
    expect(parseMoneyToCents("1.299,50")).toBe(129950);
  });
  it("rounds a third decimal half away from zero", () => {
    expect(parseMoneyToCents("10.005")).toBe(1001);
    expect(parseMoneyToCents("10.004")).toBe(1000);
  });
  it("returns null for unparseable input", () => {
    expect(parseMoneyToCents("")).toBeNull();
    expect(parseMoneyToCents(null)).toBeNull();
    expect(parseMoneyToCents("N/A")).toBeNull();
    expect(parseMoneyToCents("abc")).toBeNull();
  });
  it("the classic float trap: 0.1 + 0.2 is exact in cents", () => {
    // In floats 0.1 + 0.2 = 0.30000000000000004. In cents it is exactly 30.
    expect(sumCents([parseMoneyToCents("0.10"), parseMoneyToCents("0.20")])).toBe(30);
  });
});

describe("formatCents", () => {
  it("formats with grouping and currency symbols", () => {
    expect(formatCents(1299)).toBe("$12.99");
    expect(formatCents(674625, "PKR")).toBe("Rs 6,746.25");
    expect(formatCents(-1500)).toBe("-$15.00");
    expect(formatCents(0)).toBe("$0.00");
  });
});

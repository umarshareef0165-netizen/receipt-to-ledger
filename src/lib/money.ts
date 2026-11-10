/**
 * Exact money arithmetic. All amounts are integer minor units (cents/paise).
 * Never use floating point for money: 0.1 + 0.2 !== 0.3 in binary floats,
 * so every amount in the ledger is an integer number of cents.
 */

/** Parse a printed money string ("1,299.50", "$12.99", "Rs. 450", "-15.00") to integer cents. Returns null when unparseable. */
export function parseMoneyToCents(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Parenthesised negatives, e.g. (12.50)
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/^-/.test(s)) {
    negative = true;
    s = s.replace(/^-+/, "");
  }
  // Strip currency words/symbols, keep digits, separators, decimal point.
  s = s.replace(/[^0-9.,]/g, "");
  // A currency abbreviation with a dot ("Rs. 450") leaves a leading dot — drop it.
  s = s.replace(/^\.+/, "").replace(/\.+$/, "");
  if (!s) return null;
  // If both separators appear, the last one is the decimal separator.
  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (s.includes(",")) {
    // A single comma with 1-2 digits after it is a decimal comma; otherwise thousands.
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length <= 2) s = s.replace(",", ".");
    else s = s.replace(/,/g, "");
  }
  if (!/^\d+(\.\d{0,3})?$/.test(s)) return null;
  const [whole, fracRaw = ""] = s.split(".");
  const frac = (fracRaw + "00").slice(0, 2);
  // Round half away from zero on a third decimal digit.
  let cents = parseInt(whole, 10) * 100 + parseInt(frac || "0", 10);
  if (fracRaw.length > 2 && parseInt(fracRaw[2], 10) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** Format integer cents as a money string. Default currency symbol is "$" (overridden by receipt currency). */
export function formatCents(cents: number, currency = "USD"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currencySymbol(currency);
  return `${sign}${symbol}${grouped}.${frac}`;
}

export function currencySymbol(currency: string | null | undefined): string {
  if (!currency) return "$";
  const c = currency.trim().toUpperCase();
  if (c === "PKR" || c === "RS" || c === "RS." || c === "RUPEES") return "Rs ";
  if (c === "EUR" || c === "€") return "€";
  if (c === "GBP" || c === "£") return "£";
  if (c === "INR" || c === "₹") return "₹";
  if (c === "USD" || c === "$") return "$";
  return `${c} `;
}

/** Sum integer cents exactly. */
export function sumCents(values: (number | null | undefined)[]): number {
  return values.reduce<number>((acc, v) => acc + (typeof v === "number" ? v : 0), 0);
}

import { NextRequest, NextResponse } from "next/server";
import {
  checkReceiptPii,
  clockedErrorMessage,
  decideCategories,
  extractReceipt,
  fillExpenseRecord,
  isClockedConfigured,
} from "@/lib/clocked";
import { buildReceipt, checkReceipt, findDuplicateReceipts, type Receipt } from "@/lib/ledger";
import { demoExpenseRecord, demoPiiScan } from "@/lib/expense-record";
import { demoParseReceiptText } from "@/lib/demo";

const MAX_IMAGE_BYTES = 2_400_000; // Clocked limit: 2.4 MB total per request
const MAX_TEXT_CHARS = 20_000;

/**
 * POST /api/parse-receipt
 * Body (JSON): { text?: string, imageDataUrl?: string, demo?: boolean, existingLedger?: Receipt[] }
 *
 * Live path (default): Clocked Extract reads the receipt (image and/or text),
 * then Clocked Decide classifies each line item. All money math is exact
 * integer cents on the server; the response carries the arithmetic verdict.
 *
 * Demo path (demo: true): the clearly-labelled deterministic pattern parser
 * runs on the sample receipt text. Its response is marked source: "demo" and
 * the UI labels it as NOT AI output. The demo path never calls Clocked and
 * never claims to be AI.
 *
 * The API key is read ONLY from the server env var CLOCKED_API_KEY. Clients
 * cannot supply a key in this request.
 */
export async function POST(req: NextRequest) {
  let body: { text?: string; imageDataUrl?: string; demo?: boolean; existingLedger?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT_CHARS) : "";
  const imageDataUrl = typeof body.imageDataUrl === "string" ? body.imageDataUrl : undefined;

  if (body.demo === true) {
    const parsed = demoParseReceiptText(text || "");
    const receipt = buildReceipt({
      vendor: parsed.vendor,
      date: parsed.date,
      receiptNumber: parsed.receiptNumber,
      currency: parsed.currency,
      paymentMethod: parsed.paymentMethod,
      subtotal: parsed.subtotal,
      tax: parsed.tax,
      total: parsed.total,
      lines: parsed.lines.map((l) => ({
        description: l.description,
        qty: l.qty,
        unitPrice: l.unitPrice,
        total: l.total,
        categorySource: "keyword" as const,
      })),
      source: "demo",
    });
    // Demo expense record + privacy scan: deterministic templates, labelled DEMO.
    receipt.expenseRecord = demoExpenseRecord({
      vendor: receipt.vendor,
      lineDescriptions: receipt.lines.map((l) => l.description),
      lineCategories: receipt.lines.map((l) => l.category),
    });
    receipt.privacy = demoPiiScan(text || "");
    const existing = Array.isArray(body.existingLedger) ? (body.existingLedger as Receipt[]) : [];
    const duplicates = findDuplicateReceipts(receipt, existing);
    return NextResponse.json({
      receipt,
      check: checkReceipt(receipt),
      duplicates: duplicates.map((d) => ({ id: d.id, vendor: d.vendor, date: d.date, totalCents: d.totalCents })),
      source: "demo",
    });
  }

  // Validate the input first, so a bad photo / empty request gets a 400 even
  // before the (also honest) no-key 503 below.
  if (!text.trim() && !imageDataUrl) {
    return NextResponse.json({ error: "Paste the receipt text or upload a receipt photo." }, { status: 400 });
  }

  if (imageDataUrl) {
    const m = imageDataUrl.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    if (!m) {
      return NextResponse.json({ error: "The photo must be a PNG, JPEG or WebP image." }, { status: 400 });
    }
    const bytes = Math.floor((m[2].length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: `That photo is about ${(bytes / 1_000_000).toFixed(1)} MB — Clocked accepts at most 2.4 MB per request. Take a smaller / closer photo.` },
        { status: 400 },
      );
    }
  }

  if (!isClockedConfigured()) {
    return NextResponse.json(
      {
        error:
          "No Clocked API key is configured on this server. Set CLOCKED_API_KEY (create a key at https://clocked.rezolve.ai/account) — or use the clearly-labelled sample-receipt demo, which is not AI output.",
        code: "NO_API_KEY",
      },
      { status: 503 },
    );
  }

  try {
    const { extracted, credits, costUsd } = await extractReceipt({ text: text || undefined, imageDataUrl });

    // Decide needs text: the pasted text, or a reconstruction from what Extract read.
    const decideText =
      text.trim() ||
      [extracted.vendor, extracted.date, extracted.receiptNumber, ...extracted.lines.map((l) => `${l.qty ?? 1} x ${l.description} @ ${l.unitPrice ?? "?"} = ${l.total ?? "?"}`), `TOTAL ${extracted.total ?? "?"}`]
        .filter(Boolean)
        .join("\n");

    let categoryByIndex = new Map<number, { category: string; confidence: number | null }>();
    try {
      const decisions = await decideCategories({
        receiptText: decideText,
        descriptions: extracted.lines.map((l) => l.description),
      });
      for (const d of decisions) categoryByIndex.set(d.lineIndex, { category: d.category, confidence: d.confidence });
    } catch (decideErr) {
      // A failed Decide must not lose the extraction: fall back to keyword
      // categories and say so in the response.
      console.error("Clocked Decide failed; falling back to keyword categories:", decideErr);
    }

    const receipt = buildReceipt({
      vendor: extracted.vendor,
      date: extracted.date,
      receiptNumber: extracted.receiptNumber,
      currency: extracted.currency,
      paymentMethod: extracted.paymentMethod,
      subtotal: extracted.subtotal,
      tax: extracted.tax,
      total: extracted.total,
      lines: extracted.lines.map((l, i) => {
        const decided = categoryByIndex.get(i);
        return {
          description: l.description,
          qty: l.qty,
          unitPrice: l.unitPrice,
          total: l.total,
          category: decided?.category ?? null,
          categoryConfidence: decided?.confidence ?? null,
          categorySource: decided ? ("clocked" as const) : ("keyword" as const),
        };
      }),
      source: "live",
      clockedCredits: credits,
      clockedCostUsd: costUsd,
    });

    // Fill + PII run in parallel after extraction. Either may fail without
    // losing the receipt: a failed Fill leaves the record unset (the user
    // can set purpose/deductible in the ledger), a failed PII simply omits
    // the privacy box.
    let fillUsed = false;
    let piiUsed = false;
    let extraCredits = 0;
    const [fillSettled, piiSettled] = await Promise.allSettled([
      fillExpenseRecord({ receiptText: decideText }),
      checkReceiptPii({ text: decideText }),
    ]);
    if (fillSettled.status === "fulfilled") {
      receipt.expenseRecord = fillSettled.value.record;
      fillUsed = fillSettled.value.record !== null;
      extraCredits += fillSettled.value.credits ?? 0;
    } else {
      console.error("Clocked Fill failed; expense record left unset:", fillSettled.reason);
    }
    if (piiSettled.status === "fulfilled") {
      receipt.privacy = piiSettled.value.report;
      piiUsed = true;
      extraCredits += piiSettled.value.credits ?? 0;
    } else {
      console.error("Clocked PII failed; privacy box omitted:", piiSettled.reason);
    }

    const check = checkReceipt(receipt);
    const existing = Array.isArray(body.existingLedger) ? (body.existingLedger as Parameters<typeof findDuplicateReceipts>[1]) : [];
    const duplicates = findDuplicateReceipts(receipt, existing);

    return NextResponse.json({
      receipt,
      check,
      duplicates: duplicates.map((d) => ({ id: d.id, vendor: d.vendor, date: d.date, totalCents: d.totalCents })),
      source: "live",
      clocked: { credits: (credits ?? 0) + extraCredits, costUsd, decideUsed: categoryByIndex.size > 0, fillUsed, piiUsed },
    });
  } catch (err) {
    const { status, message } = clockedErrorMessage(err);
    return NextResponse.json({ error: message, code: "CLOCKED_ERROR" }, { status });
  }
}

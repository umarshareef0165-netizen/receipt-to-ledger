# Receipt-to-Ledger — Clocked Build Challenge

**Photograph a receipt. Clocked AI reads every line, exact arithmetic checks the maths, and you get a clean, exportable ledger.**

Built for the [Clocked Build Challenge](https://clocked.rezolve.ai/challenge) (deadline **Tue Nov 10, 2026, 11:59 PM ET**; $2,000 total — Best Overall $600, Best Use of Decide/Extract/Fill $400, Best Use of Protect/Guard/Inspect $400, Best Use of Verify/Compare/Rerank $400, People's Choice $200 — verified against the official page Nov 10). Aimed at **Best Overall** + **Decide/Extract/Fill** + **Protect/Guard/Inspect** (+ People's Choice).

## The problem

Small shop owners lose paper receipts, keep manual books, and make tax errors: a mistyped total, a receipt entered twice, a line nobody can read any more. Existing receipt apps either OCR badly, silently invent numbers, or lock the ledger behind a subscription. This is one tool that does the whole job — and never invents a number.

## What it does

1. **Add a receipt** — take a photo (camera capture on mobile) or paste the receipt text.
2. **Clocked Extract** reads it verbatim — vendor, date, receipt number, currency, payment method, subtotal, tax, total, and every line item (qty × unit price = line total) as a nested record table. Values are copied exactly as printed; nothing is rounded or "corrected".
3. **Clocked Decide** classifies each line item into an expense category (Groceries, Food & Dining, Transport & Fuel, Utilities, Office & Supplies, Inventory / Stock, Rent, Health, Entertainment, Other) — one `choice` question per line, with a probability. Low-confidence lines are flagged for human review; if Decide fails, the app falls back to keyword categories and says so.
4. **Clocked Fill** completes the structured expense record in one call — business purpose, tax-deductible (yes/no), and a one-line bookkeeping summary. The record is stored on the receipt, shown in the review and ledger, drives the tax summary, and is exported in the CSV. If Fill fails, the record is left unset and the user can set purpose/deductible when editing the receipt.
5. **Clocked PII** screens the receipt text for personal data (phone numbers, card numbers, emails) and returns a masked copy, which is what the review step shows. Extraction always reads the original text, so masking can never corrupt the values.
6. **Exact arithmetic, by code — never by the AI.** All money is integer cents (no floats: `0.1 + 0.2` is exactly 30 cents here). The server checks: lines sum to the printed subtotal, subtotal + tax = printed total, and every line's qty × unit price = its line total. Any mismatch is shown as a warning, never silently fixed.
7. **Duplicate detection** — same vendor + date + total already in the ledger, or the same line twice inside one receipt, both get flagged.
8. **Ledger** — monthly totals, category totals, a tax summary (deductible business spending per month, from Fill records only), editable lines/categories/purpose/deductible flag, receipt search, localStorage persistence, **CSV export** (RFC 4180, opens in Excel/Sheets) and JSON export.

## How Clocked is used (real endpoints, official SDK)

Via the official [`clocked-sdk@0.7.0`](https://www.npmjs.com/package/clocked-sdk) (by Rezolve.ai), base URL `https://clocked.rezolve.ai/clocked`, auth `Authorization: Bearer <CLOCKED_API_KEY>` (sent by the SDK, server-side only).

| Endpoint | Call | Purpose |
|---|---|---|
| `POST /clocked/extract` | `src/lib/clocked.ts` → `extractReceipt()` | Verbatim receipt values + line-item record table, from photo (native vision, `images`) and/or text. Image mode returns typed values in `data.result`; text mode in `data.fields` — both are parsed. |
| `POST /clocked/decide` | `src/lib/clocked.ts` → `decideCategories()` | One `choice` question per line item (max 16) → category + `confidence` + `probabilities`. |
| `POST /clocked/fill` | `src/lib/clocked.ts` → `fillExpenseRecord()` | One structured expense record per receipt: `business_purpose` (choice), `tax_deductible` (yes/no), `record_summary` (generate). Drives the tax summary and CSV columns. |
| `POST /clocked/pii` | `src/lib/clocked.ts` → `checkReceiptPii()` | Finds personal data in the receipt text (phone, card, email, person, bank account) and returns a masked copy (`anonymize: 'mask'`, `mask_keep: 2`) shown in the review step. |

Credits and cost of each live call (`X-Clocked-Credits` / `X-Clocked-Cost-Usd` headers, via the SDK) are summed across Extract + Decide + Fill + PII and shown in the review step. A failed Decide never loses the extraction — it degrades to labelled keyword categories; a failed Fill leaves the expense record unset (editable later); a failed PII simply omits the privacy box.

**Awards entered:** Best Overall App + Best Use of Decide, Extract, or Fill (all three endpoints, full breadth) + Best Use of Protect, Guard, or Inspect (PII) + People's Choice (LinkedIn post — see `SUBMISSION-DRAFT.md`).

**Honesty rule:** without a key the app runs in **demo mode** and says so in the UI. The only non-AI paths are the "Try the sample receipt" button, which runs a clearly-labelled deterministic pattern parser (`src/lib/demo.ts`) plus deterministic Fill/PII templates (`src/lib/expense-record.ts`: `demoExpenseRecord`, `demoPiiScan`) and marks all of their output `DEMO — not AI`. Mock output is never presented as real AI output.

## API research notes (what was verified, what was not)

- Verified from the official SDK's README + TypeScript declarations (installed `clocked-sdk@0.7.0` and read locally): base URL, Bearer auth, Extract/Fill/Decide request + response shapes, image limits (1–4 images, PNG/JPEG/WebP, 2.4 MB total, 16 MP each), error classes (401/402/403/409/429/5xx), credits/cost headers.
- The official docs site (`https://clocked.rezolve.ai/docs`) returned **403 to the crawler**, so the response envelope could not be cross-checked against the live docs. The parser is therefore deliberately tolerant (accepts both `fields` and image-mode `result` shapes, and nested `{ value }` record rows) and degrades to a clear error rather than crashing. Nothing in the code guesses an undocumented field.
- API key location is confirmed by the SDK itself: create it on the account page, `https://clocked.rezolve.ai/account` ("Create API key").

## Setup

```bash
npm install
cp .env.example .env.local   # then paste your key (see below)
npm run dev                  # http://localhost:3000
```

## The one step still needed (API key — wiring only)

A Clocked API key **already exists**: created on the Clocked account on Nov 10, 2026 (named "My application"; account shows 20,000 credits available, 0 used). It still needs to be wired into the app — the key value itself is never written down here or in chat:

1. Locally: put `CLOCKED_API_KEY=<the key>` in `.env.local` and restart (`npm run dev`). Never commit the key; `.env.local` is git-ignored.
2. On Vercel: Project → Settings → Environment Variables → add `CLOCKED_API_KEY` → redeploy.
3. Then test one real receipt photo end to end (Extract + Decide + Fill + PII) and confirm the live banner before submitting.

Until the key is wired in, the banner reads "Demo mode — no Clocked API key is set" and the live Extract button returns an honest `503 NO_API_KEY`. The demo sample receipt works without a key.

## Deploy (Vercel, free)

```bash
npm i -g vercel   # or use the Vercel dashboard: Import Git Repository
vercel            # follow the prompts; framework auto-detected as Next.js
```

Then add the `CLOCKED_API_KEY` environment variable in the Vercel dashboard (see above) and redeploy. No database, no other secrets, no payment needed.

## Submission (do NOT do this without the user's approval)

1. Deploy to Vercel and confirm the live banner (with the key set) — test one real receipt photo end to end.
2. Push the repo to GitHub (public) — `~/workspace/clocked-build-challenge`.
3. Record a ≤3-minute demo video (photo → extraction → arithmetic check → ledger → CSV export), upload to YouTube (public/unlisted).
4. Submit at https://clocked.rezolve.ai/challenge before **Tue Nov 10, 2026, 11:59 PM ET** with: demo video link, public repo link, and an explanation of the Clocked Extract + Decide usage above. Entries are editable until the deadline.

## Tests

```bash
npm test        # vitest — 39 tests
```

- `tests/money.test.ts` (7) — integer-cents parsing/formatting, the `0.1 + 0.2` float trap, European decimal commas, rounding.
- `tests/ledger.test.ts` (12) — arithmetic verification (balanced / wrong total / wrong line / duplicates / missing values), duplicate receipts, monthly + category totals, CSV quoting, date normalisation.
- `tests/clocked-parse.test.ts` (6) — tolerant parsing of both Clocked response shapes (text `fields` and image `result`), and the demo sample receipt balancing exactly.
- `tests/expense-record.test.ts` (14) — Fill response parsing (choice/yes-no/generate, unknown purpose rejected, empty → null), PII response parsing + dedupe, demo expense record (stock vs personal), demo PII scan (phone + card masked, clean receipt finds nothing), tax summary (only deductible receipts counted; no record → never deductible), CSV Fill columns, ledger search.

Live-tested 2026-11-10 on the production build: `GET /` 200; `GET /api/status` → `{"clockedConfigured":false}`; demo parse returns the 4-line sample receipt with `issues: []` and exact cents (subtotal 642500, tax 32125, total 674625), an expense record (Resale stock / inventory, tax-deductible, summary) and a clean privacy report (no findings); a demo receipt carrying a phone number + card number returns both findings with masked values and a masked text copy; duplicate detection returns the matching prior receipt; bad image → 400; empty request → 400; valid live request without a key → honest `503 NO_API_KEY`. **The live Clocked Extract/Decide/Fill/PII calls themselves are NOT yet tested — they need the key wired in (see above).**

## Tech

Next.js 14 (App Router) + TypeScript + React 18, `clocked-sdk@0.7.0`, Vitest. No database — the ledger lives in the browser's localStorage; receipt photos are sent only to Clocked, never stored.

## Project layout

```
src/app/page.tsx                  UI: add receipt → review → ledger, CSV/JSON export
src/app/api/parse-receipt/route.ts  POST: Clocked Extract + Decide + Fill + PII, or labelled demo parse
src/app/api/status/route.ts         GET: { clockedConfigured: boolean } — key never leaves the server
src/lib/clocked.ts                Official SDK wrapper, field specs, tolerant response parsing
src/lib/expense-record.ts         Fill/PII response parsing + deterministic demo templates
src/lib/ledger.ts                 Receipt model, exact-arithmetic checks, duplicates, totals, tax summary, CSV
src/lib/money.ts                  Integer-cents parsing/formatting (no floats for money)
src/lib/categories.ts             Category list + deterministic keyword fallback
src/lib/demo.ts                   Clearly-labelled NON-AI demo parser + sample receipt
tests/                            39 Vitest tests
demo-video/                       Demo video (≤3 min): capture.js + gTTS narration + muxed mp4
```

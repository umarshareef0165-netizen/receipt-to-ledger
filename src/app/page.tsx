"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatCents } from "@/lib/money";
import { CATEGORIES, type Category } from "@/lib/categories";
import { BUSINESS_PURPOSES, piiTypeLabel, type BusinessPurpose, type ExpenseRecord } from "@/lib/expense-record";
import {
  categoryTotals,
  checkReceipt,
  filterLedger,
  findDuplicateReceipts,
  ledgerToCsv,
  ledgerTotalCents,
  monthlyTotals,
  taxSummary,
  type Receipt,
  type ReceiptCheck,
} from "@/lib/ledger";
import { SAMPLE_RECEIPT_TEXT } from "@/lib/demo";

const STORAGE_KEY = "receipt-to-ledger:v1";

interface ParseResponse {
  receipt: Receipt;
  check: ReceiptCheck;
  duplicates?: Array<{ id: string; vendor: string; date: string; totalCents: number | null }>;
  source: "live" | "demo";
  clocked?: { credits: number | null; costUsd: number | null; decideUsed: boolean; fillUsed?: boolean; piiUsed?: boolean };
  error?: string;
  code?: string;
}

function loadLedger(): Receipt[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Receipt[]) : [];
  } catch {
    return [];
  }
}

export default function Home() {
  const [clockedConfigured, setClockedConfigured] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ledger, setLedger] = useState<Receipt[]>([]);
  const [search, setSearch] = useState("");
  const [last, setLast] = useState<{ receipt: Receipt; check: ReceiptCheck; source: "live" | "demo"; duplicates: ParseResponse["duplicates"]; clocked?: ParseResponse["clocked"] } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLedger(loadLedger());
    fetch("/api/status")
      .then((r) => r.json())
      .then((j) => setClockedConfigured(Boolean(j.clockedConfigured)))
      .catch(() => setClockedConfigured(false));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ledger));
    } catch {
      /* storage full or unavailable — the ledger still works in memory */
    }
  }, [ledger]);

  const totals = useMemo(() => monthlyTotals(ledger), [ledger]);
  const cats = useMemo(() => categoryTotals(ledger), [ledger]);
  const tax = useMemo(() => taxSummary(ledger), [ledger]);
  const grandTotal = useMemo(() => ledgerTotalCents(ledger), [ledger]);
  const shown = useMemo(() => filterLedger(ledger, search), [ledger, search]);

  async function parseReceipt(demo: boolean, demoText?: string) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const res = await fetch("/api/parse-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: demo ? demoText ?? SAMPLE_RECEIPT_TEXT : text,
          imageDataUrl: demo ? undefined : imageDataUrl ?? undefined,
          demo,
          existingLedger: ledger,
        }),
      });
      const data: ParseResponse = await res.json();
      if (!res.ok || !data.receipt) {
        setError(data.error ?? `Request failed (${res.status}).`);
        return;
      }
      const duplicates = data.duplicates ?? [];
      setLast({ receipt: data.receipt, check: data.check, source: data.source, duplicates, clocked: data.clocked });
      if (duplicates.length > 0) {
        setNotice(`Possible duplicate: this looks like ${duplicates.length} receipt(s) already in your ledger (same vendor, date and total). Review before adding.`);
      }
      if (data.source === "demo") {
        setNotice("DEMO result — parsed by a simple pattern matcher, NOT by Clocked AI. Add it to the ledger only to test the maths and export.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  function addToLedger() {
    if (!last) return;
    setLedger((prev) => [last.receipt, ...prev]);
    setNotice(
      last.source === "demo"
        ? "Demo receipt added to the ledger (labelled DEMO). It is not AI output."
        : "Receipt added to the ledger.",
    );
    setLast(null);
    setText("");
    setImageDataUrl(null);
    setImageName("");
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setError("Please choose a PNG, JPEG or WebP photo of the receipt.");
      return;
    }
    if (file.size > 2_400_000) {
      setError(`That photo is ${(file.size / 1_000_000).toFixed(1)} MB — Clocked accepts at most 2.4 MB. Take a smaller photo.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImageDataUrl(String(reader.result));
      setImageName(file.name);
      setError("");
    };
    reader.readAsDataURL(file);
  }

  function updateLine(receiptId: string, lineId: string, patch: Partial<{ description: string; qty: number; totalCents: number | null; category: Category }>) {
    setLedger((prev) =>
      prev.map((r) =>
        r.id !== receiptId ? r : { ...r, lines: r.lines.map((l) => (l.id === lineId ? { ...l, ...patch } : l)) },
      ),
    );
  }

  function updateReceipt(receiptId: string, patch: Partial<{ expenseRecord: ExpenseRecord | null }>) {
    setLedger((prev) => prev.map((r) => (r.id !== receiptId ? r : { ...r, ...patch })));
  }

  function exportCsv() {
    const csv = ledgerToCsv(ledger);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `receipt-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `receipt-ledger-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const live = clockedConfigured === true;

  return (
    <main>
      <header>
        <h1>🧾 Receipt-to-Ledger</h1>
        <p>
          Small shop owners lose receipts, keep manual books, and make tax errors. Photograph a receipt —{" "}
          <strong>Clocked AI</strong> reads every line, exact arithmetic checks the maths, and you get a clean,
          exportable ledger. One tool, the whole job.
        </p>
      </header>

      {clockedConfigured === null ? (
        <div className="banner demo">Checking Clocked connection…</div>
      ) : live ? (
        <div className="banner live">
          ✅ <strong>Live AI mode</strong> — Clocked API key is configured on the server. Receipts are read by
          Clocked <em>Extract</em> (verbatim values), classified by Clocked <em>Decide</em> (category + probability),
          completed by Clocked <em>Fill</em> (structured expense record), and screened by Clocked <em>PII</em>{" "}
          (personal data masked).
        </div>
      ) : (
        <div className="banner demo">
          ⚠️ <strong>Demo mode — no Clocked API key is set on this server.</strong> Live AI extraction is off, and
          nothing here pretends otherwise. To turn live AI on: create a key at{" "}
          <a href="https://clocked.rezolve.ai/account" target="_blank" rel="noreferrer">
            clocked.rezolve.ai/account
          </a>{" "}
          and set <code>CLOCKED_API_KEY</code> in <code>.env.local</code> (see README). Meanwhile the sample receipt
          below tests the ledger with a clearly-labelled, non-AI demo parser.
        </div>
      )}

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner demo">{notice}</div>}

      <section className="card">
        <h2>1 · Add a receipt</h2>
        <label>
          Receipt photo <span className="hint">(PNG / JPEG / WebP, max 2.4 MB — Clocked reads the image directly)</span>
        </label>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          capture="environment"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        {imageDataUrl && (
          <div>
            <img className="preview" src={imageDataUrl} alt={`Receipt photo ${imageName}`} />
            <div className="hint">{imageName}</div>
            <button className="secondary" onClick={() => { setImageDataUrl(null); setImageName(""); }}>
              Remove photo
            </button>
          </div>
        )}
        <label>
          Or paste the receipt text <span className="hint">(works without a photo)</span>
        </label>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={"AL-FATAH SUPER STORE\nBasmati Rice 5kg  2 x 1450.00  2900.00\nTOTAL  6746.25"} />
        <div>
          <button disabled={busy || (!text.trim() && !imageDataUrl)} onClick={() => parseReceipt(false)}>
            {busy ? "Reading receipt…" : live ? "✨ Extract with Clocked AI" : "Extract (needs API key)"}
          </button>
          <button className="secondary" disabled={busy} onClick={() => parseReceipt(true)}>
            Try the sample receipt (demo — not AI)
          </button>
        </div>
        <p className="hint">
          Live path: Clocked <code>/clocked/extract</code> copies values verbatim from the photo/text, then Clocked{" "}
          <code>/clocked/decide</code> picks one category per line with a probability, Clocked{" "}
          <code>/clocked/fill</code> completes the structured expense record (business purpose, tax-deductible, summary),
          and Clocked <code>/clocked/pii</code> screens the text for personal data and shows a masked copy. Totals are
          then re-checked with exact integer-cents arithmetic on the server — the AI never does the maths.
        </p>
      </section>

      {last && (
        <section className="card">
          <h2>
            2 · Review the extraction
            <span className={`tag ${last.source}`}>{last.source === "live" ? "LIVE — Clocked AI" : "DEMO — not AI"}</span>
            {last.source === "live" && last.clocked && (
              <span className="tag live">
                Clocked: {last.clocked.credits ?? "?"} credits
                {last.clocked.costUsd !== null && last.clocked.costUsd !== undefined ? ` · $${last.clocked.costUsd}` : ""}
                {last.clocked.decideUsed ? " · Decide used" : " · Decide unavailable, keyword categories"}
                {last.clocked.fillUsed ? " · Fill used" : ""}
                {last.clocked.piiUsed ? " · PII screened" : ""}
              </span>
            )}
          </h2>
          <p>
            <strong>{last.receipt.vendor}</strong> · {last.receipt.date || "Unknown date"}
            {last.receipt.receiptNumber ? ` · Receipt ${last.receipt.receiptNumber}` : ""} · {last.receipt.paymentMethod} ·{" "}
            {last.receipt.currency}
          </p>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Unit</th>
                <th className="num">Line total</th>
                <th>Category</th>
              </tr>
            </thead>
            <tbody>
              {last.receipt.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.description}
                    {l.categorySource === "clocked" && l.categoryConfidence !== null && (
                      <span className="pill">AI {(l.categoryConfidence * 100).toFixed(0)}% sure</span>
                    )}
                    {l.categorySource === "keyword" && <span className="pill">keyword guess — please check</span>}
                  </td>
                  <td className="num">{l.qty}</td>
                  <td className="num">{l.unitPriceCents === null ? "—" : formatCents(l.unitPriceCents, last.receipt.currency)}</td>
                  <td className="num">{l.totalCents === null ? "—" : formatCents(l.totalCents, last.receipt.currency)}</td>
                  <td>{l.category}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Subtotal: <strong>{last.receipt.subtotalCents === null ? "—" : formatCents(last.receipt.subtotalCents, last.receipt.currency)}</strong> · Tax:{" "}
            <strong>{last.receipt.taxCents === null ? "—" : formatCents(last.receipt.taxCents, last.receipt.currency)}</strong> · Total:{" "}
            <strong>{last.receipt.totalCents === null ? "—" : formatCents(last.receipt.totalCents, last.receipt.currency)}</strong>
          </p>
          {last.check.issues.length === 0 ? (
            <p className="okline">✅ Arithmetic checks out exactly: lines sum to the printed total.</p>
          ) : (
            last.check.issues.map((issue, i) => (
              <p className="issue" key={i}>
                ⚠️ {issue}
              </p>
            ))
          )}
          {last.duplicates && last.duplicates.length > 0 && (
            <p className="issue">
              ⚠️ Possible duplicate of: {last.duplicates.map((d) => `${d.vendor} · ${d.date} · ${formatCents(d.totalCents ?? 0, last.receipt.currency)}`).join("; ")}
            </p>
          )}
          <div className="record">
            <h3>
              Expense record — Clocked Fill
              <span className={`tag ${last.source}`}>{last.source === "live" ? "LIVE — Clocked Fill" : "DEMO — not AI"}</span>
            </h3>
            {last.receipt.expenseRecord ? (
              <>
                <p>
                  Business purpose: <strong>{last.receipt.expenseRecord.businessPurpose ?? "Not established"}</strong>
                  {" · "}Tax-deductible:{" "}
                  <strong>
                    {last.receipt.expenseRecord.taxDeductible === true
                      ? "Yes"
                      : last.receipt.expenseRecord.taxDeductible === false
                        ? "No"
                        : "Not established"}
                  </strong>
                </p>
                {last.receipt.expenseRecord.summary && <p className="hint">{last.receipt.expenseRecord.summary}</p>}
              </>
            ) : (
              <p className="hint">
                Fill did not establish an expense record from this receipt — you can set the purpose and
                tax-deductible flag when editing the receipt in the ledger below.
              </p>
            )}
          </div>
          {last.receipt.privacy && (
            <div className="record">
              <h3>
                Privacy check — Clocked PII
                <span className={`tag ${last.source}`}>{last.source === "live" ? "LIVE — Clocked PII" : "DEMO — not AI"}</span>
              </h3>
              {last.receipt.privacy.findings.length === 0 ? (
                <p className="okline">✅ No personal data found on this receipt.</p>
              ) : (
                <>
                  <p>
                    ⚠️ {last.receipt.privacy.findings.length} personal item
                    {last.receipt.privacy.findings.length === 1 ? "" : "s"} found and masked:{" "}
                    {last.receipt.privacy.findings.map((f) => `${piiTypeLabel(f.type)} (${f.value})`).join(", ")}.
                  </p>
                  {last.receipt.privacy.maskedText && (
                    <details>
                      <summary>See masked receipt text</summary>
                      <pre className="masked">{last.receipt.privacy.maskedText}</pre>
                    </details>
                  )}
                </>
              )}
            </div>
          )}
          <div>
            <button onClick={addToLedger}>Add to ledger</button>
            <button className="secondary" onClick={() => setLast(null)}>
              Discard
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h2>
          3 · Your ledger <span className="hint">({ledger.length} receipt{ledger.length === 1 ? "" : "s"} · saved in this browser)</span>
        </h2>
        {ledger.length === 0 ? (
          <p className="hint">No receipts yet. Extract one above — or try the sample receipt demo to see the ledger work.</p>
        ) : (
          <>
            <label>
              Search receipts <span className="hint">(vendor or item name)</span>
            </label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="e.g. Al-Fatah or Rice"
            />
            {search.trim() && shown.length === 0 && <p className="hint">No receipts match “{search}”.</p>}
            <div className="grid">
              <div>
                <h3>Monthly totals</h3>
                {totals.map((m) => (
                  <p key={m.month}>
                    <strong>{m.month}</strong>: {formatCents(m.totalCents)} across {m.receiptCount} receipt{m.receiptCount === 1 ? "" : "s"}
                  </p>
                ))}
                <p>
                  <strong>Grand total: {formatCents(grandTotal)}</strong>
                </p>
              </div>
              <div>
                <h3>By category</h3>
                {cats.map((c) => (
                  <p key={c.category}>
                    {c.category}: <strong>{formatCents(c.totalCents)}</strong> ({c.lineCount} line{c.lineCount === 1 ? "" : "s"})
                  </p>
                ))}
              </div>
              <div>
                <h3>Tax summary</h3>
                {tax.every((t) => t.deductibleCount === 0) ? (
                  <p className="hint">
                    No tax-deductible receipts yet. Clocked Fill marks business receipts automatically; receipts
                    without a Fill record are never counted as deductible.
                  </p>
                ) : (
                  tax
                    .filter((t) => t.deductibleCount > 0)
                    .map((t) => (
                      <p key={t.month}>
                        <strong>{t.month}</strong>: deductible <strong>{formatCents(t.deductibleCents)}</strong> across{" "}
                        {t.deductibleCount} receipt{t.deductibleCount === 1 ? "" : "s"}
                      </p>
                    ))
                )}
              </div>
            </div>
            <div>
              <button onClick={exportCsv}>⬇ Export CSV (Excel / Sheets)</button>
              <button className="secondary" onClick={exportJson}>
                Export JSON
              </button>
              <button
                className="danger"
                onClick={() => {
                  if (confirm("Clear the whole ledger? This cannot be undone.")) {
                    setLedger([]);
                    setLast(null);
                  }
                }}
              >
                Clear ledger
              </button>
            </div>
            {shown.map((r) => {
              const check = checkReceipt(r);
              const dups = findDuplicateReceipts(r, ledger);
              return (
                <div key={r.id} style={{ borderTop: "1px solid #eee9df", marginTop: 16, paddingTop: 8 }}>
                  <p>
                    <strong>{r.vendor}</strong> · {r.date || "Unknown date"}
                    {r.receiptNumber ? ` · #${r.receiptNumber}` : ""} · Total:{" "}
                    <strong>{r.totalCents === null ? "—" : formatCents(r.totalCents, r.currency)}</strong>
                    <span className={`tag ${r.source}`}>{r.source === "live" ? "LIVE — Clocked AI" : "DEMO — not AI"}</span>
                    {check.issues.length > 0 && <span className="tag warn">{check.issues.length} issue{check.issues.length === 1 ? "" : "s"}</span>}
                    {dups.length > 0 && <span className="tag warn">possible duplicate</span>}
                    <button className="secondary" style={{ marginLeft: 12, padding: "4px 10px" }} onClick={() => setEditingId(editingId === r.id ? null : r.id)}>
                      {editingId === r.id ? "Done editing" : "Edit receipt"}
                    </button>
                    <button className="danger" style={{ padding: "4px 10px" }} onClick={() => setLedger((prev) => prev.filter((x) => x.id !== r.id))}>
                      Remove
                    </button>
                  </p>
                  {r.expenseRecord ? (
                    <p className="hint">
                      📋 {r.expenseRecord.businessPurpose ?? "Purpose not set"} · Tax-deductible:{" "}
                      {r.expenseRecord.taxDeductible === true ? "Yes" : r.expenseRecord.taxDeductible === false ? "No" : "—"}
                      {r.expenseRecord.summary ? ` · ${r.expenseRecord.summary}` : ""}
                      <span className={`tag ${r.source}`}>{r.expenseRecord.source === "clocked" ? "Clocked Fill" : "Demo record"}</span>
                    </p>
                  ) : (
                    <p className="hint">📋 No expense record — set the purpose below when editing.</p>
                  )}
                  {editingId === r.id && (
                    <div className="record">
                      <label>Business purpose</label>
                      <select
                        value={r.expenseRecord?.businessPurpose ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateReceipt(r.id, {
                            expenseRecord: {
                              businessPurpose: (v === "" ? null : v) as BusinessPurpose | null,
                              taxDeductible: r.expenseRecord?.taxDeductible ?? null,
                              summary: r.expenseRecord?.summary ?? null,
                              source: r.expenseRecord?.source ?? "demo",
                            },
                          });
                        }}
                      >
                        <option value="">Not set</option>
                        {BUSINESS_PURPOSES.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                      <label>
                        <input
                          type="checkbox"
                          checked={r.expenseRecord?.taxDeductible === true}
                          onChange={(e) =>
                            updateReceipt(r.id, {
                              expenseRecord: {
                                businessPurpose: r.expenseRecord?.businessPurpose ?? null,
                                taxDeductible: e.target.checked,
                                summary: r.expenseRecord?.summary ?? null,
                                source: r.expenseRecord?.source ?? "demo",
                              },
                            })
                          }
                        />{" "}
                        Tax-deductible business expense
                      </label>
                    </div>
                  )}
                  {check.issues.map((issue, i) => (
                    <p className="issue" key={i}>
                      ⚠️ {issue}
                    </p>
                  ))}
                  <table>
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="num">Qty</th>
                        <th className="num">Line total</th>
                        <th>Category</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.lines.map((l) => (
                        <tr key={l.id}>
                          <td>
                            {editingId === r.id ? (
                              <input
                                type="text"
                                value={l.description}
                                onChange={(e) => updateLine(r.id, l.id, { description: e.target.value })}
                              />
                            ) : (
                              l.description
                            )}
                          </td>
                          <td className="num">{l.qty}</td>
                          <td className="num">
                            {editingId === r.id ? (
                              <input
                                type="text"
                                value={l.totalCents === null ? "" : (l.totalCents / 100).toFixed(2)}
                                onChange={(e) => {
                                  const n = parseFloat(e.target.value);
                                  updateLine(r.id, l.id, { totalCents: Number.isFinite(n) ? Math.round(n * 100) : null });
                                }}
                              />
                            ) : l.totalCents === null ? (
                              "—"
                            ) : (
                              formatCents(l.totalCents, r.currency)
                            )}
                          </td>
                          <td>
                            {editingId === r.id ? (
                              <select value={l.category} onChange={(e) => updateLine(r.id, l.id, { category: e.target.value as Category })}>
                                {CATEGORIES.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              l.category
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </>
        )}
      </section>

      <footer>
        Built for the Clocked Build Challenge (deadline Tue Nov 10, 2026, 11:59 PM ET). Uses Clocked{" "}
        <code>/clocked/extract</code> + <code>/clocked/decide</code> via the official <code>clocked-sdk</code>. Money
        is integer cents throughout — the AI reads, the code does the maths. Receipts stay in your browser (localStorage);
        photos are sent only to Clocked, never stored.
      </footer>
    </main>
  );
}

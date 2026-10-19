import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../db/client';
import type { CardsMeta, ImportSummary, Owned } from '../db/repo';
import { chooseFinish, colorLabel, formatUsd } from '../lib/cards';
import type { DiffRow } from '../lib/diff';
import type { Condition, Finish, FoilMode, Printing, Scan, ScanRow, Session } from '../lib/types';
import { CONDITIONS, FINISH_LABEL } from '../lib/types';
import { CardPicker, ownedText } from './CardPicker';
import { FinishTag, Segmented, Sheet, Stepper, Thumb, Toast, errorText } from './common';
import { ExportSheet } from './ExportSheet';
import { ScanView } from './ScanView';
import { feedback } from './feedback';
import type { Route } from './nav';
import { ImportRowsSheet } from './CollectionView';
import { pickFile } from './share';

const KIND_LABEL: Record<Session['kind'], string> = { scan: 'just scan', add: 'add new', verify: 'verify' };

/** Title for a review-queue card: the name when all candidates agree, otherwise a prompt. */
function reviewTitle(r: Scan): string {
  const c = r.candidates;
  return c.length && c.every((x) => x.name === c[0].name) ? c[0].name : 'Pick the printing';
}

const FOIL_OPTIONS: { value: FoilMode; label: string }[] = [
  { value: 'nonfoil', label: 'Non-foil' },
  { value: 'foil', label: 'Foil' },
  { value: 'ask', label: 'Ask each' },
];

type ToastState = { text: string; undo?: () => Promise<void> } | null;

export function SessionView({ id, meta, back }: { id: number; meta: CardsMeta | null; back: () => void; go: (r: Route) => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [owned, setOwned] = useState<Record<string, Owned>>({});
  const [verifyImport, setVerifyImport] = useState<ImportSummary | null>(null);
  const [diff, setDiff] = useState<DiffRow[]>([]);
  const [sheet, setSheet] = useState<
    | { kind: 'add' }
    | { kind: 'scan' }
    | { kind: 'finish'; printing: Printing }
    | { kind: 'edit'; scanId: number }
    | { kind: 'export' }
    | { kind: 'menu' }
    | { kind: 'rename' }
    | { kind: 'unmatched'; importId: number }
    | null
  >(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const s = await db.getSession(id);
    setSession(s);
    if (!s) return;
    const r = await db.scanRows(id);
    setRows(r);
    setOwned(s.kind === 'add' ? await db.owned(r.map((x) => x.printing_id).filter((x): x is string => !!x)) : {});
    if (s.kind === 'verify') {
      setVerifyImport(await db.verifyImport(id));
      setDiff(await db.differences(id));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!session) return <div className="app"><div className="center muted">Loading…</div></div>;

  const saved = rows.filter((r) => r.status !== 'review');
  const copies = saved.reduce((n, r) => n + r.qty, 0);
  const total = saved.reduce((n, r) => n + (r.unit_price ?? 0) * r.qty, 0);
  const unpriced = saved.filter((r) => r.unit_price == null).length;
  const reviewCount = rows.length - saved.length;

  const addPrinting = async (p: Printing, finish?: Finish) => {
    setError('');
    try {
      const s = await db.addScan(id, { printing_id: p.id, finish });
      feedback(s.status);
      setSheet(null);
      await load();
      setToast({ text: `Added ${s.name}${s.flag_reason ? ` · ${s.flag_reason}` : ''}` });
    } catch (e) {
      feedback('review');
      setError(errorText(e));
    }
  };

  const onPick = (p: Printing) => {
    if (chooseFinish(p.finishes, session.foil_mode).finish == null) setSheet({ kind: 'finish', printing: p });
    else addPrinting(p);
  };

  const removeScan = async (scanId: number, label = 'Removed') => {
    const gone = await db.deleteScan(scanId);
    await load();
    if (gone) {
      setToast({
        text: `${label} ${gone.scan.name || `scan #${gone.scan.seq}`}`,
        undo: async () => {
          await db.restoreScan(gone);
          await load();
        },
      });
    }
  };

  const undoLast = async () => {
    const last = await db.lastScan(id);
    if (last) await removeScan(last.id, 'Undid');
  };

  const setCondition = async (c: Condition) => setSession(await db.updateSession(id, { default_condition: c }));

  const importExpected = async () => {
    const file = await pickFile('.csv,text/csv');
    if (!file) return;
    try {
      const sum = await db.importCsv(await file.text(), file.name, 'verify', id);
      await load();
      setToast({ text: `Imported ${sum.copies} copies from ${file.name}${sum.rows - sum.matched_rows ? ` · ${sum.rows - sum.matched_rows} rows unmatched` : ''}` });
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="app">
      <div className="bar">
        <button className="btn icon ghost" aria-label="Back" onClick={back}>‹</button>
        <button className="title-btn" onClick={() => setSheet({ kind: 'rename' })} aria-label="Rename session">
          <h1>{session.name}</h1>
        </button>
        <button className="btn icon ghost" aria-label="Session options" onClick={() => setSheet({ kind: 'menu' })}>⋯</button>
      </div>

      <div className="scroll">
        <div className="stats">
          <div><b>{copies}</b><span>cards</span></div>
          <div><b>{formatUsd(total)}</b><span>{unpriced ? `${unpriced} without price` : 'total'}</span></div>
          <div><b>{FOIL_OPTIONS.find((o) => o.value === session.foil_mode)?.label}</b><span>{KIND_LABEL[session.kind]}</span></div>
        </div>
        {reviewCount > 0 && <p className="err small">{reviewCount} cards still need review.</p>}

        <div className="field-label">Condition for the next cards</div>
        <Segmented<Condition> compact value={session.default_condition} onChange={setCondition} options={CONDITIONS.map((c) => ({ value: c, label: c }))} label="Condition" />

        {session.kind === 'verify' && (
          <VerifyPanel
            imp={verifyImport}
            diff={diff}
            onImport={importExpected}
            onShowUnmatched={() => verifyImport && setSheet({ kind: 'unmatched', importId: verifyImport.id })}
          />
        )}

        {error && <div className="panel warn"><span className="err">{error}</span></div>}
        {!meta && <div className="panel warn">Card data isn’t installed. Go to Card data on the home screen first.</div>}

        {rows.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center', marginTop: 28 }}>No cards yet. Tap Scan, or Search / add by name.</p>
        ) : (
          <ul className="list">
            {rows.map((r) => (
              <SwipeRow key={r.id} onDelete={() => removeScan(r.id)}>
                <button className="item" onClick={() => setSheet({ kind: 'edit', scanId: r.id })}>
                  <span className={`status ${r.status}`} />
                  <Thumb id={r.printing_id} ver={r.img_ver} setCode={r.set_code} />
                  <div className="grow">
                    <div className="name">
                      {r.qty > 1 ? `${r.qty}× ` : ''}
                      {r.status === 'review' ? <><span className="tag review">REVIEW</span>{reviewTitle(r)}</> : r.name}
                    </div>
                    <div className="sub">
                      {r.status === 'review'
                        ? <>#{r.seq} · {r.candidates.length ? r.candidates.slice(0, 3).map((c) => `${c.set_code.toUpperCase()} ${c.collector_number}`).join(' | ') : 'no candidates'}</>
                        : <><FinishTag finish={r.finish} />[{r.set_code.toUpperCase()} {r.collector_number}] · {r.condition} · {colorLabel(r.colors, r.front_type)}</>}
                    </div>
                    {r.flag_reason ? <div className="sub" style={{ color: 'var(--check)' }}>{r.flag_reason}</div>
                      : r.printing_id && ownedText(owned[r.printing_id]) ? <div className="sub">{ownedText(owned[r.printing_id])}</div> : null}
                  </div>
                  <div className="right">{formatUsd(r.unit_price == null ? null : r.unit_price * r.qty)}</div>
                </button>
              </SwipeRow>
            ))}
          </ul>
        )}
        {rows.length > 0 && <p className="small muted" style={{ textAlign: 'center' }}>Swipe left to delete · tap to edit</p>}
      </div>

      <div className="dock-col">
        <button className="btn primary big block" disabled={!meta} onClick={() => setSheet({ kind: 'scan' })}>Scan</button>
        <div className="row-gap">
          <button className="btn" disabled={rows.length === 0} onClick={undoLast}>Undo</button>
          <button className="btn" style={{ flex: 1.6 }} disabled={!meta} onClick={() => setSheet({ kind: 'add' })}>Search / add by name</button>
          <button className="btn" onClick={() => setSheet({ kind: 'export' })}>Export</button>
        </div>
      </div>

      {toast && (
        <Toast onDone={() => setToast(null)}>
          <span className="small">{toast.text}</span>
          {toast.undo && (
            <button className="btn" onClick={async () => { const u = toast.undo!; setToast(null); await u(); }}>Restore</button>
          )}
        </Toast>
      )}

      {sheet?.kind === 'add' && <CardPicker onPick={onPick} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'scan' && (
        <ScanView
          session={session}
          onClose={() => { setSheet(null); load(); }}
          onSearch={() => { setSheet(null); setTimeout(() => setSheet({ kind: 'add' }), 50); }}
          onChanged={load}
        />
      )}
      {sheet?.kind === 'finish' && (
        <Sheet title={`${sheet.printing.name} [${sheet.printing.set_code.toUpperCase()} ${sheet.printing.collector_number}]`} onClose={() => setSheet(null)}>
          <div className="stack">
            {sheet.printing.finishes.map((f) => (
              <button key={f} className={`btn big block${f !== 'nonfoil' ? ' primary' : ''}`} onClick={() => addPrinting(sheet.printing, f)}>
                {FINISH_LABEL[f]}
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {sheet?.kind === 'edit' && (
        <EditSheet scanId={sheet.scanId} onClose={() => setSheet(null)} onChanged={load} onDelete={async () => { const sid = sheet.scanId; setSheet(null); await removeScan(sid); }} />
      )}
      {sheet?.kind === 'export' && <ExportSheet session={session} rows={rows} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'rename' && (
        <RenameSheet name={session.name} onClose={() => setSheet(null)} onSave={async (name) => { setSession(await db.updateSession(id, { name })); setSheet(null); }} />
      )}
      {sheet?.kind === 'menu' && (
        <Sheet title="Session" onClose={() => setSheet(null)}>
          <div className="field-label">Foil mode for new cards</div>
          <Segmented<FoilMode> value={session.foil_mode} options={FOIL_OPTIONS} onChange={async (m) => setSession(await db.updateSession(id, { foil_mode: m }))} />
          <div className="stack" style={{ marginTop: 18 }}>
            <button className="btn block" onClick={() => setSheet({ kind: 'rename' })}>Rename</button>
            {session.kind === 'verify' && <button className="btn block" onClick={() => { setSheet(null); importExpected(); }}>Replace expected list</button>}
            <button
              className="btn block danger"
              onClick={async () => {
                if (!confirm(`Delete "${session.name}" and its ${copies} cards? This can't be undone.`)) return;
                await db.deleteSession(id);
                setSheet(null);
                setTimeout(back, 50);
              }}
            >
              Delete session
            </button>
          </div>
        </Sheet>
      )}
      {sheet?.kind === 'unmatched' && <ImportRowsSheet importId={sheet.importId} onClose={() => setSheet(null)} />}
    </div>
  );
}

/** Swipe left past the threshold to delete. Vertical scrolling still works. */
function SwipeRow({ children, onDelete }: { children: React.ReactNode; onDelete: () => void }) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number; horizontal: boolean | null } | null>(null);
  const swiped = useRef(false);
  const THRESHOLD = 110;

  return (
    <li
      className="swipe"
      onPointerDown={(e) => {
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, horizontal: null };
        swiped.current = false;
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        const mx = e.clientX - s.x;
        const my = e.clientY - s.y;
        if (s.horizontal == null && Math.abs(mx) + Math.abs(my) > 10) s.horizontal = Math.abs(mx) > Math.abs(my);
        if (s.horizontal) {
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          setDx(Math.min(0, mx));
        }
      }}
      onPointerUp={() => {
        if (start.current?.horizontal) swiped.current = true;
        if (dx < -THRESHOLD) onDelete();
        setDx(0);
        start.current = null;
      }}
      onPointerCancel={() => {
        setDx(0);
        start.current = null;
      }}
      onClickCapture={(e) => {
        // A swipe that ends over the row shouldn't also open it.
        if (swiped.current) {
          e.stopPropagation();
          swiped.current = false;
        }
      }}
    >
      <div className="behind" style={{ opacity: dx < -20 ? 1 : 0 }}>{dx < -THRESHOLD ? 'Release to delete' : 'Delete'}</div>
      <div style={{ transform: `translateX(${dx}px)`, transition: dx === 0 ? 'transform 0.18s' : 'none' }}>{children}</div>
    </li>
  );
}

function EditSheet({ scanId, onClose, onChanged, onDelete }: { scanId: number; onClose: () => void; onChanged: () => Promise<void>; onDelete: () => void }) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [printing, setPrinting] = useState<Printing | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  useEffect(() => {
    db.getScan(scanId).then(async (s) => {
      setScan(s);
      if (s?.printing_id) setPrinting(await db.getPrinting(s.printing_id));
    });
    let url: string | null = null;
    db.getPhoto(scanId).then((jpeg) => {
      if (!jpeg) return;
      url = URL.createObjectURL(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));
      setPhotoUrl(url);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [scanId]);

  const update = async (patch: Parameters<typeof db.updateScan>[1]) => {
    setError('');
    try {
      const s = await db.updateScan(scanId, patch);
      setScan(s);
      if (patch.printing_id) setPrinting(await db.getPrinting(patch.printing_id));
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!scan) return null;
  const finishes = printing?.finishes ?? [scan.finish];
  const review = scan.status === 'review' || !scan.printing_id;

  return (
    <Sheet title={review ? `Scan #${scan.seq}: ${reviewTitle(scan)}` : scan.name} onClose={onClose}>
      {photoUrl && <img src={photoUrl} alt="Scanned card" style={{ width: '100%', maxHeight: 320, objectFit: 'contain', borderRadius: 10, marginBottom: 8 }} />}
      {scan.candidates.length > 0 && (review || scan.status === 'check') && (
        <>
          <div className="field-label">{review ? 'Tap the right printing' : 'Candidates'}</div>
          <ul className="list">
            {scan.candidates.slice(0, 3).map((c) => (
              <li key={c.printing_id}>
                <button className="item" aria-pressed={c.printing_id === scan.printing_id} onClick={() => update({ printing_id: c.printing_id })}>
                  <Thumb id={c.printing_id} ver={c.img_ver ?? null} setCode={c.set_code} />
                  <div className="grow">
                    <div className="name">{c.name}</div>
                    <div className="sub">[{c.set_code.toUpperCase()} {c.collector_number}]{c.score != null ? ` · ${Math.round(c.score * 100)}%` : ''}</div>
                  </div>
                  {c.printing_id === scan.printing_id && <div className="right">✓</div>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <button className="item" onClick={() => setPicking(true)}>
        <Thumb id={scan.printing_id} ver={scan.img_ver} setCode={scan.set_code} />
        <div className="grow">
          <div className="name">{review ? 'Search all cards' : scan.set_name}</div>
          {!review && <div className="sub">[{scan.set_code.toUpperCase()} {scan.collector_number}]</div>}
        </div>
        <div className="right">{review ? '›' : 'Change printing ›'}</div>
      </button>
      {scan.flag_reason && <p className="small" style={{ color: 'var(--check)' }}>{scan.flag_reason}</p>}

      <div className="field-label">Finish</div>
      <Segmented<Finish>
        value={scan.finish}
        onChange={(f) => update({ finish: f })}
        options={(['nonfoil', 'foil', 'etched'] as Finish[]).map((f) => ({ value: f, label: FINISH_LABEL[f], disabled: !finishes.includes(f) }))}
      />
      <div className="field-label">Condition</div>
      <Segmented<Condition> value={scan.condition} onChange={(c) => update({ condition: c })} options={CONDITIONS.map((c) => ({ value: c, label: c }))} />
      <div className="field-label">Quantity</div>
      <Stepper value={scan.qty} onChange={(n) => update({ qty: n })} />
      {error && <p className="err">{error}</p>}
      <div className="row-gap" style={{ marginTop: 18 }}>
        <button className="btn danger" style={{ flex: 1 }} onClick={onDelete}>Delete</button>
        <button className="btn primary" style={{ flex: 2 }} onClick={onClose}>Done</button>
      </div>
      {picking && (
        <CardPicker
          title="Change printing"
          oracleId={printing?.oracle_id ?? null}
          onClose={() => setPicking(false)}
          onPick={async (p) => {
            setPicking(false);
            await update({ printing_id: p.id });
          }}
        />
      )}
    </Sheet>
  );
}

function RenameSheet({ name, onClose, onSave }: { name: string; onClose: () => void; onSave: (n: string) => void }) {
  const [value, setValue] = useState(name);
  return (
    <Sheet title="Rename session" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); onSave(value); }}>
        <input className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn primary big block" style={{ marginTop: 12 }} type="submit">Save</button>
      </form>
    </Sheet>
  );
}

function VerifyPanel({ imp, diff, onImport, onShowUnmatched }: { imp: ImportSummary | null; diff: DiffRow[]; onImport: () => void; onShowUnmatched: () => void }) {
  const [open, setOpen] = useState(false);
  if (!imp) {
    return (
      <div className="panel warn">
        <h2>Expected list</h2>
        <p className="small muted">Import the rows you are verifying (CSV from the Master sheet: Card Name, Set Code, Collector #, Finish, Quantity).</p>
        <button className="btn primary block" onClick={onImport}>Import expected list</button>
      </div>
    );
  }
  const count = (t: DiffRow['type']) => diff.filter((d) => d.type === t).reduce((n, d) => n + Math.abs(d.qty_diff), 0);
  const unmatched = imp.rows - imp.matched_rows;
  return (
    <div className="panel">
      <h2>Expected: {imp.matched_copies} copies</h2>
      <p className="small muted">{imp.filename}</p>
      {unmatched > 0 && (
        <button className="btn block" style={{ marginBottom: 8 }} onClick={onShowUnmatched}>
          {unmatched} rows couldn’t be matched; they’re listed as “Not checked”
        </button>
      )}
      <div className="stats">
        <div><b>{count('Missing')}</b><span>missing</span></div>
        <div><b>{count('Extra')}</b><span>extra</span></div>
        <div><b>{count('Wrong printing') + count('Wrong finish')}</b><span>wrong</span></div>
      </div>
      {diff.length > 0 && (
        <button className="btn block" style={{ marginTop: 8 }} onClick={() => setOpen(!open)}>
          {open ? 'Hide differences' : `Show ${diff.length} differences`}
        </button>
      )}
      {open && (
        <ul className="list">
          {diff.map((d, i) => (
            <li key={i} className="item" style={{ minHeight: 0 }}>
              <div className="grow">
                <div className="name">{d.name}</div>
                <div className="sub">{d.type} · {d.color}</div>
                <div className="sub">{d.expected && `Expected ${d.expected}`}{d.expected && d.found ? ' · ' : ''}{d.found && `Found ${d.found}`}</div>
              </div>
              <div className="right">{d.type === 'Not checked' ? '' : d.type === 'Missing' || d.type === 'Extra' ? (d.qty_diff > 0 ? `+${d.qty_diff}` : d.qty_diff) : `×${d.qty_diff}`}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

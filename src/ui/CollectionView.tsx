import { useEffect, useState } from 'react';
import { db } from '../db/client';
import type { CardsMeta, ImportRowView, ImportSummary } from '../db/repo';
import { Sheet, errorText } from './common';
import type { Route } from './nav';
import { pickFile } from './share';

export function CollectionView({ meta, back }: { meta: CardsMeta | null; back: () => void; go: (r: Route) => void }) {
  const [imp, setImp] = useState<ImportSummary | null>(null);
  const [notes, setNotes] = useState<ImportRowView[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    const i = await db.collectionImport();
    setImp(i);
    setNotes(i ? (await db.importRows(i.id)).filter((r) => r.note) : []);
  };
  useEffect(() => {
    load();
  }, []);

  const doImport = async () => {
    setError('');
    if (imp && !confirm('Replace the current collection with a new import?')) return;
    const file = await pickFile('.csv,text/csv');
    if (!file) return;
    setBusy(true);
    try {
      await db.importCsv(await file.text(), file.name, 'collection');
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const unmatched = notes.filter((r) => !r.printing_id);
  const adjusted = notes.filter((r) => r.printing_id);

  return (
    <div className="app">
      <div className="bar">
        <button className="btn icon ghost" aria-label="Back" onClick={back}>‹</button>
        <h1>Collection</h1>
      </div>
      <div className="scroll">
        <p className="small muted">
          Import a CSV exported from your Master sheet (Card Name, Set Code, Collector #, Finish, Quantity). Each card you add then shows
          “You already have N of this printing”.
        </p>
        {!meta && <div className="panel warn">Install card data first so rows can be matched to printings.</div>}
        {imp && (
          <div className="panel">
            <h2>{imp.filename}</h2>
            <p className="muted small">Imported {new Date(imp.imported_at).toLocaleString()}</p>
            <div className="stats">
              <div><b>{imp.matched_copies.toLocaleString()}</b><span>copies matched</span></div>
              <div><b>{imp.rows.toLocaleString()}</b><span>rows</span></div>
              <div><b style={{ color: unmatched.length ? 'var(--bad)' : undefined }}>{unmatched.length}</b><span>unmatched</span></div>
            </div>
          </div>
        )}
        {error && <div className="panel warn"><span className="err">{error}</span></div>}
        <button className="btn primary big block" disabled={!meta || busy} onClick={doImport}>
          {busy ? 'Importing…' : imp ? 'Import again (replace)' : 'Import collection CSV'}
        </button>

        {unmatched.length > 0 && (
          <div className="panel warn">
            <h2>Not matched ({unmatched.length})</h2>
            <p className="small muted">These rows are not counted. Nothing was guessed. Fix them in the sheet and import again.</p>
            <RowList rows={showAll ? unmatched : unmatched.slice(0, 50)} />
            {unmatched.length > 50 && !showAll && <button className="btn block" onClick={() => setShowAll(true)}>Show all {unmatched.length}</button>}
          </div>
        )}
        {adjusted.length > 0 && (
          <div className="panel">
            <h2>Matched with a note ({adjusted.length})</h2>
            <RowList rows={adjusted} />
          </div>
        )}
        {imp && (
          <button className="btn block danger" style={{ marginTop: 12 }} onClick={async () => { if (confirm('Remove the imported collection from this device?')) { await db.clearCollection(); await load(); } }}>
            Clear collection
          </button>
        )}
      </div>
    </div>
  );
}

function RowList({ rows }: { rows: ImportRowView[] }) {
  return (
    <ul className="list">
      {rows.map((r) => (
        <li key={r.row_num} className="item" style={{ minHeight: 0 }}>
          <div className="grow">
            <div className="name">{r.card_name || '(no name)'}</div>
            <div className="sub">Row {r.row_num} · {r.set_code || '—'} {r.collector_number || '—'} · {r.finish_label || 'Non-foil'} · ×{r.qty}</div>
            <div className="sub" style={{ whiteSpace: 'normal' }}>{r.note}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ImportRowsSheet({ importId, onClose }: { importId: number; onClose: () => void }) {
  const [rows, setRows] = useState<ImportRowView[]>([]);
  useEffect(() => {
    db.importRows(importId, true).then(setRows);
  }, [importId]);
  return (
    <Sheet title={`Unmatched rows (${rows.length})`} onClose={onClose}>
      <RowList rows={rows} />
    </Sheet>
  );
}

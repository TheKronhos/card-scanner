import { useState } from 'react';
import { db } from '../db/client';
import type { ExportKind } from '../db/repo';
import { masterLine } from '../lib/exports';
import type { ScanRow, Session } from '../lib/types';
import { Sheet, errorText } from './common';
import { copyText, shareFile } from './share';

const LABEL: Record<ExportKind, string> = {
  master: 'Master paste CSV',
  review: 'Review CSV',
  manabox: 'ManaBox CSV',
  differences: 'Differences CSV',
};

export function ExportSheet({ session, rows, onClose }: { session: Session; rows: ScanRow[]; onClose: () => void }) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const review = rows.filter((r) => r.status === 'review').length;

  const confirmReview = () => !review || confirm(`${review} cards still need review. They won't be in the export. Export anyway?`);

  const run = async (kind: ExportKind) => {
    setError('');
    if (!confirmReview()) return;
    try {
      const f = await db.exportSession(session.id, kind);
      const outcome = await shareFile(f.filename, f.text);
      setStatus(outcome === 'cancelled' ? '' : outcome === 'shared' ? `Shared ${f.filename}` : `Saved ${f.filename}`);
    } catch (e) {
      setError(errorText(e));
    }
  };

  // Plain lines (no CSV quoting) so a paste into Google Sheets lands one card per cell.
  const copyMaster = async () => {
    if (!confirmReview()) return;
    const lines: string[] = [];
    for (const r of [...rows].reverse()) {
      if (r.status === 'review' || !r.printing_id) continue;
      for (let i = 0; i < r.qty; i++) lines.push(masterLine(r.name, r.set_code, r.collector_number, r.finish));
    }
    setStatus((await copyText(lines.join('\n'))) ? `Copied ${lines.length} lines` : 'Copy failed; use the CSV instead');
  };

  const kinds: ExportKind[] = session.kind === 'verify' ? ['differences', 'review'] : ['master', 'review', 'manabox'];

  return (
    <Sheet title="Export" onClose={onClose}>
      {review > 0 && (
        <div className="panel warn">
          <b>{review} cards still need review.</b> They are left out until you pick their printing.
        </div>
      )}
      <div className="stack">
        {kinds.map((k, i) => (
          <button key={k} className={`btn big block${i === 0 ? ' primary' : ''}`} onClick={() => run(k)}>{LABEL[k]}</button>
        ))}
        {session.kind === 'add' && <button className="btn block" onClick={copyMaster}>Copy master paste to clipboard</button>}
      </div>
      <p className="small muted">
        {session.kind === 'verify'
          ? 'Differences: wrong printing, wrong finish, missing and extra copies compared with the imported list, plus rows that could not be checked.'
          : 'Master paste: one row per copy, “Card Name [SET NUM] Foil”. Review: one row per entry with color, price and flags. ManaBox: marketplace bulk upload.'}
      </p>
      {status && <p>{status}</p>}
      {error && <p className="err">{error}</p>}
    </Sheet>
  );
}

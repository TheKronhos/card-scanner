import { useEffect, useState } from 'react';
import { db } from '../db/client';
import type { CardsMeta } from '../db/repo';
import { formatUsd } from '../lib/cards';
import type { FoilMode, SessionKind, SessionSummary } from '../lib/types';
import { Segmented, Sheet, errorText } from './common';
import type { Route } from './nav';

const FOIL_LABEL: Record<FoilMode, string> = { nonfoil: 'Non-foil', foil: 'Foil', ask: 'Ask each card' };

export function Home({ meta, go }: { meta: CardsMeta | null; go: (r: Route) => void }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    db.listSessions().then(setSessions);
  }, []);

  return (
    <div className="app">
      <div className="bar">
        <h1>Card Scanner</h1>
        <button className="btn icon ghost" aria-label="About" onClick={() => go({ name: 'about' })}>ⓘ</button>
      </div>
      <div className="scroll">
        {!meta && (
          <div className="panel warn">
            <h2>Card data needed</h2>
            <p className="muted">Download the card list once (about 20 MB, Wi-Fi recommended). After that everything works offline.</p>
            <button className="btn primary block" onClick={() => go({ name: 'data' })}>Get card data</button>
          </div>
        )}

        <button className="btn primary big block" style={{ marginTop: 6 }} disabled={!meta} onClick={() => setCreating(true)}>
          New session
        </button>

        {sessions && sessions.length === 0 && <p className="muted" style={{ textAlign: 'center', marginTop: 32 }}>No sessions yet.</p>}
        <ul className="list">
          {sessions?.map((s) => (
            <li key={s.id}>
              <button className="item" onClick={() => go({ name: 'session', id: s.id })}>
                <div className="grow">
                  <div className="name">{s.name}</div>
                  <div className="sub">
                    {s.kind === 'verify' ? 'Verify · ' : ''}
                    {FOIL_LABEL[s.foil_mode]} · {new Date(s.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </div>
                </div>
                <div className="right">
                  <div>{s.copies} cards</div>
                  <div className="sub">{formatUsd(s.total_usd)}</div>
                  {s.review > 0 && <span className="tag review">{s.review} to review</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="dock">
        <button className="btn" onClick={() => go({ name: 'collection' })}>Collection</button>
        <button className="btn" onClick={() => go({ name: 'data' })}>Card data</button>
      </div>
      {creating && <NewSessionSheet onClose={() => setCreating(false)} onCreated={(id) => go({ name: 'session', id })} />}
    </div>
  );
}

function defaultName() {
  const d = new Date();
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function NewSessionSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [name, setName] = useState(defaultName);
  const [kind, setKind] = useState<SessionKind>('add');
  const [foil, setFoil] = useState<FoilMode>('nonfoil');
  const [error, setError] = useState('');

  const start = async () => {
    try {
      const s = await db.createSession(name, kind, foil);
      onClose();
      // Let the sheet's history entry unwind before pushing the session screen.
      setTimeout(() => onCreated(s.id), 50);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Sheet title="New session" onClose={onClose}>
      <div className="field-label">Name</div>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="field-label">Type</div>
      <Segmented<SessionKind>
        value={kind}
        onChange={setKind}
        options={[{ value: 'add', label: 'Add new cards' }, { value: 'verify', label: 'Verify existing' }]}
      />
      <p className="small muted">
        {kind === 'add'
          ? 'Normal exports: master paste, review sheet, ManaBox.'
          : 'Import the rows you are checking, scan the cards, and export only the differences.'}
      </p>
      <div className="field-label">Foil</div>
      <Segmented<FoilMode>
        value={foil}
        onChange={setFoil}
        options={[{ value: 'nonfoil', label: 'Non-foil' }, { value: 'foil', label: 'Foil' }, { value: 'ask', label: 'Ask each' }]}
      />
      <p className="small muted">
        {foil === 'foil' ? 'Every card is saved as foil (etched if that is its only foil).' : foil === 'nonfoil' ? 'Every card is saved as non-foil unless it only exists in foil.' : 'You pick the finish for each card that has more than one.'}
      </p>
      {error && <p className="err">{error}</p>}
      <button className="btn primary big block" style={{ marginTop: 12 }} onClick={start}>Start</button>
    </Sheet>
  );
}

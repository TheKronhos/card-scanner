import { useEffect, useRef, useState } from 'react';
import { db } from '../db/client';
import type { Owned, SearchHit } from '../db/repo';
import { formatUsd } from '../lib/cards';
import type { Printing } from '../lib/types';
import { Sheet, Thumb, errorText } from './common';

export function ownedText(o: Owned | undefined): string {
  if (!o) return '';
  const total = o.nonfoil + o.foil + o.etched;
  if (!total) return '';
  const parts = [o.nonfoil && `${o.nonfoil} non-foil`, o.foil && `${o.foil} foil`, o.etched && `${o.etched} etched`].filter(Boolean);
  return `You already have ${total}${parts.length > 1 || !o.nonfoil ? ` (${parts.join(', ')})` : ''}`;
}

function PrintingItem({ p, owned, onPick }: { p: Printing; owned?: Owned; onPick: (p: Printing) => void }) {
  const have = ownedText(owned);
  return (
    <li>
      <button className="item" onClick={() => onPick(p)}>
        <Thumb id={p.id} ver={p.img_ver} setCode={p.set_code} />
        <div className="grow">
          <div className="name">{p.set_name}</div>
          <div className="sub">
            [{p.set_code.toUpperCase()} {p.collector_number}] · {p.rarity}
            {p.promo_types.length ? ` · ${p.promo_types.join(', ')}` : ''}
            {p.frame_effects.length ? ` · ${p.frame_effects.join(', ')}` : ''}
            {p.border_color === 'borderless' ? ' · borderless' : ''}
          </div>
          <div className="sub">
            {p.finishes.map((f) => (f === 'nonfoil' ? 'Non-foil' : f === 'foil' ? 'Foil' : 'Etched')).join(' / ')}
            {have && <> · <b>{have}</b></>}
          </div>
        </div>
        <div className="right small">
          {p.finishes.includes('nonfoil') && <div>{formatUsd(p.usd)}</div>}
          {p.finishes.includes('foil') && <div className="muted">F {formatUsd(p.usd_foil)}</div>}
          {p.finishes.includes('etched') && <div className="muted">E {formatUsd(p.usd_etched)}</div>}
        </div>
      </button>
    </li>
  );
}

/**
 * Full-screen search: type a name (or "SET NUM", e.g. "plst dmr-116"), pick the card, then the exact printing.
 * Pass oracleId to open straight on one card's printings (used by "change printing").
 */
export function CardPicker({ onPick, onClose, oracleId, title = 'Add card' }: {
  onPick: (p: Printing) => void;
  onClose: () => void;
  oracleId?: string | null;
  title?: string;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ exact: Printing[]; names: SearchHit[] }>({ exact: [], names: [] });
  const [card, setCard] = useState<{ oracle_id: string; name: string } | null>(null);
  const [printings, setPrintings] = useState<Printing[] | null>(null);
  const [owned, setOwned] = useState<Record<string, Owned>>({});
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (card || q.trim().length < 2) {
      setHits({ exact: [], names: [] });
      return;
    }
    const t = setTimeout(() => {
      db.search(q).then(setHits).catch((e) => setError(errorText(e)));
    }, 120);
    return () => clearTimeout(t);
  }, [q, card]);

  useEffect(() => {
    if (oracleId) {
      db.printingsOf(oracleId).then((ps) => {
        if (ps.length) setCard({ oracle_id: oracleId, name: ps[0].name });
      });
    }
  }, [oracleId]);

  useEffect(() => {
    if (!card) {
      setPrintings(null);
      return;
    }
    db.printingsOf(card.oracle_id).then(async (ps) => {
      setPrintings(ps);
      setOwned(await db.owned(ps.map((p) => p.id)));
    });
  }, [card]);

  useEffect(() => {
    if (hits.exact.length) db.owned(hits.exact.map((p) => p.id)).then(setOwned);
  }, [hits.exact]);

  const openCard = (h: SearchHit) => {
    if (h.printings === 1) onPick(h.newest);
    else setCard({ oracle_id: h.oracle_id, name: h.name });
  };

  return (
    <Sheet full onClose={onClose} title={title}>
      <div className="bar">
        <button
          className="btn icon ghost"
          aria-label="Back"
          onClick={() => {
            if (card && !oracleId) {
              setCard(null);
              setTimeout(() => inputRef.current?.focus(), 0);
            } else onClose();
          }}
        >
          ‹
        </button>
        <h1>{card ? card.name : title}</h1>
      </div>
      {!card && (
        <div style={{ padding: '0 12px' }}>
          <input
            ref={inputRef}
            className="input"
            autoFocus
            placeholder="Card name, or set + number (e.g. plst dmr-116)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
          />
        </div>
      )}
      <div className="scroll">
        {error && <p className="err">{error}</p>}
        {!card && (
          <ul className="list">
            {hits.exact.map((p) => <PrintingItem key={p.id} p={p} owned={owned[p.id]} onPick={onPick} />)}
            {hits.names.map((h) => (
              <li key={h.oracle_id}>
                <button className="item" onClick={() => openCard(h)}>
                  <Thumb id={h.newest.id} ver={h.newest.img_ver} setCode={h.newest.set_code} />
                  <div className="grow">
                    <div className="name">{h.name}</div>
                    <div className="sub">{h.printings === 1 ? `${h.newest.set_name} [${h.newest.set_code.toUpperCase()} ${h.newest.collector_number}]` : `${h.printings} printings`}</div>
                  </div>
                  <div className="right muted">›</div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {card && !printings && <p className="muted">Loading printings…</p>}
        {card && printings && (
          <>
            <p className="small muted">{printings.length} printings, newest first. Match the set symbol and collector number on the card.</p>
            <ul className="list">
              {printings.map((p) => <PrintingItem key={p.id} p={p} owned={owned[p.id]} onPick={onPick} />)}
            </ul>
          </>
        )}
      </div>
    </Sheet>
  );
}

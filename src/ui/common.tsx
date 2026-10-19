import { useEffect, useState, type ReactNode } from 'react';
import { imageUrl } from '../lib/cards';
import type { Finish } from '../lib/types';
import { useBackToClose } from './nav';

export function Sheet({ title, onClose, children, full }: { title?: string; onClose: () => void; children: ReactNode; full?: boolean }) {
  useBackToClose(onClose);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet${full ? ' full' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        {title && !full && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({
  value, options, onChange, compact, label,
}: {
  value: T | null;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  compact?: boolean;
  label?: string;
}) {
  return (
    <div className={`seg${compact ? ' compact' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Scryfall thumbnail; falls back to the set code when offline and not cached. */
export function Thumb({ id, ver, setCode }: { id: string | null; ver: string | null; setCode: string }) {
  const [failed, setFailed] = useState(false);
  const src = id ? imageUrl(id, ver, 'small') : null;
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <div className="thumb">{setCode.toUpperCase()}</div>;
  return <img className="thumb" src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export function FinishTag({ finish }: { finish: Finish }) {
  if (finish === 'foil') return <span className="tag foil">FOIL</span>;
  if (finish === 'etched') return <span className="tag etched">ETCHED</span>;
  return null;
}

export function Toast({ children, onDone, ms = 5000 }: { children: ReactNode; onDone: () => void; ms?: number }) {
  useEffect(() => {
    const t = setTimeout(onDone, ms);
    return () => clearTimeout(t);
  }, [onDone, ms]);
  return <div className="toast" role="status">{children}</div>;
}

export function Stepper({ value, onChange, min = 1 }: { value: number; onChange: (n: number) => void; min?: number }) {
  return (
    <div className="stepper">
      <button className="btn icon" type="button" aria-label="Fewer" disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
      <div className="val">{value}</div>
      <button className="btn icon" type="button" aria-label="More" onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

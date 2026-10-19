import { useEffect, useState } from 'react';
import { refreshCards, requestPersistence } from '../db/client';
import type { CardsMeta } from '../db/repo';
import type { RefreshProgress } from '../db/worker';
import { errorText } from './common';

export function DataView({ meta, onChanged, back }: { meta: CardsMeta | null; onChanged: () => Promise<void>; back: () => void }) {
  const [progress, setProgress] = useState<RefreshProgress | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<string>('');

  const loadStorage = async () => {
    setPersisted((await navigator.storage?.persisted?.()) ?? null);
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) setUsage(`${(est.usage / 1e6).toFixed(0)} MB used`);
  };
  useEffect(() => {
    loadStorage();
  }, []);

  const busy = progress != null && progress.phase !== 'done';

  const refresh = async (force = false) => {
    setError('');
    setMessage('');
    try {
      await requestPersistence();
      const r = await refreshCards(setProgress, force);
      await onChanged();
      setMessage(
        r.updated
          ? `Installed card data ${r.version}.${r.rematched ? ` ${r.rematched} previously unmatched collection rows now match.` : ''}`
          : 'Card data is already up to date.',
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
      loadStorage();
    }
  };

  const pct = progress?.total ? Math.round(((progress.loaded ?? 0) / progress.total) * 100) : 0;

  return (
    <div className="app">
      <div className="bar">
        <button className="btn icon ghost" aria-label="Back" onClick={back}>‹</button>
        <h1>Card data</h1>
      </div>
      <div className="scroll">
        <div className="panel">
          {meta ? (
            <>
              <h2>Installed</h2>
              <p>{meta.card_count.toLocaleString()} printings</p>
              <p className="muted small">
                Version {meta.version} · built {new Date(meta.built_at).toLocaleString()}
              </p>
              <p className="muted small">Prices are from the same day the data was built.</p>
            </>
          ) : (
            <>
              <h2>Not installed</h2>
              <p className="muted">The card list (about 20 MB to download) is stored on this device so scanning and search work offline.</p>
            </>
          )}
        </div>

        {busy && (
          <div className="panel">
            <p>{progress.phase === 'checking' ? 'Checking for new data…' : progress.phase === 'downloading' ? `Downloading… ${pct}%` : 'Installing…'}</p>
            <div className="progress"><div style={{ width: `${progress.phase === 'installing' ? 100 : pct}%` }} /></div>
          </div>
        )}
        {message && <div className="panel">{message}</div>}
        {error && <div className="panel warn"><span className="err">{error}</span></div>}

        <button className="btn primary big block" disabled={busy} onClick={() => refresh(false)}>
          {meta ? 'Refresh card data' : 'Download card data'}
        </button>
        {meta && (
          <button className="btn block" style={{ marginTop: 10 }} disabled={busy} onClick={() => refresh(true)}>
            Reinstall even if up to date
          </button>
        )}

        <div className="panel">
          <h2>Storage</h2>
          <p className="small">
            {persisted ? 'Protected: the browser will not clear this app’s data on its own.' : 'Not protected yet. Add the app to your home screen, then refresh card data once to protect your sessions from being cleared.'}
          </p>
          {usage && <p className="muted small">{usage}</p>}
        </div>
      </div>
    </div>
  );
}

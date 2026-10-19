import { useCallback, useEffect, useState } from 'react';
import { db, initDb } from './db/client';
import type { CardsMeta } from './db/repo';
import { About } from './ui/About';
import { CollectionView } from './ui/CollectionView';
import { DataView } from './ui/DataView';
import { Home } from './ui/Home';
import { useRoute } from './ui/nav';
import { SessionView } from './ui/SessionView';
import { SettingsView } from './ui/SettingsView';

type Boot = { state: 'loading' } | { state: 'ready' } | { state: 'error'; error: string };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });
  const [meta, setMeta] = useState<CardsMeta | null>(null);
  const [route, go, back] = useRoute();

  const reloadMeta = useCallback(async () => setMeta(await db.cardsMeta()), []);

  useEffect(() => {
    initDb()
      .then(async (r) => {
        if (!r.ok) return setBoot({ state: 'error', error: r.error ?? 'Could not open storage.' });
        await reloadMeta();
        setBoot({ state: 'ready' });
      })
      .catch((e) => setBoot({ state: 'error', error: String(e?.message ?? e) }));
  }, [reloadMeta]);

  if (boot.state !== 'ready') {
    return (
      <div className="app">
        <div className="center">
          {boot.state === 'loading' ? <p className="muted">Opening…</p> : <p className="err">{boot.error}</p>}
        </div>
      </div>
    );
  }

  switch (route.name) {
    case 'session':
      return <SessionView key={route.id} id={route.id} meta={meta} back={back} go={go} />;
    case 'collection':
      return <CollectionView meta={meta} back={back} go={go} />;
    case 'data':
      return <DataView meta={meta} onChanged={reloadMeta} back={back} />;
    case 'settings':
      return <SettingsView back={back} />;
    case 'about':
      return <About meta={meta} back={back} />;
    default:
      return <Home meta={meta} go={go} />;
  }
}

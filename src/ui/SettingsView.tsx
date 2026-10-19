import { useEffect, useState } from 'react';
import { db } from '../db/client';
import type { Settings } from '../db/repo';

export function SettingsView({ back }: { back: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    db.getSettings().then(setSettings);
  }, []);

  return (
    <div className="app">
      <div className="bar">
        <button className="btn icon ghost" aria-label="Back" onClick={back}>‹</button>
        <h1>Settings</h1>
      </div>
      <div className="scroll">
        {settings && (
          <div className="panel">
            <h2>Scan file photos</h2>
            <p className="small muted">The Scan file always includes the photo of every card marked check or review (and cards you fixed by hand).</p>
            <label className="item" style={{ cursor: 'pointer' }}>
              <div className="grow">
                <div className="name">Include photos for every card</div>
                <div className="sub">Bigger file, about 60–100 KB per card</div>
              </div>
              <input
                type="checkbox"
                style={{ width: 28, height: 28 }}
                checked={settings.scanfile_all_photos}
                onChange={async (e) => setSettings(await db.setSetting('scanfile_all_photos', e.target.checked))}
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

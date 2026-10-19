import type { CardsMeta } from '../db/repo';

export function About({ meta, back }: { meta: CardsMeta | null; back: () => void }) {
  return (
    <div className="app">
      <div className="bar">
        <button className="btn icon ghost" aria-label="Back" onClick={back}>‹</button>
        <h1>About</h1>
      </div>
      <div className="scroll">
        <div className="panel">
          <h2>Card Scanner</h2>
          <p className="muted small">Version {__APP_VERSION__}{meta ? ` · card data ${meta.version}` : ''}</p>
          <p>Catalogs Magic: The Gathering cards on this device. Your sessions and collection never leave the device unless you export them.</p>
        </div>
        <div className="panel">
          <h2>Card data</h2>
          <p>
            Card data and images are provided by <a href="https://scryfall.com" target="_blank" rel="noreferrer">Scryfall</a>. Thank you, Scryfall.
          </p>
          <p className="small muted">
            This app is not produced by, endorsed by, supported by, or affiliated with Scryfall or Wizards of the Coast. Card names, text
            and images are © Wizards of the Coast LLC. Magic: The Gathering is a trademark of Wizards of the Coast LLC. Prices come from
            Scryfall and may be up to a day old.
          </p>
        </div>
      </div>
    </div>
  );
}

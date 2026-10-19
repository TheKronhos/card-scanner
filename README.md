# Card Scanner

Offline Magic: The Gathering cataloging app: an installable web app for Android (Chrome) and iPad (Safari).
Card data comes from [Scryfall](https://scryfall.com) via the separate `mtg-scanner-data` repo.

## Run it locally

Requires Node 20.19+. The local data pack is served from `../mtg-scanner-data/site/`, so build it once:

```bash
cd ../mtg-scanner-data && npm ci && npm run build
```

Then start the app:

```bash
npm install --legacy-peer-deps
npm run dev
```

Open the printed localhost URL in Chrome or Safari, tap **Get card data**, then **Download card data**.

## Test and build

```bash
npm test          # unit tests (vitest), uses tests/fixtures/cards-mini.sqlite3
npm run build     # production build in dist/
```

In production the app downloads card data from `https://thekronhos.github.io/mtg-scanner-data/`.
Override with `VITE_PACK_BASE`.

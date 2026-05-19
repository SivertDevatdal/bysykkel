# Oslo Bysykkel Trip Confidence

A small React + WebAssembly app that scores how confident you can be in a planned Oslo Bysykkel trip — given live station occupancy, walking distance to pickup, ride distance, and walking distance from the drop-off. Served by a Cloudflare Worker that proxies the official GBFS feed and the Entur geocoder.

## What's in here

- `app/bysykkel/` — Vite + React frontend (`App.tsx`, `scoring.ts`, Leaflet map)
- `src/bysykkel-core/` — the trip-quality formula in portable C, compiled to WebAssembly
- `src/index.ts` — Cloudflare Worker that serves the built assets and proxies:
  - `/api/bysykkel/stations` → GBFS `station_information.json`
  - `/api/bysykkel/status` → GBFS `station_status.json`
  - `/api/bysykkel/geocode?q=…` → Entur autocomplete (filtered to Oslo)
- `scripts/build-bysykkel-wasm.mjs` — compiles the C source via `clang`, falls back to a hand-written WAT module if `clang` isn't available

## Run locally

```bash
npm install
npm run build       # builds WASM + Vite bundle into public/bysykkel/
npm run dev         # wrangler dev — open the URL it prints, navigate to /bysykkel/
```

If you change the C scoring code, re-run `npm run build:wasm` (or just `npm run build`). The Vite config hashes the WASM bytes into the fetch URL so the browser always pulls fresh bytes.

Tests for the C core (no Node, just a native binary):

```bash
npm run test:core
```

## API client identifiers

The GBFS and Entur APIs ask consumers to identify themselves. Defaults are set to `bysykkel-demo` for both. If you deploy this somewhere real, override them in `wrangler.jsonc`:

```jsonc
"vars": {
  "OSLO_BYSYKKEL_CLIENT_IDENTIFIER": "your-app-name",
  "ENTUR_CLIENT_NAME": "your-app-name"
}
```

## Deploy

```bash
npm run deploy
```

Set a route in `wrangler.jsonc` if you want to host it on your own domain.

## Credits

- Station data: [Oslo Bysykkel GBFS feed](https://oslobysykkel.no/apne-data/sanntid)
- Geocoding: [Entur Geocoder](https://developer.entur.org/pages-geocoder-intro)
- Map tiles: OpenStreetMap via Leaflet

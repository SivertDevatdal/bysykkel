# Oslo Bysykkel Route Finder

A small React + WebAssembly app that finds the fastest Oslo Bysykkel trip between
two points: the nearest stand that actually has a bike right now, and the nearest
stand at the other end that actually has a free lock. Served by a Cloudflare
Worker that proxies the official GBFS feed and the Entur geocoder.

## How a route is chosen

Two rules, in order, and nothing else:

1. **Filter.** A stand can be a pickup if the live feed says it is installed,
   renting, and holds at least `MIN_BIKES_AT_PICKUP` bikes *now*. It can be a
   dropoff if it is installed, returning, and has at least
   `MIN_DOCKS_AT_DROPOFF` free locks *now*. Stands further than
   `MAX_WALK_TO_PICKUP_M` / `MAX_WALK_FROM_DROPOFF_M` are not options either.
   There is no partial credit and no forecasting.
2. **Rank.** Among the surviving pairs, the fastest door-to-door trip wins:
   walk to the stand + ride + walk from the stand, at fixed speeds (walk 80
   m/min, ride 230 m/min, plus 1.5 min to unlock and dock). Ties break on the
   shorter walk to the stand.

If walking the whole way is faster than the best bike trip, the app says so
instead of proposing a pointless ride.

The thresholds live in `app/bysykkel/src/scoring.ts`; the speeds and the
feasibility rule live in `src/bysykkel-core/bysykkel_score.h`. Every number on
screen is either a count straight from the feed or a distance divided by one of
those constants.

## What's in here

- `app/bysykkel/` — Vite + React frontend (`App.tsx`, `scoring.ts`, Leaflet map)
- `src/bysykkel-core/` — the feasibility rule and the time model in portable C,
  compiled to WebAssembly so the app and the tests cannot drift apart
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

If you change the C code, re-run `npm run build:wasm` (or just `npm run build`). The Vite config hashes the WASM bytes into the fetch URL so the browser always pulls fresh bytes.

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

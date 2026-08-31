// Trip planning core for the Bysykkel app.
//
// Why a dedicated module: App.tsx renders the React UI, but the route
// selection is also exercised from the C core's test harness and can be run
// headless. Anything UI-specific (formatting, JSX, geocoding) stays in
// App.tsx; everything that decides "which stand, in what order" lives here.
//
// The rule is deliberately black and white, in two steps:
//
//   1. Filter. A stand is usable for pickup if it is installed, renting, and
//      the live feed says it has at least MIN_BIKES_AT_PICKUP bikes *now*.
//      A stand is usable for dropoff if it is installed, returning, and has at
//      least MIN_DOCKS_AT_DROPOFF free locks *now*. Anything else is dropped —
//      there is no partial credit and no forecasting.
//   2. Rank. Among the usable pairs, the fastest door-to-door trip wins:
//      walk to the stand + ride + walk from the stand, at fixed speeds.
//
// There is no availability probability and no blended "quality" term. Those
// produced rankings nobody could explain (a rack with five bikes 100 m away
// losing to one 800 m away), and the UI could not show why. Now every number
// on screen is either a count straight from the feed or a distance divided by
// a constant.

export type StationInfo = {
  station_id: string;
  name: string;
  address?: string;
  lat: number;
  lon: number;
  capacity: number;
};

export type StationStatus = {
  station_id: string;
  num_bikes_available: number;
  num_docks_available: number;
  is_installed: boolean | number;
  is_renting: boolean | number;
  is_returning: boolean | number;
  last_reported: number;
};

export type GbfsStationsResponse = {
  last_updated: number;
  ttl?: number;
  data: { stations: StationInfo[] };
};

export type GbfsStatusResponse = {
  last_updated: number;
  ttl?: number;
  data: { stations: StationStatus[] };
};

export type Station = StationInfo & { status: StationStatus };

export type GeoPoint = Pick<StationInfo, "lat" | "lon">;

export type BysykkelWasm = {
  bysykkel_trip_feasible: (
    bikesAvailable: number,
    docksAvailable: number,
    pickupIsRenting: number,
    dropoffIsReturning: number,
    minBikes: number,
    minDocks: number,
  ) => number;
  bysykkel_trip_minutes: (
    walkToPickupM: number,
    rideM: number,
    walkFromDropoffM: number,
  ) => number;
  bysykkel_walk_minutes: (directM: number) => number;
};

// A single door-to-door option: walk to `pickup`, ride to `dropoff`, walk on.
export type Trip = {
  id: string;
  pickup: Station;
  dropoff: Station;
  walkToPickupM: number;
  rideM: number;
  walkFromDropoffM: number;
  walkToPickupMin: number;
  rideMin: number;
  walkFromDropoffMin: number;
  // Exact minutes, used for ranking. The UI rounds this for display.
  totalMinutes: number;
};

export type TripPlan = {
  // Fastest first. Empty when nothing usable was found.
  trips: Trip[];
  best: Trip | null;
  // One entry per usable pickup stand — its fastest trip — so the UI can offer
  // "or start from here instead" without re-deriving anything.
  pickupOptions: Trip[];
  directWalkM: number;
  directWalkMinutes: number;
  // True when just walking the whole way beats the fastest bike trip. Short
  // hops are the common case; saying so is more useful than a token route.
  walkIsFaster: boolean;
  // Why there is no trip, when there isn't one.
  noPickupNearby: boolean;
  noDropoffNearby: boolean;
};

export type PlanOptions = {
  minBikes?: number;
  minDocks?: number;
  maxWalkToPickupM?: number;
  maxWalkFromDropoffM?: number;
};

// A stand must have at least this much on the board right now. Raise either to
// demand a safety buffer (e.g. 2 bikes, in case one goes while you walk over).
export const MIN_BIKES_AT_PICKUP = 1;
export const MIN_DOCKS_AT_DROPOFF = 1;

// Nobody walks 20 minutes to reach a city bike. Beyond these radii a stand is
// simply not an option, however many bikes it holds.
export const MAX_WALK_TO_PICKUP_M = 1200;
export const MAX_WALK_FROM_DROPOFF_M = 1200;

// How many usable stands at each end feed the pairing. The candidates are
// distance-sorted, so these caps only ever drop stands that are already
// further away than ten alternatives.
export const PICKUP_CANDIDATE_LIMIT = 10;
export const DROPOFF_CANDIDATE_LIMIT = 10;

// Straight-line distance underestimates real cycling distance (one-way
// streets, bridges, the fjord). This is the standard detour multiplier for
// dense European city grids.
export const RIDE_DETOUR_FACTOR = 1.28;

// Mirrors BYSYKKEL_HANDLING_MIN in src/bysykkel-core/bysykkel_score.h. Used
// only to split the total back into legs for display; the total itself always
// comes from the C core.
const HANDLING_MIN = 1.5;

// ----- pure geometry -----

export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const earthRadiusM = 6371000;
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLon = toRadians(b.lon - a.lon);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * earthRadiusM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function isEnabled(value: boolean | number): boolean {
  return value === true || value === 1;
}

export function nearestStations(stations: Station[], anchor: GeoPoint): Station[] {
  return [...stations].sort((a, b) => distanceMeters(anchor, a) - distanceMeters(anchor, b));
}

export function joinStationsWithStatus(
  info: StationInfo[],
  status: StationStatus[],
): Station[] {
  const byId = new Map(status.map((s) => [s.station_id, s]));
  const stations: Station[] = [];
  for (const s of info) {
    const st = byId.get(s.station_id);
    if (st) stations.push({ ...s, status: st });
  }
  return stations;
}

// ----- step 1: filter -----

// Stands you could actually take a bike from right now, nearest first.
export function usablePickups(
  stations: Station[],
  origin: GeoPoint,
  options: PlanOptions = {},
): Station[] {
  const minBikes = options.minBikes ?? MIN_BIKES_AT_PICKUP;
  const maxWalkM = options.maxWalkToPickupM ?? MAX_WALK_TO_PICKUP_M;
  return nearestStations(stations, origin).filter((s) => (
    isEnabled(s.status.is_installed)
    && isEnabled(s.status.is_renting)
    && s.status.num_bikes_available >= minBikes
    && distanceMeters(origin, s) <= maxWalkM
  ));
}

// Stands with a free lock to leave the bike in right now, nearest first.
export function usableDropoffs(
  stations: Station[],
  destination: GeoPoint,
  options: PlanOptions = {},
): Station[] {
  const minDocks = options.minDocks ?? MIN_DOCKS_AT_DROPOFF;
  const maxWalkM = options.maxWalkFromDropoffM ?? MAX_WALK_FROM_DROPOFF_M;
  return nearestStations(stations, destination).filter((s) => (
    isEnabled(s.status.is_installed)
    && isEnabled(s.status.is_returning)
    && s.status.num_docks_available >= minDocks
    && distanceMeters(destination, s) <= maxWalkM
  ));
}

// ----- step 2: rank by door-to-door time -----

export function planTrips(
  stations: Station[],
  origin: GeoPoint,
  destination: GeoPoint,
  engine: BysykkelWasm,
  options: PlanOptions = {},
): TripPlan {
  const minBikes = options.minBikes ?? MIN_BIKES_AT_PICKUP;
  const minDocks = options.minDocks ?? MIN_DOCKS_AT_DROPOFF;

  const directWalkM = distanceMeters(origin, destination);
  const directWalkMinutes = engine.bysykkel_walk_minutes(directWalkM);

  const pickups = usablePickups(stations, origin, options).slice(0, PICKUP_CANDIDATE_LIMIT);
  const dropoffs = usableDropoffs(stations, destination, options).slice(0, DROPOFF_CANDIDATE_LIMIT);

  const empty: TripPlan = {
    trips: [],
    best: null,
    pickupOptions: [],
    directWalkM,
    directWalkMinutes,
    walkIsFaster: true,
    noPickupNearby: pickups.length === 0,
    noDropoffNearby: dropoffs.length === 0,
  };

  if (pickups.length === 0 || dropoffs.length === 0) {
    return empty;
  }

  const trips: Trip[] = [];
  for (const pickup of pickups) {
    const walkToPickupM = distanceMeters(origin, pickup);
    for (const dropoff of dropoffs) {
      if (pickup.station_id === dropoff.station_id) continue;

      // The C core owns the feasibility rule so the app and the tests cannot
      // drift apart on what "usable" means.
      const feasible = engine.bysykkel_trip_feasible(
        pickup.status.num_bikes_available,
        dropoff.status.num_docks_available,
        isEnabled(pickup.status.is_renting) ? 1 : 0,
        isEnabled(dropoff.status.is_returning) ? 1 : 0,
        minBikes,
        minDocks,
      );
      if (!feasible) continue;

      const rideM = distanceMeters(pickup, dropoff) * RIDE_DETOUR_FACTOR;
      const walkFromDropoffM = distanceMeters(destination, dropoff);
      const totalMinutes = engine.bysykkel_trip_minutes(walkToPickupM, rideM, walkFromDropoffM);
      if (totalMinutes < 0) continue;

      const walkToPickupMin = engine.bysykkel_walk_minutes(walkToPickupM);
      const walkFromDropoffMin = engine.bysykkel_walk_minutes(walkFromDropoffM);

      trips.push({
        id: `${pickup.station_id}-${dropoff.station_id}`,
        pickup,
        dropoff,
        walkToPickupM,
        rideM,
        walkFromDropoffM,
        walkToPickupMin,
        rideMin: totalMinutes - walkToPickupMin - walkFromDropoffMin - HANDLING_MIN,
        walkFromDropoffMin,
        totalMinutes,
      });
    }
  }

  if (trips.length === 0) {
    return empty;
  }

  // Fastest wins. Ties break on the shorter walk to the stand, because that is
  // the leg a rider can see going wrong.
  trips.sort((a, b) => (
    a.totalMinutes !== b.totalMinutes
      ? a.totalMinutes - b.totalMinutes
      : a.walkToPickupM - b.walkToPickupM
  ));

  const best = trips[0];
  return {
    trips,
    best,
    pickupOptions: fastestTripPerPickup(trips),
    directWalkM,
    directWalkMinutes,
    walkIsFaster: directWalkMinutes <= best.totalMinutes,
    noPickupNearby: false,
    noDropoffNearby: false,
  };
}

// One row per stand you could start from, each showing its own best trip,
// already in fastest-first order (the input is sorted).
function fastestTripPerPickup(trips: Trip[]): Trip[] {
  const seen = new Set<string>();
  const options: Trip[] = [];
  for (const trip of trips) {
    if (seen.has(trip.pickup.station_id)) continue;
    seen.add(trip.pickup.station_id);
    options.push(trip);
  }
  return options;
}

// ----- WASM loading -----

export async function instantiateScoreEngine(
  bytes: BufferSource,
): Promise<BysykkelWasm> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports as unknown as BysykkelWasm;
  if (
    typeof wasm.bysykkel_trip_feasible !== "function"
    || typeof wasm.bysykkel_trip_minutes !== "function"
    || typeof wasm.bysykkel_walk_minutes !== "function"
  ) {
    throw new Error("WASM trip engine has an unexpected export shape.");
  }
  return wasm;
}

// ----- station-name resolver (used in the React app's typed-origin path) -----

// Geocoder-overlay helper: stations whose normalized name (or token bag)
// matches a typed query are resolved locally before falling back to Entur.
export const QUERY_STOP_WORDS = new Set([
  "gate", "gata", "plass", "plassen", "vei", "veien", "holdeplass", "street", "road", "st",
]);

export function resolveStation(stations: Station[], query: string): Station | null {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return null;
  let best: { station: Station; score: number } | null = null;
  for (const station of stations) {
    const searchText = normalizeText(`${station.name} ${station.address ?? ""}`);
    const score = textMatchScore(searchText, normalizedQuery);
    if (!best || score > best.score) best = { station, score };
  }
  return best && best.score >= 24 ? best.station : null;
}

function normalizeText(value: string): string {
  return value.toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9æøå\s]/g, " ")
    .replace(/\s+/g, " ").trim();
}

function textMatchScore(searchText: string, query: string): number {
  if (searchText === query) return 100;
  if (searchText.includes(query)) return 80 + Math.min(query.length, 20);
  const tokens = query.split(" ").filter((t) => t.length > 1 && !QUERY_STOP_WORDS.has(t));
  if (tokens.length === 0) return 0;
  let score = 0;
  for (const token of tokens) {
    if (searchText.includes(token)) { score += 18; continue; }
    const fuzzy = Math.max(...searchText.split(" ").map((c) => similarity(c, token)));
    if (fuzzy >= 0.72) score += fuzzy * 12;
  }
  return score;
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const max = Math.max(a.length, b.length);
  return (max - levenshteinDistance(a, b)) / max;
}

function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

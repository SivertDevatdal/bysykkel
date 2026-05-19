// Shared scoring core for the Bysykkel app.
//
// Why a dedicated module: App.tsx renders the React UI, but the trip-recommendation
// math is also exercised from a Node failtest harness in scripts/failtest-bysykkel.mjs.
// Both must run *exactly* the same code paths so a passing failtest implies the
// React app behaves the same way for the same inputs. Anything UI-specific
// (formatting, JSX, geocoding) stays in App.tsx; everything that decides
// "which station, how confident, in what order" lives here.

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
  bysykkel_score_trip: (
    walkToPickupM: number,
    rideM: number,
    walkFromDropoffM: number,
    bikesAvailable: number,
    docksAvailable: number,
    pickupCapacity: number,
    dropoffCapacity: number,
    pickupIsRenting: number,
    dropoffIsReturning: number,
  ) => number;
  bysykkel_trip_quality: (
    walkToPickupM: number,
    rideM: number,
    walkFromDropoffM: number,
  ) => number;
  bysykkel_confidence_band: (score: number) => number;
};

export type ConfidenceLabel = "Low" | "Medium" | "High";

export type Recommendation = {
  id: string;
  score: number;
  confidence: ConfidenceLabel;
  pickup: Station;
  dropoff: Station;
  walkToPickupM: number;
  rideM: number;
  walkFromDropoffM: number;
  totalMinutes: number;
  reason: string;
  pickupProb: number;
  dropoffProb: number;
  // Trip quality (0..1): how worthwhile biking is given distance + walk overhead.
  // Computed by the WASM scoring engine so C and JS share one formula.
  quality: number;
  // Combined display score for the pickup: pickupProb × quality.
  pickupScore: number;
};

export type PickupCandidate = {
  station: Station;
  walkM: number;
  walkMin: number;
  prob: number;
  quality: number;
  // Combined display score: prob × quality. This is what the row shows as %.
  score: number;
};

export const CONFIDENCE_LABELS: readonly ConfidenceLabel[] = ["Low", "Medium", "High"] as const;
export const MAX_NEARBY_STATIONS = 12;
export const PICKUP_CANDIDATE_LIMIT = 8;
// All stations rendered in the pickup picker must be at most this far from the
// origin. Anything beyond is presumed "wrong neighborhood" and never useful as
// a Bysykkel pickup — the failtest enforces this radius as a regression guard
// against the misgeocoding bug that pushed origin 2.5 km away from where the
// user typed they were.
export const MAX_NEARBY_PICKUP_RADIUS_M = 2000;

const RIDE_DETOUR_FACTOR = 1.28;

// Geocoder-overlay helper: stations whose normalized name (or token bag) matches
// a typed query are exposed to the UI's resolveStation logic; reused here so
// the failtest can exercise the same matching when needed.
export const QUERY_STOP_WORDS = new Set([
  "gate", "gata", "plass", "plassen", "vei", "veien", "holdeplass", "street", "road", "st",
]);

// ----- pure math -----

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

// ----- demand model (Poisson with time-of-day rates) -----

function bikeDemandRatePerMin(hour: number, isWeekend: boolean): number {
  if (isWeekend) {
    if (hour >= 11 && hour < 18) return 0.18;
    if (hour >= 9 && hour < 22) return 0.10;
    return 0.04;
  }
  if (hour >= 7 && hour < 9) return 0.32;
  if (hour >= 16 && hour < 18) return 0.32;
  if (hour >= 12 && hour < 14) return 0.18;
  if (hour >= 18 && hour < 20) return 0.18;
  if (hour >= 9 && hour < 22) return 0.10;
  return 0.04;
}

function dockDemandRatePerMin(hour: number, isWeekend: boolean): number {
  if (isWeekend) {
    if (hour >= 11 && hour < 18) return 0.18;
    if (hour >= 9 && hour < 22) return 0.10;
    return 0.04;
  }
  if (hour >= 8 && hour < 10) return 0.32;
  if (hour >= 17 && hour < 19) return 0.32;
  if (hour >= 12 && hour < 14) return 0.18;
  if (hour >= 18 && hour < 20) return 0.18;
  if (hour >= 9 && hour < 22) return 0.10;
  return 0.04;
}

function poissonCdfAtMost(k: number, lambda: number): number {
  if (lambda <= 0) return k >= 0 ? 1 : 0;
  if (k < 0) return 0;
  let sum = 0;
  let term = Math.exp(-lambda);
  for (let i = 0; i <= k; i += 1) {
    sum += term;
    term *= lambda / (i + 1);
  }
  return Math.min(1, sum);
}

function capacityFactor(capacity: number): number {
  if (capacity <= 0) return 1;
  const factor = capacity / 22;
  return Math.max(0.55, Math.min(1.8, factor));
}

export function pickupAvailabilityProbability(
  station: Station, walkMinutes: number, now: Date,
): number {
  const hour = now.getHours();
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  const baseRate = bikeDemandRatePerMin(hour, isWeekend);
  const rate = baseRate * capacityFactor(station.capacity);
  const expectedDepartures = rate * walkMinutes;
  const bikes = station.status.num_bikes_available;
  return poissonCdfAtMost(bikes - 1, expectedDepartures);
}

export function dropoffAvailabilityProbability(
  station: Station, minutesUntilArrival: number, now: Date,
): number {
  const arrivalDate = new Date(now.getTime() + minutesUntilArrival * 60 * 1000);
  const hour = arrivalDate.getHours();
  const isWeekend = arrivalDate.getDay() === 0 || arrivalDate.getDay() === 6;
  const baseRate = dockDemandRatePerMin(hour, isWeekend);
  const rate = baseRate * capacityFactor(station.capacity);
  const expectedArrivals = rate * minutesUntilArrival;
  const docks = station.status.num_docks_available;
  return poissonCdfAtMost(docks - 1, expectedArrivals);
}

// ----- recommendation builders -----

function buildReason(
  pickup: Station, dropoff: Station, walkToPickupM: number, walkFromDropoffM: number,
): string {
  const walkMinutes = Math.ceil((walkToPickupM + walkFromDropoffM) / 80);
  return `${pickup.status.num_bikes_available} sykler ved start, ${dropoff.status.num_docks_available} ledige låser ved mål, ca. ${walkMinutes} min gange totalt.`;
}

export function buildRecommendations(
  stations: Station[],
  originAnchor: GeoPoint,
  destinationAnchor: GeoPoint,
  scoreEngine: BysykkelWasm,
  now: Date = new Date(),
): Recommendation[] {
  const pickupCandidates = nearestStations(stations, originAnchor)
    .filter((s) => isEnabled(s.status.is_installed) && isEnabled(s.status.is_renting))
    .slice(0, MAX_NEARBY_STATIONS);
  const dropoffCandidates = nearestStations(stations, destinationAnchor)
    .filter((s) => isEnabled(s.status.is_installed) && isEnabled(s.status.is_returning))
    .slice(0, MAX_NEARBY_STATIONS);

  const recs: Recommendation[] = [];
  for (const pickup of pickupCandidates) {
    for (const dropoff of dropoffCandidates) {
      if (pickup.station_id === dropoff.station_id) continue;
      const walkToPickupM = distanceMeters(originAnchor, pickup);
      const rideM = distanceMeters(pickup, dropoff) * RIDE_DETOUR_FACTOR;
      const walkFromDropoffM = distanceMeters(destinationAnchor, dropoff);
      const score = scoreEngine.bysykkel_score_trip(
        walkToPickupM, rideM, walkFromDropoffM,
        pickup.status.num_bikes_available, dropoff.status.num_docks_available,
        pickup.capacity, dropoff.capacity,
        isEnabled(pickup.status.is_renting) ? 1 : 0,
        isEnabled(dropoff.status.is_returning) ? 1 : 0,
      );
      if (score <= 0) continue;
      const confidenceIndex = scoreEngine.bysykkel_confidence_band(score);
      const confidence = CONFIDENCE_LABELS[confidenceIndex] ?? "Low";
      const walkToPickupMin = walkToPickupM / 80;
      const rideMin = rideM / 230;
      const walkFromDropoffMin = walkFromDropoffM / 80;
      const totalMinutes = Math.ceil(walkToPickupMin + rideMin + walkFromDropoffMin);
      const pickupProb = pickupAvailabilityProbability(pickup, walkToPickupMin, now);
      const dropoffProb = dropoffAvailabilityProbability(
        dropoff, walkToPickupMin + rideMin, now,
      );
      const quality = scoreEngine.bysykkel_trip_quality(
        walkToPickupM, rideM, walkFromDropoffM,
      );
      const pickupScore = pickupProb * quality;
      recs.push({
        id: `${pickup.station_id}-${dropoff.station_id}`,
        score, confidence, pickup, dropoff,
        walkToPickupM, rideM, walkFromDropoffM, totalMinutes,
        reason: buildReason(pickup, dropoff, walkToPickupM, walkFromDropoffM),
        pickupProb, dropoffProb, quality, pickupScore,
      });
    }
  }
  return recs.sort((a, b) => b.score - a.score).slice(0, 24);
}

export function buildPickupCandidates(
  stations: Station[],
  originAnchor: GeoPoint,
  best: Recommendation | null,
  scoreEngine: BysykkelWasm,
  now: Date = new Date(),
): PickupCandidate[] {
  const eligible = nearestStations(stations, originAnchor).filter(
    (s) => isEnabled(s.status.is_installed) && isEnabled(s.status.is_renting),
  );
  // Drop anything outside the nearby radius. Keeps the picker focused on the
  // origin neighborhood and prevents the "all 5 rows are 2.5 km away" failure
  // mode the user reported when origin was misgeocoded.
  const nearby = eligible.filter(
    (s) => distanceMeters(originAnchor, s) <= MAX_NEARBY_PICKUP_RADIUS_M,
  );
  const chosen = nearby.slice(0, PICKUP_CANDIDATE_LIMIT);
  const mustIncludeId = best?.pickup.station_id ?? null;
  if (mustIncludeId && !chosen.some((s) => s.station_id === mustIncludeId)) {
    const extra = nearby.find((s) => s.station_id === mustIncludeId)
      ?? eligible.find((s) => s.station_id === mustIncludeId);
    if (extra) chosen.push(extra);
  }
  // Trip-quality is computed against the chosen dropoff so candidates are
  // compared apples-to-apples for the same destination.
  const dropoff = best?.dropoff ?? null;
  const walkFromDropoffM = best?.walkFromDropoffM ?? 0;
  return chosen
    .map<PickupCandidate>((station) => {
      const walkM = distanceMeters(originAnchor, station);
      const walkMin = walkM / 80;
      const prob = pickupAvailabilityProbability(station, walkMin, now);
      const rideM = dropoff ? distanceMeters(station, dropoff) * RIDE_DETOUR_FACTOR : 0;
      const quality = dropoff
        ? scoreEngine.bysykkel_trip_quality(walkM, rideM, walkFromDropoffM)
        : 1;
      return { station, walkM, walkMin, prob, quality, score: prob * quality };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.walkM - b.walkM;
    });
}

// ----- WASM loading -----

export async function instantiateScoreEngine(
  bytes: BufferSource,
): Promise<BysykkelWasm> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports as unknown as BysykkelWasm;
  if (
    typeof wasm.bysykkel_score_trip !== "function"
    || typeof wasm.bysykkel_trip_quality !== "function"
    || typeof wasm.bysykkel_confidence_band !== "function"
  ) {
    throw new Error("WASM scoring engine has an unexpected export shape.");
  }
  return wasm;
}

// ----- station-name resolver (used in the React app's typed-origin path) -----

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

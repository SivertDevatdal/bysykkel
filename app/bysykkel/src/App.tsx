import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import {
  instantiateScoreEngine,
  isEnabled,
  joinStationsWithStatus,
  planTrips,
  resolveStation,
} from "./scoring";
import type {
  BysykkelWasm,
  GbfsStationsResponse,
  GbfsStatusResponse,
  GeoPoint,
  Station,
  Trip,
  TripPlan,
} from "./scoring";

type LocationState = {
  status: "idle" | "watching" | "error" | "unsupported";
  position: GeoPoint | null;
  accuracyM: number | null;
  message: string | null;
};

type GeocodedPlace = GeoPoint & {
  label: string;
  locality: string | null;
};

const OSLO_CENTER: GeoPoint = { lat: 59.917, lon: 10.737 };

// Injected by Vite (see vite.config.ts) — short content hash of the WASM file
// at build time. Appended as ?v=… to the WASM fetch so the browser refetches
// when the bytes change. Without this, browsers happily serve the cached
// bysykkel_score.wasm from a previous deploy and the trip-quality formula
// silently runs the OLD bytecode against the NEW JS — which is the failure
// mode that produced the "99% sjanse" / wrong picker scores in the field.
declare const __BYSYKKEL_WASM_HASH__: string;

export default function App() {
  const [stationsResponse, setStationsResponse] = useState<GbfsStationsResponse | null>(null);
  const [statusResponse, setStatusResponse] = useState<GbfsStatusResponse | null>(null);
  const [scoreEngine, setScoreEngine] = useState<BysykkelWasm | null>(null);
  const [originQuery, setOriginQuery] = useState("St. Olavs plass");
  const [destinationQuery, setDestinationQuery] = useState("Nationaltheatret");
  const [originPlace, setOriginPlace] = useState<GeocodedPlace | null>(null);
  const [destinationPlace, setDestinationPlace] = useState<GeocodedPlace | null>(null);
  const [locationState, setLocationState] = useState<LocationState>({
    status: "idle",
    position: null,
    accuracyM: null,
    message: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [showPlanner, setShowPlanner] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!showPlanner) setPickerOpen(false);
  }, [showPlanner]);

  useEffect(() => {
    let cancelled = false;
    async function loadData() {
      try {
        setError(null);
        const [stationInfo, stationStatus, wasm] = await Promise.all([
          fetchJson<GbfsStationsResponse>("/api/bysykkel/stations"),
          fetchJson<GbfsStatusResponse>("/api/bysykkel/status"),
          loadScoreEngine(),
        ]);
        if (cancelled) return;
        setStationsResponse(stationInfo);
        setStatusResponse(stationStatus);
        setScoreEngine(wasm);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load trip data.");
      }
    }
    void loadData();
    return () => { cancelled = true; };
  }, []);

  // Always resolve the typed origin via the geocoder, even when GPS is on.
  // Previously this effect was suppressed whenever a GPS position existed,
  // which made it impossible for the user to override GPS with a typed origin
  // — there was simply no resolved place to fall back to. Now the geocoded
  // place is always available; what we *use* as the origin anchor is decided
  // below, with typed-origin winning over GPS when both exist.
  useEffect(() => {
    return watchGeocode(originQuery, locationState.position, setOriginPlace);
  }, [locationState.position, originQuery]);

  useEffect(() => {
    return watchGeocode(destinationQuery, locationState.position, setDestinationPlace);
  }, [destinationQuery, locationState.position]);

  useEffect(() => {
    if (locationState.status !== "watching") return undefined;
    if (!("geolocation" in navigator)) {
      setLocationState({ status: "unsupported", position: null, accuracyM: null, message: "Posisjon er ikke tilgjengelig." });
      return undefined;
    }
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setLocationState({
          status: "watching",
          position: { lat: position.coords.latitude, lon: position.coords.longitude },
          accuracyM: position.coords.accuracy,
          message: null,
        });
      },
      (geoError) => {
        setLocationState({ status: "error", position: null, accuracyM: null, message: geoError.message || "Kunne ikke lese posisjonen din." });
      },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 12000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [locationState.status]);

  const stations = useMemo(() => {
    if (!stationsResponse || !statusResponse) return [];
    return joinStationsWithStatus(
      stationsResponse.data.stations,
      statusResponse.data.stations,
    );
  }, [stationsResponse, statusResponse]);

  const originStation = useMemo(() => resolveStation(stations, originQuery), [originQuery, stations]);
  const destinationStation = useMemo(() => resolveStation(stations, destinationQuery), [destinationQuery, stations]);

  // Origin priority (the bug-fix that matters): if the user has typed an
  // origin AND we can resolve it (Bysykkel station name match or Entur geocode),
  // use that. Otherwise fall back to GPS, otherwise nothing. We deliberately
  // try `originStation` first because Bysykkel station names are exactly what
  // users type into a Bysykkel app (and Entur sometimes returns a wrong-named
  // place — e.g. "Hans Nielsen Hauges plass" → "Hans Nielsen Hauge grunnskole",
  // a school 2.5 km from where the user actually meant). Empty input falls
  // back to GPS so users on the move still get a useful default.
  const trimmedOrigin = originQuery.trim();
  const typedOriginAnchor: GeoPoint | null = originStation ?? originPlace ?? null;
  const originAnchor: GeoPoint | null = trimmedOrigin
    ? (typedOriginAnchor ?? locationState.position)
    : (locationState.position ?? typedOriginAnchor);
  const destinationAnchor = destinationPlace ?? destinationStation;

  const plan: TripPlan | null = useMemo(() => {
    if (!originAnchor || !destinationAnchor || !scoreEngine) return null;
    if (stations.length === 0) return null;
    return planTrips(stations, originAnchor, destinationAnchor, scoreEngine);
  }, [destinationAnchor, originAnchor, scoreEngine, stations]);

  const best = plan?.best ?? null;

  const highlightedIds = useMemo(() => {
    const ids = new Set<string>();
    if (best) {
      ids.add(best.pickup.station_id);
      ids.add(best.dropoff.station_id);
    }
    return ids;
  }, [best]);

  return (
    <div className="app">
      <MapView
        stations={stations}
        userLocation={locationState.position}
        highlightedIds={highlightedIds}
        bestRoute={best}
        originAnchor={originAnchor}
        destinationAnchor={destinationAnchor}
        showRoute={showPlanner}
      />

      <div className="top-controls">
        <button type="button" className="circle-btn" aria-label="Konto">
          <ProfileIcon />
        </button>
      </div>

      <div className="side-controls">
        <button
          type="button"
          className={`circle-btn${locationState.status === "watching" ? " circle-btn--active" : ""}`}
          aria-label={locationState.status === "watching" ? "Slå av min posisjon" : "Min posisjon"}
          aria-pressed={locationState.status === "watching"}
          onClick={() => {
            // Toggle GPS: tapping while it's watching turns it off so the user
            // can fall back to a typed origin (or no origin) without having to
            // refresh the page.
            if (locationState.status === "watching") {
              setLocationState({
                status: "idle",
                position: null,
                accuracyM: null,
                message: null,
              });
            } else {
              setLocationState({
                status: "watching",
                position: locationState.position,
                accuracyM: locationState.accuracyM,
                message: null,
              });
            }
          }}
        >
          <LocateIcon />
        </button>
        <button type="button" className="circle-btn" aria-label="Liste">
          <ListIcon />
        </button>
      </div>

      <div className={`bottom-card${showPlanner ? " bottom-card--open" : ""}`}>
        {!showPlanner && (
          <button
            type="button"
            className="plan-trip-btn"
            onClick={() => setShowPlanner(true)}
          >
            <RouteIcon />
            <span>Planlegg tur</span>
            {best && (
              <span className="badge-inline">{Math.round(best.totalMinutes)} min</span>
            )}
          </button>
        )}

        {showPlanner && (
          <>
            <div className="bottom-card__head">
              <span className="bottom-card__title">Planlegg tur</span>
              <button
                type="button"
                className="bottom-card__close"
                onClick={() => setShowPlanner(false)}
                aria-label="Lukk"
              >
                <ChevronDownIcon />
              </button>
            </div>
            <div className="bottom-card__inputs">
              <span
                className="bottom-card__bullet bottom-card__bullet--origin"
                aria-hidden="true"
              />
              <input
                list="station-options"
                value={originQuery}
                onChange={(event) => setOriginQuery(event.target.value)}
                placeholder={locationState.status === "watching" ? "Min posisjon" : "Hvor er du?"}
              />
              <span
                className="bottom-card__bullet bottom-card__bullet--destination"
                aria-hidden="true"
              />
              <input
                list="station-options"
                value={destinationQuery}
                onChange={(event) => setDestinationQuery(event.target.value)}
                placeholder="Hvor skal du?"
              />
              <datalist id="station-options">
                {stations.map((s) => (
                  <option key={s.station_id} value={s.name} />
                ))}
              </datalist>
            </div>
            {locationState.message && (
              <div className="bottom-card__msg alert">{locationState.message}</div>
            )}
            {error && <div className="bottom-card__msg alert">{error}</div>}
            {!error && !locationState.message && (!stationsResponse || !statusResponse) && (
              <div className="bottom-card__msg">Henter live data …</div>
            )}
            {!error && stationsResponse && statusResponse && plan && !best && (
              <div className="bottom-card__msg">{noTripMessage(plan)}</div>
            )}
            {plan && best && (
              <>
                <RouteSummary
                  trip={best}
                  pickerOpen={pickerOpen}
                  onTogglePicker={() => setPickerOpen((open) => !open)}
                  alternativeCount={plan.pickupOptions.length - 1}
                />
                {plan.walkIsFaster && (
                  <div className="bottom-card__msg">
                    Det går fortere å gå hele veien
                    ({formatDistance(plan.directWalkM)}, ca.{" "}
                    {Math.round(plan.directWalkMinutes)} min).
                  </div>
                )}
                {pickerOpen && (
                  <PickupPicker
                    options={plan.pickupOptions}
                    selectedId={best.pickup.station_id}
                  />
                )}
              </>
            )}
          </>
        )}

        <div className="action-bar">
          <button type="button" className="qr-mini" aria-label="QR">
            <QrIcon />
          </button>
          <button type="button" className="skann-qr">
            SKANN QR
          </button>
        </div>
      </div>
    </div>
  );
}

function MapView({
  stations,
  userLocation,
  highlightedIds,
  bestRoute,
  originAnchor,
  destinationAnchor,
  showRoute,
}: {
  stations: Station[];
  userLocation: GeoPoint | null;
  highlightedIds: Set<string>;
  bestRoute: Trip | null;
  originAnchor: GeoPoint | null;
  destinationAnchor: GeoPoint | null;
  showRoute: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const userMarkerRef = useRef<L.CircleMarker | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
    }).setView([OSLO_CENTER.lat, OSLO_CENTER.lon], 13);

    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      subdomains: "abcd",
    }).addTo(map);

    markersLayerRef.current = L.layerGroup().addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markersLayerRef.current = null;
      routeLayerRef.current = null;
      userMarkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = markersLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    const dimMode = showRoute && bestRoute !== null;

    for (const station of stations) {
      const installed = isEnabled(station.status.is_installed);
      const renting = isEnabled(station.status.is_renting);
      const bikes = station.status.num_bikes_available;
      const isHighlight = highlightedIds.has(station.station_id);

      if (dimMode && !isHighlight) {
        L.circleMarker([station.lat, station.lon], {
          radius: 3,
          color: "#ffffff",
          weight: 0.5,
          fillColor: "#b3bac4",
          fillOpacity: 0.55,
          opacity: 0.55,
        }).addTo(layer);
        continue;
      }

      if (isHighlight) continue;

      let color = "#9aa4af";
      if (installed && renting && bikes >= 3) color = "#22a4ec";
      else if (installed && renting && bikes >= 1) color = "#7fc7e8";

      L.circleMarker([station.lat, station.lon], {
        radius: 6,
        color: "#ffffff",
        weight: 1,
        fillColor: color,
        fillOpacity: 1,
        opacity: 1,
      })
        .bindTooltip(`${station.name} · ${bikes} sykler`, { direction: "top", opacity: 0.92 })
        .addTo(layer);
    }
  }, [stations, highlightedIds, showRoute, bestRoute]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (userMarkerRef.current) {
      map.removeLayer(userMarkerRef.current);
      userMarkerRef.current = null;
    }

    if (userLocation) {
      const marker = L.circleMarker([userLocation.lat, userLocation.lon], {
        radius: 8,
        color: "#ffffff",
        weight: 3,
        fillColor: "#3361e7",
        fillOpacity: 1,
      }).addTo(map);
      userMarkerRef.current = marker;
      if (!showRoute) {
        map.flyTo([userLocation.lat, userLocation.lon], 15, { duration: 0.6 });
      }
    }
  }, [userLocation, showRoute]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = routeLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (!showRoute || !bestRoute || !originAnchor || !destinationAnchor) return;

    const origin: L.LatLngExpression = [originAnchor.lat, originAnchor.lon];
    const pickup: L.LatLngExpression = [bestRoute.pickup.lat, bestRoute.pickup.lon];
    const dropoff: L.LatLngExpression = [bestRoute.dropoff.lat, bestRoute.dropoff.lon];
    const destination: L.LatLngExpression = [destinationAnchor.lat, destinationAnchor.lon];

    const walkOpts: L.PolylineOptions = {
      color: "#3a4555",
      weight: 3,
      opacity: 0.9,
      dashArray: "1 7",
      lineCap: "round",
      lineJoin: "round",
    };
    const rideOpts: L.PolylineOptions = {
      color: "#22a4ec",
      weight: 5,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round",
    };

    L.polyline([origin, pickup], walkOpts).addTo(layer);
    L.polyline([pickup, dropoff], rideOpts).addTo(layer);
    L.polyline([dropoff, destination], walkOpts).addTo(layer);

    const originIcon = L.divIcon({
      className: "route-pin route-pin--origin",
      iconSize: [16, 16],
      iconAnchor: [8, 8],
      html: '<span class="dot"></span>',
    });
    const destIcon = L.divIcon({
      className: "route-pin route-pin--destination",
      iconSize: [22, 28],
      iconAnchor: [11, 26],
      html: '<svg viewBox="0 0 22 28" aria-hidden="true"><path d="M11 0a11 11 0 0 0-11 11c0 7.5 11 17 11 17s11-9.5 11-17A11 11 0 0 0 11 0z" fill="#0c1a30"/><circle cx="11" cy="11" r="4" fill="#fff"/></svg>',
    });
    const pickupBikes = bestRoute.pickup.status.num_bikes_available;
    const dropoffDocks = bestRoute.dropoff.status.num_docks_available;
    const bikeImg = `<img class="pin-bubble__icon" src="/bysykkel/sykkelicon.png" alt="" aria-hidden="true" />`;
    const rackImg = `<img class="pin-bubble__icon" src="/bysykkel/parkering.png" alt="" aria-hidden="true" />`;
    const pickupIcon = L.divIcon({
      className: "route-pin route-pin--pickup",
      iconSize: [16, 16],
      iconAnchor: [8, 8],
      html: `<span class="pin-bubble"><span class="pin-bubble__num">${pickupBikes}</span>${bikeImg}</span><span class="pin-dot"></span>`,
    });
    const dropoffIcon = L.divIcon({
      className: "route-pin route-pin--dropoff",
      iconSize: [16, 16],
      iconAnchor: [8, 8],
      html: `<span class="pin-bubble"><span class="pin-bubble__num">${dropoffDocks}</span>${rackImg}</span><span class="pin-dot"></span>`,
    });

    L.marker(origin, { icon: originIcon, interactive: false }).addTo(layer);
    L.marker(destination, { icon: destIcon, interactive: false }).addTo(layer);
    L.marker(pickup, { icon: pickupIcon }).addTo(layer);
    L.marker(dropoff, { icon: dropoffIcon }).addTo(layer);

    const bounds = L.latLngBounds([origin, pickup, dropoff, destination]).pad(0.25);
    map.fitBounds(bounds, {
      animate: true,
      paddingTopLeft: [40, 180],
      paddingBottomRight: [40, 200],
    });
  }, [bestRoute, originAnchor, destinationAnchor, showRoute]);

  return <div ref={containerRef} className="map" aria-label="Kart over Oslo Bysykkel-stativer" />;
}

function RouteSummary({
  trip,
  pickerOpen,
  onTogglePicker,
  alternativeCount,
}: {
  trip: Trip;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  alternativeCount: number;
}) {
  const bikes = trip.pickup.status.num_bikes_available;
  const docks = trip.dropoff.status.num_docks_available;
  const title = pickerOpen
    ? "Skjul andre startstasjoner"
    : `${alternativeCount} andre startstasjoner – trykk for å se dem`;
  return (
    <div className="route-summary">
      <div className="route-summary__time">
        <strong>{Math.round(trip.totalMinutes)}</strong>
        <span>min</span>
      </div>
      <div className="route-summary__legs">
        <span className="leg">
          <span className="leg__icon">🚶</span>
          {formatDistance(trip.walkToPickupM)}
        </span>
        <span className="leg leg--ride">
          <span className="leg__icon">🚲</span>
          {formatDistance(trip.rideM)}
        </span>
        <span className="leg">
          <span className="leg__icon">🚶</span>
          {formatDistance(trip.walkFromDropoffM)}
        </span>
      </div>
      <button
        type="button"
        className={`route-summary__stands${pickerOpen ? " route-summary__stands--open" : ""}`}
        onClick={onTogglePicker}
        aria-expanded={pickerOpen}
        aria-label={title}
        title={title}
        disabled={alternativeCount < 1}
      >
        <span className="route-summary__count">
          <strong>{bikes}</strong> {bikes === 1 ? "sykkel" : "sykler"}
        </span>
        <span className="route-summary__count">
          <strong>{docks}</strong> {docks === 1 ? "lås" : "låser"}
        </span>
        <span className="route-summary__caret" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </button>
    </div>
  );
}

function PickupPicker({
  options,
  selectedId,
}: {
  options: Trip[];
  selectedId: string;
}) {
  if (options.length === 0) return null;
  const fastest = options[0].totalMinutes;
  return (
    <div className="pickup-picker">
      <div className="pickup-picker__head">Start fra en annen stasjon</div>
      <ul className="pickup-picker__list">
        {options.map((option) => {
          const station = option.pickup;
          const isSelected = station.station_id === selectedId;
          const extraMinutes = Math.round(option.totalMinutes - fastest);
          return (
            <li
              key={station.station_id}
              className={`pickup-row${isSelected ? " pickup-row--selected" : ""}`}
            >
              <span className="pickup-row__time">
                <strong>{Math.round(option.totalMinutes)}</strong>
                <span className="pickup-row__unit">min</span>
              </span>
              <span className="pickup-row__name" title={station.name}>
                {station.name}
                {isSelected ? (
                  <span className="pickup-row__chip" aria-label="Raskeste startstasjon">
                    Raskest
                  </span>
                ) : extraMinutes > 0 ? (
                  <span className="pickup-row__delta">+{extraMinutes} min</span>
                ) : null}
              </span>
              <span className="pickup-row__meta">
                <span className="pickup-row__metarow">
                  <span className="pickup-row__bikes">
                    {station.status.num_bikes_available}{" "}
                    {station.status.num_bikes_available === 1 ? "sykkel" : "sykler"}
                  </span>
                  <span className="pickup-row__sep" aria-hidden="true">·</span>
                  <span className="pickup-row__walk">{formatDistance(option.walkToPickupM)}</span>
                </span>
                <span className="pickup-row__maps">
                  <a
                    className="pickup-row__maplink"
                    href={appleMapsUrl(station)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Apple Maps
                  </a>
                  <span className="pickup-row__sep" aria-hidden="true">·</span>
                  <a
                    className="pickup-row__maplink"
                    href={googleMapsUrl(station)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Google Maps
                  </a>
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Says *which* half of the plan came up empty, so the user knows whether to
// move the start or the destination.
function noTripMessage(plan: TripPlan): string {
  if (plan.noPickupNearby && plan.noDropoffNearby) {
    return "Ingen stativ med sykler i nærheten av start, og ingen ledige låser ved målet.";
  }
  if (plan.noPickupNearby) {
    return "Ingen stativ med ledige sykler i nærheten av startpunktet.";
  }
  if (plan.noDropoffNearby) {
    return "Ingen stativ med ledige låser i nærheten av målet.";
  }
  return "Fant ingen rute mellom punktene.";
}

function ProfileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5 19c1.4-3.2 4-4.7 7-4.7s5.6 1.5 7 4.7" strokeLinecap="round" />
    </svg>
  );
}

function LocateIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" strokeLinecap="round" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M5 7h14M5 12h14M5 17h14" />
    </svg>
  );
}

function QrIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
      <path d="M3 3h7v7H3V3zm2 2v3h3V5H5zm9-2h7v7h-7V3zm2 2v3h3V5h-3zM3 14h7v7H3v-7zm2 2v3h3v-3H5zm9 0h2v2h-2v-2zm0 3h2v2h-2v-2zm3-3h2v2h-2v-2zm0 3h2v2h-2v-2zm3-3h2v2h-2v-2zm0 3h2v2h-2v-2z" />
    </svg>
  );
}

function RouteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 6h6a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 8h6" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function loadScoreEngine(): Promise<BysykkelWasm> {
  // The ?v=<hash> is intentional. The WASM has a stable filename
  // (bysykkel_score.wasm), but its bytes change whenever the C source changes.
  // Without a cache-busting parameter the browser will happily serve the old
  // WASM against the new JS — which is exactly how a stale trip-quality
  // formula silently shipped to users earlier (route summary showing raw
  // pickupProb because Q evaluated to 1.0 in the cached bytes).
  const url = `${import.meta.env.BASE_URL}bysykkel_score.wasm?v=${__BYSYKKEL_WASM_HASH__}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("WASM scoring engine is unavailable.");
  const bytes = await response.arrayBuffer();
  return instantiateScoreEngine(bytes);
}

function watchGeocode(
  query: string,
  focus: GeoPoint | null,
  setPlace: (place: GeocodedPlace | null) => void,
): () => void {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length < 2) {
    setPlace(null);
    return () => {};
  }
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    const params = new URLSearchParams({ q: trimmedQuery });
    if (focus) {
      params.set("lat", String(focus.lat));
      params.set("lon", String(focus.lon));
    }
    fetch(`/api/bysykkel/geocode?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Geocoder returned ${r.status}`);
        return r.json() as Promise<{ places?: GeocodedPlace[] }>;
      })
      .then((payload) => setPlace(payload.places?.[0] ?? null))
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setPlace(null);
      });
  }, 250);
  return () => {
    window.clearTimeout(timeoutId);
    controller.abort();
  };
}

function formatDistance(distanceM: number): string {
  if (distanceM < 1000) return `${Math.round(distanceM)} m`;
  return `${(distanceM / 1000).toFixed(1)} km`;
}

function appleMapsUrl(station: Station): string {
  const ll = `${station.lat},${station.lon}`;
  const q = encodeURIComponent(station.name);
  return `https://maps.apple.com/?ll=${ll}&q=${q}`;
}

function googleMapsUrl(station: Station): string {
  return `https://www.google.com/maps/search/?api=1&query=${station.lat},${station.lon}`;
}

interface Env {
  ASSETS: Fetcher;
  OSLO_BYSYKKEL_CLIENT_IDENTIFIER?: string;
  ENTUR_CLIENT_NAME?: string;
}

const OSLO_BYSYKKEL_BASE_URL = "https://gbfs.urbansharing.com/oslobysykkel.no";
const OSLO_BYSYKKEL_CACHE_SECONDS = 10;
const DEFAULT_OSLO_BYSYKKEL_CLIENT_IDENTIFIER = "bysykkel-demo";
const ENTUR_GEOCODER_URL = "https://api.entur.io/geocoder/v1/autocomplete";
const DEFAULT_ENTUR_CLIENT_NAME = "bysykkel-demo";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/bysykkel/")) {
      return handleBysykkelApi(request, env);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return Response.redirect(new URL("/bysykkel/", url).toString(), 302);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleBysykkelApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET") {
    return json({ error: "Method not allowed." }, 405);
  }

  if (url.pathname === "/api/bysykkel/stations") {
    return proxyBysykkelFeed("station_information.json", env);
  }

  if (url.pathname === "/api/bysykkel/status") {
    return proxyBysykkelFeed("station_status.json", env);
  }

  if (url.pathname === "/api/bysykkel/geocode") {
    return proxyEnturGeocode(url, env);
  }

  return json({ error: "Unknown Bysykkel endpoint." }, 404);
}

async function proxyBysykkelFeed(feed: string, env: Env): Promise<Response> {
  const upstreamUrl = `${OSLO_BYSYKKEL_BASE_URL}/${feed}`;
  const clientIdentifier = env.OSLO_BYSYKKEL_CLIENT_IDENTIFIER
    ?? DEFAULT_OSLO_BYSYKKEL_CLIENT_IDENTIFIER;

  const upstream = await fetch(upstreamUrl, {
    headers: {
      "Client-Identifier": clientIdentifier,
      "Accept": "application/json",
    },
  });

  if (!upstream.ok) {
    return json(
      { error: "Could not load Oslo Bysykkel data.", status: upstream.status },
      502,
    );
  }

  const headers = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") ?? "application/json; charset=utf-8",
    "Cache-Control": `public, max-age=${OSLO_BYSYKKEL_CACHE_SECONDS}, s-maxage=${OSLO_BYSYKKEL_CACHE_SECONDS}`,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function proxyEnturGeocode(url: URL, env: Env): Promise<Response> {
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length < 2 || query.length > 80) {
    return json({ places: [] });
  }

  const upstreamUrl = new URL(ENTUR_GEOCODER_URL);
  upstreamUrl.searchParams.set("text", query);
  upstreamUrl.searchParams.set("lang", "no");
  upstreamUrl.searchParams.set("size", "5");
  upstreamUrl.searchParams.set("boundary.country", "NOR");
  upstreamUrl.searchParams.set("boundary.locality_ids", "KVE:TopographicPlace:0301");

  const focusLat = url.searchParams.get("lat");
  const focusLon = url.searchParams.get("lon");
  if (focusLat && focusLon) {
    upstreamUrl.searchParams.set("focus.point.lat", focusLat);
    upstreamUrl.searchParams.set("focus.point.lon", focusLon);
    upstreamUrl.searchParams.set("focus.scale", "20km");
  }

  const upstream = await fetch(upstreamUrl, {
    headers: {
      "ET-Client-Name": env.ENTUR_CLIENT_NAME ?? DEFAULT_ENTUR_CLIENT_NAME,
      "Accept": "application/json",
    },
  });

  if (!upstream.ok) {
    return json(
      { error: "Could not geocode the place.", status: upstream.status },
      502,
    );
  }

  const payload = await upstream.json() as {
    features?: Array<{
      geometry?: { coordinates?: [number, number] };
      properties?: { label?: string; name?: string; locality?: string };
    }>;
  };

  const places = (payload.features ?? [])
    .map((feature) => {
      const coordinates = feature.geometry?.coordinates;
      if (!coordinates) {
        return null;
      }

      return {
        label: feature.properties?.label ?? feature.properties?.name ?? "Unknown place",
        locality: feature.properties?.locality ?? null,
        lat: coordinates[1],
        lon: coordinates[0],
      };
    })
    .filter((place): place is { label: string; locality: string | null; lat: number; lon: number } => (
      place !== null
      && Number.isFinite(place.lat)
      && Number.isFinite(place.lon)
    ));

  return json({ places }, 200, `public, max-age=60, s-maxage=60`);
}

function json(data: unknown, status = 200, cacheControl = "no-store"): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
    },
  });
}

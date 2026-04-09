import "server-only";

import { getFallbackStations, normalizeOpenChargeMapStation, stationSupportsConnector } from "@/lib/station-normalization";
import type { Coordinates, Station, StationNetworkSummary } from "@/lib/types";

const OPEN_CHARGE_MAP_URL = process.env.OPEN_CHARGE_MAP_URL || "https://api.openchargemap.io/v3/poi/";
const OPEN_CHARGE_MAP_API_KEY = process.env.OPEN_CHARGE_MAP_API_KEY || "";
const DEFAULT_COUNTRY_CODE = process.env.OPEN_CHARGE_MAP_COUNTRY_CODE || "IN";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function haversineDistanceKm(a: Coordinates, b: Coordinates) {
  const earthRadiusKm = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

function midpoint(a: Coordinates, b: Coordinates): Coordinates {
  return {
    lat: (a.lat + b.lat) / 2,
    lng: (a.lng + b.lng) / 2
  };
}

function dedupeStations(stations: Station[]) {
  return Array.from(new Map(stations.map((station) => [station.id, station])).values());
}

async function fetchOpenChargeMap(params: Record<string, string | number>) {
  const search = new URLSearchParams({
    output: "json",
    compact: "true",
    verbose: "false",
    countrycode: DEFAULT_COUNTRY_CODE,
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]))
  });

  if (OPEN_CHARGE_MAP_API_KEY) {
    search.set("key", OPEN_CHARGE_MAP_API_KEY);
  }

  const response = await fetch(`${OPEN_CHARGE_MAP_URL}?${search.toString()}`, {
    headers: {
      "X-API-Key": OPEN_CHARGE_MAP_API_KEY,
      "X-Requested-With": "VoltPath AI"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Open Charge Map request failed with ${response.status}`);
  }

  const payload = (await response.json()) as unknown[];
  return payload
    .map((item) => normalizeOpenChargeMapStation(item as never))
    .filter((station): station is Station => Boolean(station));
}

export async function getStationsForTrip(
  origin: Coordinates,
  destination: Coordinates,
  connectorType: string
): Promise<{ live: boolean; provider: string; stations: Station[] }> {
  const routeMidpoint = midpoint(origin, destination);
  const directDistanceKm = haversineDistanceKm(origin, destination);
  const searchRadiusKm = clamp(Math.ceil(directDistanceKm / 2) + 180, 120, 450);
  const maxResults = clamp(Math.ceil(directDistanceKm * 0.75), 80, 250);

  try {
    const liveStations = await fetchOpenChargeMap({
      latitude: routeMidpoint.lat,
      longitude: routeMidpoint.lng,
      distance: searchRadiusKm,
      distanceunit: "KM",
      maxresults: maxResults
    });

    const compatibleStations = dedupeStations(liveStations).filter((station) => stationSupportsConnector(station, connectorType));
    if (compatibleStations.length > 0) {
      return {
        live: true,
        provider: "Open Charge Map",
        stations: compatibleStations
      };
    }
  } catch {
    // Fall through to local seed data.
  }

  return {
    live: false,
    provider: "Seed fallback",
    stations: getFallbackStations().filter((station) => stationSupportsConnector(station, connectorType))
  };
}

export async function getNearbyStationsLive(
  center: Coordinates,
  radiusKm = 300,
  connectorType?: string
): Promise<{ live: boolean; provider: string; stations: Array<{ station: Station; distanceKm: number }> }> {
  try {
    const liveStations = await fetchOpenChargeMap({
      latitude: center.lat,
      longitude: center.lng,
      distance: clamp(radiusKm, 25, 500),
      distanceunit: "KM",
      maxresults: clamp(Math.round(radiusKm * 1.6), 40, 250)
    });

    const filtered = dedupeStations(liveStations)
      .filter((station) => !connectorType || stationSupportsConnector(station, connectorType))
      .map((station) => ({
        station,
        distanceKm: Number(haversineDistanceKm(center, station.coordinates).toFixed(2))
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    return {
      live: filtered.length > 0,
      provider: filtered.length > 0 ? "Open Charge Map" : "Seed fallback",
      stations:
        filtered.length > 0
          ? filtered
          : getFallbackStations()
              .filter((station) => !connectorType || stationSupportsConnector(station, connectorType))
              .map((station) => ({
                station,
                distanceKm: Number(haversineDistanceKm(center, station.coordinates).toFixed(2))
              }))
              .filter(({ distanceKm }) => distanceKm <= radiusKm)
              .sort((a, b) => a.distanceKm - b.distanceKm)
    };
  } catch {
    return {
      live: false,
      provider: "Seed fallback",
      stations: getFallbackStations()
        .filter((station) => !connectorType || stationSupportsConnector(station, connectorType))
        .map((station) => ({
          station,
          distanceKm: Number(haversineDistanceKm(center, station.coordinates).toFixed(2))
        }))
        .filter(({ distanceKm }) => distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm)
    };
  }
}

export async function getStationNetworkSummary(
  center: Coordinates,
  radiusKm: number,
  connectorType: string
): Promise<StationNetworkSummary> {
  const response = await getNearbyStationsLive(center, radiusKm, connectorType);
  return {
    count: response.stations.length,
    live: response.live,
    provider: response.provider,
    connectorType,
    fetchedAt: new Date().toISOString()
  };
}

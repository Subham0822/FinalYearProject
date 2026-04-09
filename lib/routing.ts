import { stations } from "@/lib/stations";
import type {
  ChargingStop,
  Coordinates,
  ForecastSnapshot,
  OptimizationPreferences,
  RecommendationMode,
  RecommendationResponse,
  RejectedRouteComparison,
  RouteObjectives,
  RouteOption,
  RouteSegmentPrediction,
  RouteStep,
  RouteTradeoffPoint,
  SimulationScenario,
  Station,
  TripRequest
} from "@/lib/types";

type RouteMetrics = {
  distanceKm: number;
  durationMinutes: number;
  geometry: Coordinates[];
  steps: RouteStep[];
  source: "heuristic" | "osrm" | "mapbox";
};

type SegmentResult = {
  stop: ChargingStop;
  distanceFromPreviousKm: number;
};

type CandidateBuild = {
  label: string;
  variant: "direct" | "one-stop" | "multi-stop";
  segments: RouteMetrics[];
  stops: ChargingStop[];
};

type LiveRoutingState = {
  refreshTime: Date;
  trafficMultiplier: number;
  trafficLevel: "light" | "moderate" | "heavy";
  corridorSeed: number;
  priceShift: number;
  availabilityShift: number;
};

const ROAD_MULTIPLIER = 1.18;
const OSRM_URL = process.env.OSRM_URL || "https://router.project-osrm.org";
const MAPBOX_DIRECTIONS_URL = process.env.MAPBOX_DIRECTIONS_URL || "https://api.mapbox.com/directions/v5/mapbox/driving";
const MAPBOX_ACCESS_TOKEN = process.env.MAPBOX_ACCESS_TOKEN;
const DEFAULT_PREFERENCES: OptimizationPreferences = {
  time: 0.35,
  cost: 0.25,
  batteryUsage: 0.2,
  waitTime: 0.2
};
const routeCache = new Map<string, RouteMetrics>();

const DEMAND_PROFILES = {
  metro_peak: {
    hourlyDemand: [0.36, 0.3, 0.25, 0.22, 0.22, 0.28, 0.48, 0.76, 0.95, 1, 0.9, 0.82, 0.74, 0.75, 0.8, 0.86, 0.94, 1, 0.98, 0.9, 0.78, 0.62, 0.5, 0.42],
    weekendDemand: 0.9,
    priceElasticity: 1.12
  },
  commuter_corridor: {
    hourlyDemand: [0.26, 0.22, 0.2, 0.18, 0.2, 0.3, 0.52, 0.72, 0.84, 0.78, 0.68, 0.62, 0.64, 0.68, 0.74, 0.82, 0.9, 0.94, 0.88, 0.8, 0.68, 0.54, 0.42, 0.32],
    weekendDemand: 1.04,
    priceElasticity: 1.02
  },
  business_district: {
    hourlyDemand: [0.18, 0.16, 0.14, 0.12, 0.12, 0.22, 0.4, 0.6, 0.8, 0.92, 0.98, 0.94, 0.9, 0.86, 0.82, 0.82, 0.88, 0.92, 0.84, 0.68, 0.5, 0.36, 0.28, 0.22],
    weekendDemand: 0.78,
    priceElasticity: 1.08
  },
  destination_leisure: {
    hourlyDemand: [0.22, 0.18, 0.16, 0.14, 0.16, 0.22, 0.28, 0.34, 0.42, 0.54, 0.66, 0.76, 0.84, 0.9, 0.94, 0.96, 0.96, 0.9, 0.78, 0.62, 0.48, 0.38, 0.3, 0.24],
    weekendDemand: 1.16,
    priceElasticity: 0.98
  }
} as const;

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

function roadDistanceKm(a: Coordinates, b: Coordinates) {
  return haversineDistanceKm(a, b) * ROAD_MULTIPLIER;
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function normalizePreferences(preferences?: OptimizationPreferences): OptimizationPreferences {
  const merged = { ...DEFAULT_PREFERENCES, ...preferences };
  const total = Object.values(merged).reduce((sum, value) => sum + value, 0) || 1;
  return {
    time: Number((merged.time / total).toFixed(3)),
    cost: Number((merged.cost / total).toFixed(3)),
    batteryUsage: Number((merged.batteryUsage / total).toFixed(3)),
    waitTime: Number((merged.waitTime / total).toFixed(3))
  };
}

function baseTrafficMultiplierForHour(hour: number) {
  if ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 21)) return 1.35;
  if (hour >= 11 && hour <= 16) return 1.12;
  if (hour >= 22 || hour <= 5) return 0.9;
  return 1;
}

function averageSpeedForMultiplier(multiplier: number) {
  return clamp(72 / multiplier, 28, 88);
}

function resolveLiveRoutingState(request: TripRequest): LiveRoutingState {
  const refreshTime = request.liveContext?.refreshToken ? new Date(request.liveContext.refreshToken) : new Date();
  const effectiveRefresh = Number.isNaN(refreshTime.getTime()) ? new Date() : refreshTime;
  const corridorKey = `${request.origin.lat}:${request.origin.lng}:${request.destination.lat}:${request.destination.lng}:${Math.floor(
    effectiveRefresh.getTime() / 30_000
  )}`;
  const corridorSeed = hashString(corridorKey);
  const jitter = ((corridorSeed % 1000) / 1000 - 0.5) * 0.24;
  const baseTraffic = baseTrafficMultiplierForHour(effectiveRefresh.getHours());
  const scenarioTraffic =
    request.simulationScenario === "peak_traffic"
      ? 0.22
      : request.simulationScenario === "high_station_demand"
        ? 0.1
        : request.simulationScenario === "price_surge"
          ? 0.08
          : 0;
  const trafficMultiplier = clamp(baseTraffic + jitter + scenarioTraffic, 0.84, 1.78);
  return {
    refreshTime: effectiveRefresh,
    trafficMultiplier: Number(trafficMultiplier.toFixed(2)),
    trafficLevel: trafficMultiplier >= 1.28 ? "heavy" : trafficMultiplier >= 1.04 ? "moderate" : "light",
    corridorSeed,
    priceShift: ((corridorSeed >> 3) % 1000) / 1000 - 0.5,
    availabilityShift: ((corridorSeed >> 7) % 1000) / 1000 - 0.5
  };
}

function decodeProviderSteps(
  legs: Array<{
    steps?: Array<{
      name?: string;
      distance?: number;
      duration?: number;
      maneuver?: { type?: string; modifier?: string; instruction?: string };
    }>;
  }> = []
) {
  return legs.flatMap((leg) =>
    (leg.steps ?? []).map((step) => ({
      instruction:
        step.maneuver?.instruction ||
        `${step.maneuver?.type || "Continue"}${step.name ? ` on ${step.name}` : ""}`,
      distanceKm: Number(((step.distance ?? 0) / 1000).toFixed(2)),
      durationMinutes: Number(((step.duration ?? 0) / 60).toFixed(1)),
      maneuver: [step.maneuver?.type, step.maneuver?.modifier].filter(Boolean).join(" ") || "continue",
      roadName: step.name || undefined
    }))
  );
}

function heuristicStep(a: Coordinates, b: Coordinates, distanceKm: number, durationMinutes: number): RouteStep[] {
  return [
    {
      instruction: "Follow the primary corridor toward the next waypoint",
      distanceKm: Number(distanceKm.toFixed(2)),
      durationMinutes: Number(durationMinutes.toFixed(1)),
      maneuver: "continue"
    },
    {
      instruction: "Arrive at the waypoint",
      distanceKm: 0,
      durationMinutes: 0,
      maneuver: "arrive"
    }
  ];
}

async function queryOsrmRoute(a: Coordinates, b: Coordinates): Promise<RouteMetrics | null> {
  const response = await fetch(
    `${OSRM_URL}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&steps=true&annotations=duration,distance`,
    { cache: "no-store" }
  );
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    routes?: Array<{
      distance: number;
      duration: number;
      geometry?: { coordinates: number[][] };
      legs?: Array<{ steps?: Array<{ name?: string; distance?: number; duration?: number; maneuver?: { type?: string; modifier?: string; instruction?: string } }> }>;
    }>;
  };
  const route = payload.routes?.[0];
  if (!route) return null;
  return {
    distanceKm: Number((route.distance / 1000).toFixed(2)),
    durationMinutes: Number((route.duration / 60).toFixed(2)),
    geometry: route.geometry?.coordinates.map(([lng, lat]) => ({ lat, lng })) ?? [a, b],
    steps: decodeProviderSteps(route.legs),
    source: "osrm"
  };
}

async function queryMapboxRoute(a: Coordinates, b: Coordinates): Promise<RouteMetrics | null> {
  if (!MAPBOX_ACCESS_TOKEN) return null;
  const response = await fetch(
    `${MAPBOX_DIRECTIONS_URL}/${a.lng},${a.lat};${b.lng},${b.lat}?alternatives=false&overview=full&geometries=geojson&steps=true&access_token=${MAPBOX_ACCESS_TOKEN}`,
    { cache: "no-store" }
  );
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    routes?: Array<{
      distance: number;
      duration: number;
      geometry?: { coordinates: number[][] };
      legs?: Array<{ steps?: Array<{ name?: string; distance?: number; duration?: number; maneuver?: { type?: string; modifier?: string; instruction?: string } }> }>;
    }>;
  };
  const route = payload.routes?.[0];
  if (!route) return null;
  return {
    distanceKm: Number((route.distance / 1000).toFixed(2)),
    durationMinutes: Number((route.duration / 60).toFixed(2)),
    geometry: route.geometry?.coordinates.map(([lng, lat]) => ({ lat, lng })) ?? [a, b],
    steps: decodeProviderSteps(route.legs),
    source: "mapbox"
  };
}

async function routeSegment(a: Coordinates, b: Coordinates, liveState: LiveRoutingState): Promise<RouteMetrics> {
  const cacheKey = `${a.lat.toFixed(4)},${a.lng.toFixed(4)}:${b.lat.toFixed(4)},${b.lng.toFixed(4)}:${Math.floor(
    liveState.refreshTime.getTime() / 60_000
  )}`;
  const cached = routeCache.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      durationMinutes: Number((cached.durationMinutes * (liveState.trafficMultiplier / baseTrafficMultiplierForHour(liveState.refreshTime.getHours()))).toFixed(2))
    };
  }

  const baseTraffic = baseTrafficMultiplierForHour(liveState.refreshTime.getHours());
  const trafficRatio = liveState.trafficMultiplier / baseTraffic;

  try {
    const osrmRoute = await queryOsrmRoute(a, b);
    if (osrmRoute) {
      routeCache.set(cacheKey, osrmRoute);
      return {
        ...osrmRoute,
        durationMinutes: Number((osrmRoute.durationMinutes * trafficRatio).toFixed(2))
      };
    }
  } catch {}

  try {
    const mapboxRoute = await queryMapboxRoute(a, b);
    if (mapboxRoute) {
      routeCache.set(cacheKey, mapboxRoute);
      return {
        ...mapboxRoute,
        durationMinutes: Number((mapboxRoute.durationMinutes * trafficRatio).toFixed(2))
      };
    }
  } catch {}

  const distanceKm = roadDistanceKm(a, b);
  const durationMinutes = Number(((distanceKm / averageSpeedForMultiplier(liveState.trafficMultiplier)) * 60).toFixed(2));
  return {
    distanceKm: Number(distanceKm.toFixed(2)),
    durationMinutes,
    geometry: [a, b],
    steps: heuristicStep(a, b, distanceKm, durationMinutes),
    source: "heuristic"
  };
}

async function routeSegments(points: Coordinates[], liveState: LiveRoutingState) {
  return Promise.all(points.slice(0, -1).map((point, index) => routeSegment(point, points[index + 1], liveState)));
}

function liveStationSignal(stationId: string, liveState: LiveRoutingState) {
  const seed = hashString(`${stationId}:${Math.floor(liveState.refreshTime.getTime() / 30_000)}:${liveState.corridorSeed}`);
  return ((seed % 1000) / 1000 - 0.5) * 2;
}

function demandLevelFromIndex(demandIndex: number): ForecastSnapshot["demandLevel"] {
  if (demandIndex >= 0.92) return "high";
  if (demandIndex >= 0.58) return "moderate";
  return "low";
}

function effectiveReserveSoc(request: TripRequest) {
  return clamp((request.reserveSoc ?? 10) + (request.safetyBufferSoc ?? 0), request.reserveSoc ?? 10, 34);
}

function fullRangeKm(request: TripRequest) {
  return request.vehicle.batteryCapacityKwh * request.vehicle.efficiencyKmPerKwh;
}

function usableRangeKm(request: TripRequest, soc: number) {
  return fullRangeKm(request) * (soc / 100);
}

function stationSupportsConnector(station: Station, connectorType: string) {
  const supported = station.connectorCompatibility ?? station.connectorTypes ?? [station.connectorType];
  return supported.some((value) => value.toLowerCase() === connectorType.toLowerCase());
}

function forecastStation(
  station: Station,
  departureTime: string,
  arrivalMinutes: number,
  liveState: LiveRoutingState,
  scenario: SimulationScenario
): ForecastSnapshot {
  const arrival = new Date(new Date(departureTime).getTime() + arrivalMinutes * 60_000);
  const hour = arrival.getHours();
  const weekday = arrival.getDay();
  const profile = DEMAND_PROFILES[station.demandProfile];
  const hourlyCurve = station.historicalDemandProfile?.length === 24 ? station.historicalDemandProfile : profile.hourlyDemand;
  const profileDemand = hourlyCurve[hour] ?? profile.hourlyDemand[hour];
  const weekendMultiplier = weekday === 0 || weekday === 6 ? profile.weekendDemand : 1;
  const peakHour = (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 21);
  const stationSignal = liveStationSignal(station.id, liveState);
  const operatorTrustScore = station.operatorTrustScore ?? clamp(0.68 + station.reliabilityScore * 0.24, 0.62, 0.96);
  const congestionFactor = clamp(
    (station.peakHourCongestionFactor ?? 0.56) + (peakHour ? 0.14 : 0) + Math.max(0, liveState.trafficMultiplier - 1) * 0.22,
    0.25,
    1.45
  );
  const scenarioDemand = scenario === "high_station_demand" ? 0.18 : scenario === "peak_traffic" ? 0.08 : 0;
  const scenarioPrice = scenario === "price_surge" ? 0.18 : 0;
  const demandIndex = clamp(
    profileDemand * weekendMultiplier * (0.82 + station.busyFactor * 0.4) + congestionFactor * 0.18 + stationSignal * 0.05 + scenarioDemand,
    0.12,
    1.48
  );
  const availabilityRatio = clamp(
    1 -
      demandIndex * 0.58 -
      congestionFactor * 0.18 +
      (station.reliabilityScore - 0.72) * 0.24 +
      (operatorTrustScore - 0.72) * 0.18 +
      liveState.availabilityShift * 0.05 -
      (station.amenityScore > 0.88 ? 0.04 : 0),
    0.04,
    0.98
  );
  const availablePorts = clamp(Math.round(station.totalPorts * availabilityRatio), 0, station.totalPorts);
  const waitMultiplier = 1 + Math.max(0, liveState.trafficMultiplier - 1) * 0.42 + (scenario === "high_station_demand" ? 0.22 : 0);
  const predictedWaitMinutes = Math.round(
    clamp(
      (1 - availabilityRatio) * 44 * waitMultiplier +
        demandIndex * 16 +
        congestionFactor * 10 +
        (1 - station.reliabilityScore) * 14,
      3,
      88
    )
  );
  const surgeMultiplier = clamp(
    1 +
      scenarioPrice +
      Math.max(0, liveState.trafficMultiplier - 1) * 0.55 +
      Math.max(0, demandIndex - 0.42) * 0.42 +
      (profile.priceElasticity - 1) +
      liveState.priceShift * 0.08,
    0.94,
    1.58
  );
  const currentPricePerKwh = Number((station.basePricePerKwh * station.priceSensitivity).toFixed(2));
  const predictedPricePerKwh = Number((currentPricePerKwh * surgeMultiplier).toFixed(2));
  const availabilityConfidence = clamp(0.6 + station.reliabilityScore * 0.22 + operatorTrustScore * 0.1, 0.55, 0.96);
  const priceConfidence = clamp(0.58 + operatorTrustScore * 0.22 + (station.totalPorts / 12) * 0.1, 0.52, 0.95);
  const waitTimeConfidence = clamp((availabilityConfidence + priceConfidence) / 2 - demandIndex * 0.05, 0.5, 0.92);
  const forecastConfidence = Number(((availabilityConfidence + priceConfidence + waitTimeConfidence) / 3).toFixed(2));

  return {
    stationId: station.id,
    availablePorts,
    availabilityRatio: Number(availabilityRatio.toFixed(2)),
    predictedWaitMinutes,
    currentPricePerKwh,
    predictedPricePerKwh,
    trafficMultiplier: Number(liveState.trafficMultiplier.toFixed(2)),
    timestamp: arrival.toISOString(),
    confidence: forecastConfidence,
    forecastConfidence,
    demandIndex: Number(demandIndex.toFixed(2)),
    availabilityConfidence: Number(availabilityConfidence.toFixed(2)),
    priceConfidence: Number(priceConfidence.toFixed(2)),
    waitTimeConfidence: Number(waitTimeConfidence.toFixed(2)),
    probabilityAvailable: Number(availabilityRatio.toFixed(2)),
    peakHour,
    congestionFactor: Number(congestionFactor.toFixed(2)),
    surgeMultiplier: Number(surgeMultiplier.toFixed(2)),
    demandLevel: demandLevelFromIndex(demandIndex),
    comparison: {
      baselineWaitMinutes: Math.round(clamp(predictedWaitMinutes / surgeMultiplier, 2, 80)),
      baselinePricePerKwh: currentPricePerKwh
    },
    validation: { source: "heuristic" },
    source: "heuristic"
  };
}

function segmentEnergyKwh(request: TripRequest, segmentDistanceKm: number, segmentMinutes: number, liveState: LiveRoutingState) {
  const averageSpeedKph = clamp(segmentDistanceKm / Math.max(segmentMinutes / 60, 0.12), 18, 125);
  const baseEnergy = segmentDistanceKm / request.vehicle.efficiencyKmPerKwh;
  const speedMultiplier =
    averageSpeedKph > 72
      ? clamp(1 + (averageSpeedKph - 72) * 0.0085, 1, 1.46)
      : clamp(1 - (72 - averageSpeedKph) * 0.003, 0.9, 1.04);
  const stopGoEvents = Math.max(0, Math.round(segmentDistanceKm * Math.max(0.08, liveState.trafficMultiplier - 0.74) + segmentMinutes / 18));
  const stopGoPenalty = stopGoEvents * 0.032;
  const trafficPenalty = Math.max(0, liveState.trafficMultiplier - 1) * baseEnergy * 0.1;
  const auxiliaryPowerKw = request.simulateAcUsage === false ? 0.35 : liveState.refreshTime.getHours() >= 11 && liveState.refreshTime.getHours() <= 17 ? 1.8 : 1.1;
  const auxiliaryEnergy = auxiliaryPowerKw * (segmentMinutes / 60);
  const elevationGainM = segmentDistanceKm * 3.2;
  const elevationLossM = segmentDistanceKm * 2.3;
  const elevationNetEnergy = Math.max(-0.32, elevationGainM * 0.0052 - elevationLossM * 0.0028);
  const totalEnergyKwh = baseEnergy * speedMultiplier + stopGoPenalty + trafficPenalty + auxiliaryEnergy + elevationNetEnergy;
  return {
    totalEnergyKwh: Number(Math.max(0.05, totalEnergyKwh).toFixed(2)),
    averageSpeedKph: Number(averageSpeedKph.toFixed(1)),
    auxiliaryEnergyKwh: Number(auxiliaryEnergy.toFixed(2)),
    stopGoEvents,
    elevationGainM: Math.round(elevationGainM),
    elevationLossM: Math.round(elevationLossM),
    netElevationDeltaM: Math.round(elevationGainM - elevationLossM)
  };
}

function buildChargingStop(
  request: TripRequest,
  station: Station,
  currentSoc: number,
  segment: RouteMetrics,
  nextLeg: RouteMetrics,
  travelMinutesBeforeArrival: number,
  liveState: LiveRoutingState
): SegmentResult | null {
  if (!stationSupportsConnector(station, request.vehicle.connectorType)) return null;
  if (station.isOperational === false) return null;

  const segmentEnergy = segmentEnergyKwh(request, segment.distanceKm, segment.durationMinutes, liveState);
  const arrivalSoc = Number(clamp(currentSoc - (segmentEnergy.totalEnergyKwh / request.vehicle.batteryCapacityKwh) * 100, 0, 100).toFixed(2));
  const reserve = effectiveReserveSoc(request);
  if (arrivalSoc <= reserve) return null;

  const forecast = forecastStation(station, request.departureTime, travelMinutesBeforeArrival, liveState, request.simulationScenario || "baseline");
  if (forecast.availablePorts <= 0) return null;

  const nextEnergy = segmentEnergyKwh(request, nextLeg.distanceKm, nextLeg.durationMinutes, liveState);
  const requiredDepartureSoc = clamp(
    reserve + (nextEnergy.totalEnergyKwh / request.vehicle.batteryCapacityKwh) * 100 + 4,
    reserve + 6,
    92
  );
  const chargedEnergyKwh = Math.max(0, ((requiredDepartureSoc - arrivalSoc) / 100) * request.vehicle.batteryCapacityKwh);
  const chargingPowerKw = Math.min(request.vehicle.maxChargingPowerKw, station.maxPowerKw);
  const chargingMinutes = chargedEnergyKwh > 0 ? Math.round((chargedEnergyKwh / Math.max(chargingPowerKw, 25)) * 60 * 1.12) : 0;
  const chargingCost = Number((chargedEnergyKwh * forecast.predictedPricePerKwh).toFixed(2));
  const lowBufferRisk = arrivalSoc <= reserve + 6;
  const tightReachability = requiredDepartureSoc >= 88;

  return {
    distanceFromPreviousKm: segment.distanceKm,
    stop: {
      station,
      arrivalSoc,
      departureSoc: Number(requiredDepartureSoc.toFixed(2)),
      chargedEnergyKwh: Number(chargedEnergyKwh.toFixed(2)),
      chargingMinutes,
      chargingCost,
      waitMinutes: forecast.predictedWaitMinutes,
      forecast,
      lowBufferRisk,
      tightReachability
    }
  };
}

function encodeGeometry(geometry: Coordinates[]) {
  return geometry.map((point) => `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`).join(";");
}

function routeObjectives(route: RouteOption): RouteObjectives {
  return {
    timeMinutes: route.totalTravelMinutes,
    cost: route.totalChargingCost,
    batteryUsageKwh: route.totalEnergyKwh ?? 0,
    batteryUsagePercent: Number((((route.totalEnergyKwh ?? 0) / Math.max(route.totalEnergyKwh ?? 1, route.totalEnergyKwh ?? 1)) * 100).toFixed(1)),
    waitTimeMinutes: route.totalWaitMinutes
  };
}

function buildRouteSegmentPredictions(
  request: TripRequest,
  candidateSegments: RouteMetrics[],
  stops: ChargingStop[],
  liveState: LiveRoutingState
) {
  const labels = [request.origin.label || "Origin", ...stops.map((stop) => stop.station.name), request.destination.label || "Destination"];
  let currentSoc = request.startingSoc;

  return candidateSegments.map((segment, index): RouteSegmentPrediction => {
    const energy = segmentEnergyKwh(request, segment.distanceKm, segment.durationMinutes, liveState);
    const socEnd = Number(clamp(currentSoc - (energy.totalEnergyKwh / request.vehicle.batteryCapacityKwh) * 100, 0, 100).toFixed(2));
    const prediction: RouteSegmentPrediction = {
      label: `${labels[index]} to ${labels[index + 1]}`,
      from: labels[index],
      to: labels[index + 1],
      distanceKm: Number(segment.distanceKm.toFixed(2)),
      durationMinutes: Number(segment.durationMinutes.toFixed(1)),
      averageSpeedKph: energy.averageSpeedKph,
      socStart: Number(currentSoc.toFixed(2)),
      socEnd,
      driveEnergyKwh: Number((energy.totalEnergyKwh - energy.auxiliaryEnergyKwh).toFixed(2)),
      auxiliaryEnergyKwh: energy.auxiliaryEnergyKwh,
      totalEnergyKwh: energy.totalEnergyKwh,
      trafficMultiplier: liveState.trafficMultiplier,
      stopGoEvents: energy.stopGoEvents,
      elevationGainM: energy.elevationGainM,
      elevationLossM: energy.elevationLossM,
      netElevationDeltaM: energy.netElevationDeltaM,
      routeSteps: segment.steps.slice(0, 6)
    };
    currentSoc = stops[index]?.departureSoc ?? socEnd;
    return prediction;
  });
}

function buildRouteOption(
  request: TripRequest,
  candidate: CandidateBuild,
  directDistanceKm: number,
  liveState: LiveRoutingState
): RouteOption {
  const geometry = candidate.segments.flatMap((segment, index) => (index === 0 ? segment.geometry : segment.geometry.slice(1)));
  const totalDistanceKm = Number(candidate.segments.reduce((sum, segment) => sum + segment.distanceKm, 0).toFixed(2));
  const totalDriveMinutes = Number(candidate.segments.reduce((sum, segment) => sum + segment.durationMinutes, 0).toFixed(2));
  const totalChargingMinutes = candidate.stops.reduce((sum, stop) => sum + stop.chargingMinutes, 0);
  const totalWaitMinutes = candidate.stops.reduce((sum, stop) => sum + stop.waitMinutes, 0);
  const totalTravelMinutes = Math.round(totalDriveMinutes + totalChargingMinutes + totalWaitMinutes);
  const totalChargingCost = Number(candidate.stops.reduce((sum, stop) => sum + stop.chargingCost, 0).toFixed(2));
  const segments = buildRouteSegmentPredictions(request, candidate.segments, candidate.stops, liveState);
  const totalEnergyKwh = Number(segments.reduce((sum, segment) => sum + segment.totalEnergyKwh, 0).toFixed(2));
  const finalSoc = candidate.stops.at(-1)?.departureSoc ?? segments.at(-1)?.socEnd ?? request.startingSoc;
  const minimumArrivalSoc = Math.min(request.startingSoc, ...candidate.stops.map((stop) => stop.arrivalSoc), ...segments.map((segment) => segment.socEnd));
  const availabilityProbability =
    candidate.stops.length === 0
      ? 0.95
      : Number(
          (
            candidate.stops.reduce((product, stop) => product * Math.max(0.08, stop.forecast.probabilityAvailable ?? stop.forecast.availabilityRatio), 1)
          ).toFixed(2)
        );
  const detourKm = Number(Math.max(0, totalDistanceKm - directDistanceKm).toFixed(2));
  const trafficDelayMinutes = Math.max(
    0,
    Math.round(totalDriveMinutes - candidate.segments.reduce((sum, segment) => sum + segment.distanceKm / averageSpeedForMultiplier(1) * 60, 0))
  );
  const averageCongestion = Number(
    clamp(
      candidate.stops.length === 0
        ? liveState.trafficMultiplier - 0.82
        : candidate.stops.reduce((sum, stop) => sum + (stop.forecast.congestionFactor ?? 0.58), 0) / candidate.stops.length - 0.32,
      0,
      1
    ).toFixed(2)
  );
  const warnings = [
    minimumArrivalSoc <= effectiveReserveSoc(request) + 4 ? "Low buffer risk" : null,
    candidate.stops.some((stop) => stop.tightReachability) ? "Tight reachability" : null,
    candidate.stops.some((stop) => stop.forecast.demandLevel === "high") ? "High charger congestion" : null
  ].filter(Boolean) as string[];
  const routeSource = candidate.segments.some((segment) => segment.source === "mapbox")
    ? "mapbox"
    : candidate.segments.some((segment) => segment.source === "osrm")
      ? "osrm"
      : "heuristic";

  const route: RouteOption = {
    id: `${candidate.variant}-${candidate.stops.map((stop) => stop.station.id).join("-") || "direct"}`,
    label: candidate.label,
    routeVariant: candidate.variant,
    geometry,
    routePolyline: encodeGeometry(geometry),
    segments,
    totalDistanceKm,
    totalDriveMinutes: Math.round(totalDriveMinutes),
    totalChargingMinutes,
    totalWaitMinutes,
    totalTravelMinutes,
    totalChargingCost,
    detourKm,
    finalSoc: Number(finalSoc.toFixed(2)),
    minimumArrivalSoc: Number(minimumArrivalSoc.toFixed(2)),
    safetyBufferSoc: effectiveReserveSoc(request),
    trafficDelayMinutes,
    averageCongestion,
    totalEnergyKwh,
    availabilityProbability,
    warnings,
    score: 0,
    weightedScore: 0,
    paretoRank: 0,
    isParetoOptimal: false,
    dominanceCount: 0,
    objectives: {
      timeMinutes: totalTravelMinutes,
      cost: totalChargingCost,
      batteryUsageKwh: totalEnergyKwh,
      batteryUsagePercent: Number(((totalEnergyKwh / request.vehicle.batteryCapacityKwh) * 100).toFixed(1)),
      waitTimeMinutes: totalWaitMinutes
    },
    explanation: {
      distanceScore: 0,
      timeScore: 0,
      priceScore: 0,
      availabilityScore: 0,
      detourScore: 0,
      trafficScore: 0,
      congestionScore: 0,
      scoreBreakdown: {
        costContribution: { label: "Charging cost", value: totalChargingCost, displayValue: `Rs ${Math.round(totalChargingCost)}`, weight: 0, impact: "penalty", normalizedMagnitude: 0 },
        timeContribution: { label: "Travel time", value: totalTravelMinutes, displayValue: `${totalTravelMinutes} min`, weight: 0, impact: "penalty", normalizedMagnitude: 0 },
        availabilityContribution: { label: "Availability probability", value: availabilityProbability, displayValue: `${Math.round(availabilityProbability * 100)}%`, weight: 0, impact: "boost", normalizedMagnitude: 0 },
        detourContribution: { label: "Detour", value: detourKm, displayValue: `${detourKm.toFixed(1)} km`, weight: 0, impact: "penalty", normalizedMagnitude: 0 },
        energyContribution: { label: "Energy use", value: totalEnergyKwh, displayValue: `${totalEnergyKwh.toFixed(1)} kWh`, weight: 0, impact: "penalty", normalizedMagnitude: 0 }
      },
      whyChosen: "",
      chosenBecause: [],
      rejectedRouteComparisons: [],
      summary: "",
      tradeoffSummary: ""
    },
    routeSource,
    stops: candidate.stops
  };

  return route;
}

function dominates(a: RouteOption, b: RouteOption) {
  const aObjectives = a.objectives!;
  const bObjectives = b.objectives!;
  const aAvailabilityPenalty = 1 - (a.availabilityProbability ?? 0);
  const bAvailabilityPenalty = 1 - (b.availabilityProbability ?? 0);
  const noWorse =
    aObjectives.timeMinutes <= bObjectives.timeMinutes &&
    aObjectives.cost <= bObjectives.cost &&
    aObjectives.waitTimeMinutes <= bObjectives.waitTimeMinutes &&
    aObjectives.batteryUsageKwh <= bObjectives.batteryUsageKwh &&
    aAvailabilityPenalty <= bAvailabilityPenalty;
  const strictlyBetter =
    aObjectives.timeMinutes < bObjectives.timeMinutes ||
    aObjectives.cost < bObjectives.cost ||
    aObjectives.waitTimeMinutes < bObjectives.waitTimeMinutes ||
    aObjectives.batteryUsageKwh < bObjectives.batteryUsageKwh ||
    aAvailabilityPenalty < bAvailabilityPenalty;
  return noWorse && strictlyBetter;
}

function normalizeMetric(value: number, min: number, max: number, invert = false) {
  if (max <= min) return 0.5;
  const ratio = (value - min) / (max - min);
  return invert ? 1 - ratio : ratio;
}

function explanationSummary(route: RouteOption) {
  if (route.routeVariant === "direct") {
    return "Direct corridor remains feasible, so the engine avoids charging uncertainty and queue risk.";
  }
  return `Route uses ${route.stops.length} intelligently selected stop${route.stops.length === 1 ? "" : "s"} to preserve buffer while balancing wait time, price, and availability.`;
}

function annotateRoutes(routes: RouteOption[], request: TripRequest, preferences: OptimizationPreferences) {
  const paretoRoutes: RouteOption[] = [];
  const tradeoffChart: RouteTradeoffPoint[] = [];
  const times = routes.map((route) => route.objectives!.timeMinutes);
  const costs = routes.map((route) => route.objectives!.cost);
  const battery = routes.map((route) => route.objectives!.batteryUsageKwh);
  const waits = routes.map((route) => route.objectives!.waitTimeMinutes);
  const detours = routes.map((route) => route.detourKm);
  const availability = routes.map((route) => route.availabilityProbability ?? 0);

  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const minBattery = Math.min(...battery);
  const maxBattery = Math.max(...battery);
  const minWait = Math.min(...waits);
  const maxWait = Math.max(...waits);
  const minDetour = Math.min(...detours);
  const maxDetour = Math.max(...detours);
  const minAvailability = Math.min(...availability);
  const maxAvailability = Math.max(...availability);

  for (const route of routes) {
    const objectives = route.objectives!;
    const dominanceCount = routes.filter((candidate) => candidate.id !== route.id && dominates(candidate, route)).length;
    route.dominanceCount = dominanceCount;
    route.paretoRank = dominanceCount + 1;
    route.isParetoOptimal = dominanceCount === 0;
    if (route.isParetoOptimal) paretoRoutes.push(route);

    const timePenalty = normalizeMetric(objectives.timeMinutes, minTime, maxTime);
    const costPenalty = normalizeMetric(objectives.cost, minCost, maxCost);
    const batteryPenalty = normalizeMetric(objectives.batteryUsageKwh, minBattery, maxBattery);
    const waitPenalty = normalizeMetric(objectives.waitTimeMinutes, minWait, maxWait);
    const detourPenalty = normalizeMetric(route.detourKm, minDetour, maxDetour);
    const availabilityBoost = normalizeMetric(route.availabilityProbability ?? 0, minAvailability, maxAvailability, true);
    const lowBufferPenalty = route.minimumArrivalSoc && route.safetyBufferSoc ? normalizeMetric(route.minimumArrivalSoc, route.safetyBufferSoc, 95, true) : 0;

    const weightedScore =
      100 -
      timePenalty * preferences.time * 36 -
      costPenalty * preferences.cost * 28 -
      batteryPenalty * preferences.batteryUsage * 24 -
      waitPenalty * preferences.waitTime * 24 -
      detourPenalty * 12 -
      lowBufferPenalty * 10 +
      availabilityBoost * 16;

    route.weightedScore = Number(clamp(weightedScore, 1, 99).toFixed(1));
    route.score = route.weightedScore;
    route.explanation.distanceScore = Number((100 - normalizeMetric(route.totalDistanceKm, Math.min(...routes.map((item) => item.totalDistanceKm)), Math.max(...routes.map((item) => item.totalDistanceKm))) * 100).toFixed(1));
    route.explanation.timeScore = Number((100 - timePenalty * 100).toFixed(1));
    route.explanation.priceScore = Number((100 - costPenalty * 100).toFixed(1));
    route.explanation.availabilityScore = Number((availabilityBoost * 100).toFixed(1));
    route.explanation.detourScore = Number((100 - detourPenalty * 100).toFixed(1));
    route.explanation.trafficScore = Number((100 - normalizeMetric(route.trafficDelayMinutes ?? 0, Math.min(...routes.map((item) => item.trafficDelayMinutes ?? 0)), Math.max(...routes.map((item) => item.trafficDelayMinutes ?? 0))) * 100).toFixed(1));
    route.explanation.congestionScore = Number((100 - normalizeMetric(route.averageCongestion ?? 0, 0, 1) * 100).toFixed(1));
    route.explanation.scoreBreakdown = {
      costContribution: {
        label: "Cost contribution",
        value: objectives.cost,
        displayValue: `Rs ${Math.round(objectives.cost)}`,
        weight: preferences.cost,
        impact: "penalty",
        normalizedMagnitude: Number(costPenalty.toFixed(2))
      },
      timeContribution: {
        label: "Time contribution",
        value: objectives.timeMinutes,
        displayValue: `${objectives.timeMinutes} min`,
        weight: preferences.time,
        impact: "penalty",
        normalizedMagnitude: Number(timePenalty.toFixed(2))
      },
      availabilityContribution: {
        label: "Availability contribution",
        value: route.availabilityProbability ?? 0,
        displayValue: `${Math.round((route.availabilityProbability ?? 0) * 100)}%`,
        weight: 0.18,
        impact: "boost",
        normalizedMagnitude: Number(availabilityBoost.toFixed(2))
      },
      detourContribution: {
        label: "Detour penalty",
        value: route.detourKm,
        displayValue: `${route.detourKm.toFixed(1)} km`,
        weight: 0.12,
        impact: "penalty",
        normalizedMagnitude: Number(detourPenalty.toFixed(2))
      },
      energyContribution: {
        label: "Energy contribution",
        value: objectives.batteryUsageKwh,
        displayValue: `${objectives.batteryUsageKwh.toFixed(1)} kWh`,
        weight: preferences.batteryUsage,
        impact: "penalty",
        normalizedMagnitude: Number(batteryPenalty.toFixed(2))
      }
    };
    route.explanation.whyChosen =
      route.routeVariant === "direct"
        ? "The battery can comfortably reach the destination while holding the configured reserve buffer."
        : "The route keeps charger risk acceptable while protecting arrival SOC better than nearby alternatives.";
    route.explanation.chosenBecause = [
      `${route.totalTravelMinutes} min end-to-end ETA`,
      `${Math.round((route.availabilityProbability ?? 0) * 100)}% station availability probability`,
      `${route.minimumArrivalSoc}% lowest predicted SOC with ${route.safetyBufferSoc}% target buffer`
    ];
    route.explanation.summary = explanationSummary(route);
    route.explanation.tradeoffSummary = `${route.label} trades ${route.detourKm.toFixed(1)} km of detour for ${route.totalWaitMinutes} minutes of queue exposure and ${route.totalChargingCost.toFixed(0)} INR of charging spend.`;
    tradeoffChart.push({
      routeId: route.id,
      label: route.label,
      x: route.totalTravelMinutes,
      y: route.totalChargingCost,
      bubbleSize: Math.max(16, Math.round((route.availabilityProbability ?? 0.5) * 24)),
      bubbleLabel: `${route.stops.length} stop${route.stops.length === 1 ? "" : "s"}`
    });
  }

  const rankedRoutes = [...routes].sort((a, b) => (b.weightedScore ?? 0) - (a.weightedScore ?? 0));
  const fastest = [...routes].sort((a, b) => a.totalTravelMinutes - b.totalTravelMinutes)[0];
  const cheapest = [...routes].sort((a, b) => a.totalChargingCost - b.totalChargingCost)[0];
  const recommended = rankedRoutes[0];
  if (recommended) recommended.routeCategory = "recommended";
  if (fastest && fastest.id !== recommended?.id) fastest.routeCategory = "fastest";
  if (cheapest && cheapest.id !== recommended?.id && cheapest.id !== fastest?.id) cheapest.routeCategory = "cheapest";

  for (const route of routes) {
    const rejectedRouteComparisons: RejectedRouteComparison[] = rankedRoutes
      .filter((candidate) => candidate.id !== route.id)
      .slice(0, 3)
      .map((candidate) => ({
        routeId: candidate.id,
        routeLabel: candidate.label,
        scoreGap: Number(((route.weightedScore ?? 0) - (candidate.weightedScore ?? 0)).toFixed(1)),
        costDelta: Number((route.totalChargingCost - candidate.totalChargingCost).toFixed(2)),
        timeDelta: route.totalTravelMinutes - candidate.totalTravelMinutes,
        availabilityDelta: Number(((route.availabilityProbability ?? 0) - (candidate.availabilityProbability ?? 0)).toFixed(2)),
        verdict:
          (route.weightedScore ?? 0) >= (candidate.weightedScore ?? 0)
            ? "Preferred because it lands on a stronger multi-objective trade-off frontier."
            : "Alternative stays viable if the user wants a different time-versus-cost balance."
      }));
    route.explanation.rejectedRouteComparisons = rejectedRouteComparisons;
  }

  return {
    rankedRoutes,
    paretoRoutes: paretoRoutes.sort((a, b) => (b.weightedScore ?? 0) - (a.weightedScore ?? 0)),
    tradeoffChart
  };
}

function buildLiveSnapshot(routes: RouteOption[], liveState: LiveRoutingState): RecommendationResponse["liveSnapshot"] {
  const stops = routes.flatMap((route) => route.stops);
  const monitoredStations = new Set(stops.map((stop) => stop.station.id)).size;
  const averageAvailabilityRatio =
    stops.length > 0 ? stops.reduce((sum, stop) => sum + stop.forecast.availabilityRatio, 0) / stops.length : 0.92;
  const averagePredictedPricePerKwh =
    stops.length > 0 ? stops.reduce((sum, stop) => sum + stop.forecast.predictedPricePerKwh, 0) / stops.length : 0;
  return {
    refreshedAt: liveState.refreshTime.toISOString(),
    trafficLevel: liveState.trafficLevel,
    trafficMultiplier: liveState.trafficMultiplier,
    averageAvailabilityRatio: Number(averageAvailabilityRatio.toFixed(2)),
    averagePredictedPricePerKwh: Number(averagePredictedPricePerKwh.toFixed(2)),
    monitoredStations
  };
}

function stationCandidateScore(station: Station, origin: Coordinates, destination: Coordinates) {
  const midpointPenalty = roadDistanceKm(origin, station.coordinates) + roadDistanceKm(station.coordinates, destination);
  const trust = (station.operatorTrustScore ?? station.reliabilityScore) * 80;
  const reliability = station.reliabilityScore * 90;
  const congestionPenalty = (station.peakHourCongestionFactor ?? 0.55) * 30;
  return trust + reliability - midpointPenalty * 0.08 - congestionPenalty;
}

function uniqueCandidates<T extends RouteOption>(routes: T[]) {
  return Array.from(new Map(routes.map((route) => [route.id, route])).values());
}

export function getNearbyStations(center: Coordinates, radiusKm = 300) {
  return stations
    .map((station) => ({ station, distanceKm: Number(roadDistanceKm(center, station.coordinates).toFixed(2)) }))
    .filter(({ distanceKm }) => distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

export function getForecast(stationId: string, departureTime: string, offsetMinutes = 0) {
  const station = stations.find((entry) => entry.id === stationId);
  if (!station) return null;
  const fallbackRequest: TripRequest = {
    origin: station.coordinates,
    destination: station.coordinates,
    departureTime,
    startingSoc: 70,
    reserveSoc: 12,
    safetyBufferSoc: 18,
    mode: "balanced",
    vehicle: {
      batteryCapacityKwh: 75,
      efficiencyKmPerKwh: 6.2,
      maxChargingPowerKw: 180,
      connectorType: station.connectorType
    }
  };
  return forecastStation(station, departureTime, offsetMinutes, resolveLiveRoutingState(fallbackRequest), "baseline");
}

export async function recommendRoute(request: TripRequest): Promise<RecommendationResponse> {
  const liveState = resolveLiveRoutingState(request);
  const preferences = normalizePreferences(request.preferences);
  const directSegment = await routeSegment(request.origin, request.destination, liveState);
  const directDistanceKm = directSegment.distanceKm;
  const directEnergy = segmentEnergyKwh(request, directSegment.distanceKm, directSegment.durationMinutes, liveState);
  const reserve = effectiveReserveSoc(request);
  const directArrivalSoc = Number(
    clamp(request.startingSoc - (directEnergy.totalEnergyKwh / request.vehicle.batteryCapacityKwh) * 100, 0, 100).toFixed(2)
  );
  const initialUsableRange = usableRangeKm(request, Math.max(0, request.startingSoc - reserve));
  const candidates: RouteOption[] = [];

  if (directArrivalSoc >= reserve) {
    candidates.push(
      buildRouteOption(
        request,
        { label: "Direct Route", variant: "direct", segments: [directSegment], stops: [] },
        directDistanceKm,
        liveState
      )
    );
  }

  const compatibleStations = stations
    .filter((station) => stationSupportsConnector(station, request.vehicle.connectorType) && station.isOperational !== false)
    .sort(
      (a, b) =>
        stationCandidateScore(b, request.origin, request.destination) - stationCandidateScore(a, request.origin, request.destination)
    );

  const firstLegStations = compatibleStations
    .filter((station) => roadDistanceKm(request.origin, station.coordinates) <= initialUsableRange * 1.08)
    .slice(0, 10);

  for (const station of firstLegStations) {
    const [firstSegment, destinationSegment] = await routeSegments([request.origin, station.coordinates, request.destination], liveState);
    const firstStop = buildChargingStop(request, station, request.startingSoc, firstSegment, destinationSegment, firstSegment.durationMinutes, liveState);
    if (!firstStop) continue;

    const firstRoute = buildRouteOption(
      request,
      {
        label: "One-Stop Route",
        variant: "one-stop",
        segments: [firstSegment, destinationSegment],
        stops: [firstStop.stop]
      },
      directDistanceKm,
      liveState
    );

    if ((firstRoute.finalSoc ?? 0) >= reserve - 1) {
      candidates.push(firstRoute);
    }

    const rangeAfterCharge = usableRangeKm(request, Math.max(0, firstStop.stop.departureSoc - reserve));
    const secondLegStations = compatibleStations
      .filter(
        (nextStation) =>
          nextStation.id !== station.id &&
          roadDistanceKm(station.coordinates, nextStation.coordinates) <= rangeAfterCharge * 1.06 &&
          roadDistanceKm(nextStation.coordinates, request.destination) <= fullRangeKm(request) * 0.9
      )
      .slice(0, 7);

    for (const secondStation of secondLegStations) {
      const [middleSegment, finalSegment] = await routeSegments([station.coordinates, secondStation.coordinates, request.destination], liveState);
      const secondStopArrivalOffset =
        firstSegment.durationMinutes + firstStop.stop.waitMinutes + firstStop.stop.chargingMinutes + middleSegment.durationMinutes;
      const secondStop = buildChargingStop(request, secondStation, firstStop.stop.departureSoc, middleSegment, finalSegment, secondStopArrivalOffset, liveState);
      if (!secondStop) continue;

      const secondRoute = buildRouteOption(
        request,
        {
          label: "Multi-Stop Route",
          variant: "multi-stop",
          segments: [firstSegment, middleSegment, finalSegment],
          stops: [firstStop.stop, secondStop.stop]
        },
        directDistanceKm,
        liveState
      );

      if ((secondRoute.finalSoc ?? 0) >= reserve - 1) {
        candidates.push(secondRoute);
      }
    }
  }

  const unique = uniqueCandidates(candidates);
  if (unique.length === 0) {
    return {
      bestRoute: null,
      alternatives: [],
      paretoRoutes: [],
      directDistanceKm: Number(directDistanceKm.toFixed(2)),
      feasible: false,
      reason: "No feasible route was found. Increase starting SOC or choose a corridor with reachable compatible charging stations.",
      generatedAt: new Date().toISOString(),
      routeSource: directSegment.source,
      simulationScenario: request.simulationScenario || "baseline",
      optimization: { strategy: "pareto-dynamic-weighted", preferences, frontierSize: 0, tradeoffChart: [] },
      liveSnapshot: buildLiveSnapshot([], liveState)
    };
  }

  const annotated = annotateRoutes(unique, request, preferences);
  const rankedRoutes = annotated.rankedRoutes;
  const bestRoute = rankedRoutes[0];
  return {
    bestRoute,
    alternatives: rankedRoutes.slice(1, 4),
    paretoRoutes: annotated.paretoRoutes,
    directDistanceKm: Number(directDistanceKm.toFixed(2)),
    feasible: true,
    generatedAt: new Date().toISOString(),
    routeSource: bestRoute.routeSource,
    simulationScenario: request.simulationScenario || "baseline",
    optimization: {
      strategy: "pareto-dynamic-weighted",
      preferences,
      frontierSize: annotated.paretoRoutes.length,
      tradeoffChart: annotated.tradeoffChart
    },
    liveSnapshot: buildLiveSnapshot(rankedRoutes, liveState)
  };
}

import { stations } from "@/lib/stations";
import type {
  ChargingStop,
  Coordinates,
  ForecastSnapshot,
  OptimizationPreferences,
  RecommendationMode,
  RecommendationResponse,
  RouteObjectives,
  RouteOption,
  Station,
  TripRequest
} from "@/lib/types";

type SegmentResult = {
  stop: ChargingStop;
  distanceFromPreviousKm: number;
};

type RouteMetrics = {
  distanceKm: number;
  durationMinutes: number;
  geometry: Coordinates[];
  source: "heuristic" | "osrm";
};

const ROAD_MULTIPLIER = 1.18;
const OSRM_URL = process.env.OSRM_URL || "https://router.project-osrm.org";
const CHARGING_OVERHEAD_FACTOR = 0.04;

const DEMAND_PROFILES = {
  metro_peak: {
    hourlyDemand: [0.34, 0.28, 0.24, 0.22, 0.2, 0.26, 0.46, 0.72, 0.92, 0.98, 0.84, 0.76, 0.7, 0.72, 0.78, 0.83, 0.92, 1, 0.96, 0.88, 0.74, 0.6, 0.48, 0.4],
    weekendDemand: 0.9,
    priceElasticity: 1.12
  },
  commuter_corridor: {
    hourlyDemand: [0.26, 0.22, 0.2, 0.18, 0.2, 0.28, 0.5, 0.7, 0.82, 0.76, 0.66, 0.62, 0.64, 0.68, 0.72, 0.8, 0.88, 0.92, 0.86, 0.78, 0.66, 0.52, 0.4, 0.3],
    weekendDemand: 1.04,
    priceElasticity: 1.02
  },
  business_district: {
    hourlyDemand: [0.18, 0.16, 0.14, 0.12, 0.12, 0.2, 0.38, 0.58, 0.78, 0.9, 0.96, 0.92, 0.86, 0.84, 0.82, 0.8, 0.86, 0.9, 0.82, 0.66, 0.48, 0.34, 0.26, 0.2],
    weekendDemand: 0.78,
    priceElasticity: 1.08
  },
  destination_leisure: {
    hourlyDemand: [0.22, 0.18, 0.16, 0.14, 0.16, 0.2, 0.26, 0.32, 0.4, 0.5, 0.62, 0.72, 0.8, 0.86, 0.9, 0.92, 0.94, 0.88, 0.76, 0.6, 0.46, 0.36, 0.28, 0.24],
    weekendDemand: 1.16,
    priceElasticity: 0.98
  }
} as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function round1(value: number) {
  return Number(value.toFixed(1));
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

function defaultPreferencesForMode(mode: RecommendationMode): OptimizationPreferences {
  if (mode === "fastest") {
    return { time: 0.48, cost: 0.16, batteryUsage: 0.18, waitTime: 0.18 };
  }
  if (mode === "cheapest") {
    return { time: 0.18, cost: 0.46, batteryUsage: 0.22, waitTime: 0.14 };
  }
  return { time: 0.32, cost: 0.24, batteryUsage: 0.24, waitTime: 0.2 };
}

function normalizePreferences(preferences: OptimizationPreferences | undefined, mode: RecommendationMode): OptimizationPreferences {
  const base = preferences ?? defaultPreferencesForMode(mode);
  const safe = {
    time: Math.max(0, base.time),
    cost: Math.max(0, base.cost),
    batteryUsage: Math.max(0, base.batteryUsage),
    waitTime: Math.max(0, base.waitTime)
  };
  const sum = safe.time + safe.cost + safe.batteryUsage + safe.waitTime;
  if (sum <= 0) return defaultPreferencesForMode(mode);

  return {
    time: Number((safe.time / sum).toFixed(4)),
    cost: Number((safe.cost / sum).toFixed(4)),
    batteryUsage: Number((safe.batteryUsage / sum).toFixed(4)),
    waitTime: Number((safe.waitTime / sum).toFixed(4))
  };
}

function tradeoffPriority(preferences: OptimizationPreferences) {
  return Object.entries(preferences)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key as keyof OptimizationPreferences);
}

async function routeSegment(a: Coordinates, b: Coordinates, fallbackHour: number): Promise<RouteMetrics> {
  try {
    const response = await fetch(
      `${OSRM_URL}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`,
      { cache: "no-store" }
    );
    if (!response.ok) throw new Error("OSRM request failed");
    const payload = (await response.json()) as {
      routes?: Array<{ distance: number; duration: number; geometry?: { coordinates: number[][] } }>;
    };
    const route = payload.routes?.[0];
    if (!route) throw new Error("OSRM returned no route");
    return {
      distanceKm: Number((route.distance / 1000).toFixed(2)),
      durationMinutes: Number((route.duration / 60).toFixed(2)),
      geometry: route.geometry?.coordinates.map(([lng, lat]) => ({ lat, lng })) ?? [a, b],
      source: "osrm"
    };
  } catch {
    const distanceKm = roadDistanceKm(a, b);
    return {
      distanceKm: Number(distanceKm.toFixed(2)),
      durationMinutes: Number(((distanceKm / averageSpeedForHour(fallbackHour)) * 60).toFixed(2)),
      geometry: [a, b],
      source: "heuristic"
    };
  }
}

async function routeSegments(points: Coordinates[], fallbackHour: number): Promise<RouteMetrics[]> {
  return await Promise.all(points.slice(0, -1).map((point, index) => routeSegment(point, points[index + 1], fallbackHour)));
}

function trafficMultiplierForHour(hour: number) {
  if ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 21)) return 1.35;
  if (hour >= 11 && hour <= 16) return 1.12;
  if (hour >= 22 || hour <= 5) return 0.9;
  return 1;
}

function averageSpeedForHour(hour: number) {
  return clamp(72 / trafficMultiplierForHour(hour), 32, 88);
}

function forecastStation(station: Station, departureTime: string, arrivalMinutes: number): ForecastSnapshot {
  const arrival = new Date(new Date(departureTime).getTime() + arrivalMinutes * 60_000);
  const hour = arrival.getHours();
  const weekday = arrival.getDay();
  const profile = DEMAND_PROFILES[station.demandProfile];
  const profileDemand = profile.hourlyDemand[hour];
  const weekendMultiplier = weekday === 0 || weekday === 6 ? profile.weekendDemand : 1;
  const trafficMultiplier = trafficMultiplierForHour(hour);
  const demandIndex = clamp(profileDemand * weekendMultiplier * (0.86 + station.busyFactor * 0.42), 0.14, 1.35);
  const areaPressure = station.areaType === "urban" ? 0.06 : station.areaType === "highway" ? 0.04 : 0.02;
  const reliabilityBonus = (station.reliabilityScore - 0.75) * 0.22;
  const amenityPull = station.amenityScore > 0.84 ? 0.04 : 0;
  const baseAvailability = clamp(1 - demandIndex * 0.72 - areaPressure + reliabilityBonus - amenityPull, 0.06, 0.97);
  const availablePorts = clamp(Math.round(station.totalPorts * baseAvailability), 0, station.totalPorts);
  const predictedWaitMinutes = Math.round(
    clamp((1 - baseAvailability) * 46 + demandIndex * 18 + (trafficMultiplier - 1) * 24 + (1 - station.reliabilityScore) * 14, 4, 70)
  );
  const surgeMultiplier = 1 + Math.max(0, trafficMultiplier - 1) * 0.65 + (demandIndex - 0.4) * 0.35 + (profile.priceElasticity - 1);
  const predictedPricePerKwh = Number((station.basePricePerKwh * station.priceSensitivity * surgeMultiplier).toFixed(2));
  const confidence = clamp(0.58 + station.reliabilityScore * 0.28 + (station.totalPorts / 12) * 0.12, 0.55, 0.95);

  return {
    stationId: station.id,
    availablePorts,
    availabilityRatio: Number(baseAvailability.toFixed(2)),
    predictedWaitMinutes,
    currentPricePerKwh: station.basePricePerKwh,
    predictedPricePerKwh,
    trafficMultiplier,
    timestamp: arrival.toISOString(),
    confidence: Number(confidence.toFixed(2)),
    demandIndex: Number(demandIndex.toFixed(2))
  };
}

function fullRangeKm(request: TripRequest) {
  return request.vehicle.batteryCapacityKwh * request.vehicle.efficiencyKmPerKwh;
}

function usableRangeKm(request: TripRequest, soc: number) {
  return fullRangeKm(request) * (soc / 100);
}

function buildChargingStop(
  request: TripRequest,
  station: Station,
  currentSoc: number,
  segmentDistanceKm: number,
  nextLegDistanceKm: number,
  travelMinutesBeforeArrival: number
): SegmentResult | null {
  const fullRange = fullRangeKm(request);
  const arrivalSoc = Number((currentSoc - (segmentDistanceKm / fullRange) * 100).toFixed(2));
  if (arrivalSoc <= request.reserveSoc) return null;

  const forecast = forecastStation(station, request.departureTime, travelMinutesBeforeArrival);
  if (station.connectorType !== request.vehicle.connectorType) return null;
  if (forecast.availablePorts <= 0) return null;

  const requiredDepartureSoc = clamp(
    request.reserveSoc + (nextLegDistanceKm / fullRange) * 100 + 12,
    request.reserveSoc + 8,
    92
  );

  if (requiredDepartureSoc <= arrivalSoc) {
    return {
      distanceFromPreviousKm: segmentDistanceKm,
      stop: {
        station,
        arrivalSoc,
        departureSoc: arrivalSoc,
        chargedEnergyKwh: 0,
        chargingMinutes: 0,
        chargingCost: 0,
        waitMinutes: forecast.predictedWaitMinutes,
        forecast
      }
    };
  }

  const chargedEnergyKwh = ((requiredDepartureSoc - arrivalSoc) / 100) * request.vehicle.batteryCapacityKwh;
  const chargingPowerKw = Math.min(request.vehicle.maxChargingPowerKw, station.maxPowerKw);
  const chargingMinutes = Math.round((chargedEnergyKwh / chargingPowerKw) * 60 * 1.12);
  const chargingCost = Number((chargedEnergyKwh * forecast.predictedPricePerKwh).toFixed(2));

  return {
    distanceFromPreviousKm: segmentDistanceKm,
    stop: {
      station,
      arrivalSoc,
      departureSoc: Number(requiredDepartureSoc.toFixed(2)),
      chargedEnergyKwh: Number(chargedEnergyKwh.toFixed(2)),
      chargingMinutes,
      chargingCost,
      waitMinutes: forecast.predictedWaitMinutes,
      forecast
    }
  };
}

function buildRoutePolyline(geometry: Coordinates[]) {
  return geometry.map((point) => `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`).join(";");
}

function buildObjectives(
  request: TripRequest,
  totalDistanceKm: number,
  totalTravelMinutes: number,
  totalChargingCost: number,
  totalWaitMinutes: number,
  stops: ChargingStop[]
): RouteObjectives {
  const drivingEnergyKwh = totalDistanceKm / request.vehicle.efficiencyKmPerKwh;
  const chargingOverheadKwh = stops.reduce((sum, stop) => sum + stop.chargedEnergyKwh * CHARGING_OVERHEAD_FACTOR, 0);
  const batteryUsageKwh = Number((drivingEnergyKwh + chargingOverheadKwh).toFixed(2));
  const batteryUsagePercent = Number(((batteryUsageKwh / request.vehicle.batteryCapacityKwh) * 100).toFixed(1));

  return {
    timeMinutes: Math.round(totalTravelMinutes),
    cost: Number(totalChargingCost.toFixed(2)),
    batteryUsageKwh,
    batteryUsagePercent,
    waitTimeMinutes: Math.round(totalWaitMinutes)
  };
}

function dominates(a: RouteOption, b: RouteOption) {
  const aObjectives = a.objectives;
  const bObjectives = b.objectives;
  if (!aObjectives || !bObjectives) return false;

  const noWorse =
    aObjectives.timeMinutes <= bObjectives.timeMinutes &&
    aObjectives.cost <= bObjectives.cost &&
    aObjectives.batteryUsageKwh <= bObjectives.batteryUsageKwh &&
    aObjectives.waitTimeMinutes <= bObjectives.waitTimeMinutes;
  const strictlyBetter =
    aObjectives.timeMinutes < bObjectives.timeMinutes ||
    aObjectives.cost < bObjectives.cost ||
    aObjectives.batteryUsageKwh < bObjectives.batteryUsageKwh ||
    aObjectives.waitTimeMinutes < bObjectives.waitTimeMinutes;

  return noWorse && strictlyBetter;
}

function computeParetoRanks(routes: RouteOption[]) {
  const dominationCounts = new Map<string, number>();
  const dominatesMap = new Map<string, string[]>();
  const frontier = new Map<number, string[]>();

  for (const route of routes) {
    dominationCounts.set(route.id, 0);
    dominatesMap.set(route.id, []);
  }

  for (const route of routes) {
    for (const contender of routes) {
      if (route.id === contender.id) continue;
      if (dominates(route, contender)) {
        dominatesMap.get(route.id)?.push(contender.id);
      } else if (dominates(contender, route)) {
        dominationCounts.set(route.id, (dominationCounts.get(route.id) ?? 0) + 1);
      }
    }

    if ((dominationCounts.get(route.id) ?? 0) === 0) {
      frontier.set(1, [...(frontier.get(1) ?? []), route.id]);
    }
  }

  let rank = 1;
  while ((frontier.get(rank) ?? []).length > 0) {
    const nextFront: string[] = [];
    for (const routeId of frontier.get(rank) ?? []) {
      for (const dominatedRouteId of dominatesMap.get(routeId) ?? []) {
        const nextCount = (dominationCounts.get(dominatedRouteId) ?? 0) - 1;
        dominationCounts.set(dominatedRouteId, nextCount);
        if (nextCount === 0) nextFront.push(dominatedRouteId);
      }
    }
    rank += 1;
    if (nextFront.length > 0) frontier.set(rank, nextFront);
  }

  return { dominationCounts, frontier };
}

function normalizeMetric(value: number, min: number, max: number) {
  if (max <= min) return 0;
  return (value - min) / (max - min);
}

function weightedPenalty(route: RouteOption, routes: RouteOption[], preferences: OptimizationPreferences) {
  if (!route.objectives) return 0;
  const timeValues = routes.map((candidate) => candidate.objectives?.timeMinutes ?? candidate.totalTravelMinutes);
  const costValues = routes.map((candidate) => candidate.objectives?.cost ?? candidate.totalChargingCost);
  const batteryValues = routes.map((candidate) => candidate.objectives?.batteryUsageKwh ?? candidate.totalDistanceKm);
  const waitValues = routes.map((candidate) => candidate.objectives?.waitTimeMinutes ?? candidate.totalWaitMinutes);

  return (
    normalizeMetric(route.objectives.timeMinutes, Math.min(...timeValues), Math.max(...timeValues)) * preferences.time +
    normalizeMetric(route.objectives.cost, Math.min(...costValues), Math.max(...costValues)) * preferences.cost +
    normalizeMetric(route.objectives.batteryUsageKwh, Math.min(...batteryValues), Math.max(...batteryValues)) * preferences.batteryUsage +
    normalizeMetric(route.objectives.waitTimeMinutes, Math.min(...waitValues), Math.max(...waitValues)) * preferences.waitTime
  );
}

function buildTradeoffSummary(route: RouteOption, preferences: OptimizationPreferences) {
  const objectives = route.objectives;
  if (!objectives) return "Trade-off summary unavailable.";
  const focus = tradeoffPriority(preferences);
  const lead = focus[0];
  const secondary = focus[1];

  const leadText =
    lead === "time"
      ? `travel time at ${objectives.timeMinutes} min`
      : lead === "cost"
        ? `charging spend near Rs. ${Math.round(objectives.cost)}`
        : lead === "batteryUsage"
          ? `battery draw around ${objectives.batteryUsageKwh} kWh`
          : `queue exposure limited to ${objectives.waitTimeMinutes} min`;

  const secondaryText =
    secondary === "time"
      ? `${objectives.timeMinutes} min end-to-end`
      : secondary === "cost"
        ? `Rs. ${Math.round(objectives.cost)} charging cost`
        : secondary === "batteryUsage"
          ? `${objectives.batteryUsagePercent}% battery-equivalent energy`
          : `${objectives.waitTimeMinutes} min of wait time`;

  return `${route.isParetoOptimal ? "Pareto-efficient" : "Trade-off route"} with ${leadText} while keeping ${secondaryText}.`;
}

function buildExplanation(route: RouteOption, mode: RecommendationMode, preferences: OptimizationPreferences) {
  const objectives = route.objectives;
  const baseWeights = defaultPreferencesForMode(mode);
  const avgAvailability =
    route.stops.length === 0 ? 0.92 : route.stops.reduce((sum, stop) => sum + stop.forecast.availabilityRatio, 0) / route.stops.length;

  return {
    distanceScore: Number(Math.max(0, 100 - route.totalDistanceKm * 0.18).toFixed(1)),
    timeScore: Number(Math.max(0, 100 - (objectives?.timeMinutes ?? route.totalTravelMinutes) * (0.18 + baseWeights.time * 0.22)).toFixed(1)),
    priceScore: Number(Math.max(0, 100 - (objectives?.cost ?? route.totalChargingCost) * (0.14 + baseWeights.cost * 0.2)).toFixed(1)),
    availabilityScore: Number(Math.min(100, avgAvailability * 100).toFixed(1)),
    detourScore: Number(Math.max(0, 100 - route.detourKm * 0.35).toFixed(1)),
    trafficScore: Number(Math.max(0, 100 - (route.trafficDelayMinutes ?? 0) * 1.6).toFixed(1)),
    congestionScore: Number(Math.max(0, 100 - (route.averageCongestion ?? 0) * 100).toFixed(1)),
    summary:
      route.stops.length === 0
        ? "Direct routing is feasible, so the optimizer avoids charging uncertainty and preserves frontier dominance on waiting time."
        : `Route is evaluated on a Pareto frontier across time, cost, battery use, and wait time, then ranked using the active ${mode} preference profile.`,
    tradeoffSummary: buildTradeoffSummary(route, preferences)
  };
}

function buildRouteOption(
  request: TripRequest,
  label: string,
  geometry: Coordinates[],
  stops: ChargingStop[],
  directDistanceKm: number,
  totalDistanceKm: number,
  totalDriveMinutes: number,
  routeSource: "heuristic" | "osrm"
): RouteOption {
  const totalChargingMinutes = stops.reduce((sum, stop) => sum + stop.chargingMinutes, 0);
  const totalWaitMinutes = stops.reduce((sum, stop) => sum + stop.waitMinutes, 0);
  const totalChargingCost = Number(stops.reduce((sum, stop) => sum + stop.chargingCost, 0).toFixed(2));
  const totalTravelMinutes = totalDriveMinutes + totalChargingMinutes + totalWaitMinutes;
  const detourKm = Number(Math.max(0, totalDistanceKm - directDistanceKm).toFixed(2));
  const departureHour = new Date(request.departureTime).getHours();
  const trafficMultiplier = trafficMultiplierForHour(departureHour);
  const trafficDelayMinutes = Math.round(Math.max(0, totalDriveMinutes - totalDriveMinutes / trafficMultiplier));
  const averageCongestion = Number(clamp((trafficMultiplier - 0.85) / 0.7, 0.08, 0.96).toFixed(2));

  return {
    id: `${label.toLowerCase().replace(/\s+/g, "-")}-${stops.map((stop) => stop.station.id).join("-") || "direct"}`,
    label,
    geometry,
    routePolyline: buildRoutePolyline(geometry),
    totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
    totalDriveMinutes: Math.round(totalDriveMinutes),
    totalChargingMinutes,
    totalWaitMinutes,
    totalTravelMinutes: Math.round(totalTravelMinutes),
    totalChargingCost,
    detourKm,
    trafficDelayMinutes,
    averageCongestion,
    score: 0,
    weightedScore: 0,
    paretoRank: 999,
    isParetoOptimal: false,
    dominanceCount: 0,
    objectives: buildObjectives(request, totalDistanceKm, totalTravelMinutes, totalChargingCost, totalWaitMinutes, stops),
    explanation: {
      distanceScore: 0,
      timeScore: 0,
      priceScore: 0,
      availabilityScore: 0,
      detourScore: 0,
      trafficScore: 0,
      congestionScore: 0,
      summary: "",
      tradeoffSummary: ""
    },
    routeSource,
    stops
  };
}

function rankRoutes(routes: RouteOption[], request: TripRequest) {
  const preferences = normalizePreferences(request.preferences, request.mode);
  const { dominationCounts, frontier } = computeParetoRanks(routes);
  const routeById = new Map(routes.map((route) => [route.id, route]));

  for (const [rank, routeIds] of frontier.entries()) {
    for (const routeId of routeIds) {
      const route = routeById.get(routeId);
      if (!route) continue;
      route.paretoRank = rank;
      route.isParetoOptimal = rank === 1;
      route.dominanceCount = dominationCounts.get(route.id) ?? 0;
    }
  }

  for (const route of routes) {
    const penalty = weightedPenalty(route, routes, preferences);
    const paretoBoost = route.isParetoOptimal ? 8 : 0;
    route.weightedScore = Number(clamp(100 - penalty * 100 + paretoBoost - ((route.paretoRank ?? 1) - 1) * 4, 1, 99).toFixed(1));
    route.score = route.weightedScore;
    route.explanation = buildExplanation(route, request.mode, preferences);
  }

  const ranked = [...routes].sort((a, b) => {
    if ((a.paretoRank ?? 999) !== (b.paretoRank ?? 999)) return (a.paretoRank ?? 999) - (b.paretoRank ?? 999);
    if ((b.weightedScore ?? 0) !== (a.weightedScore ?? 0)) return (b.weightedScore ?? 0) - (a.weightedScore ?? 0);
    return (a.objectives?.timeMinutes ?? a.totalTravelMinutes) - (b.objectives?.timeMinutes ?? b.totalTravelMinutes);
  });

  const paretoRoutes = ranked.filter((route) => route.isParetoOptimal);
  return { ranked, paretoRoutes, preferences };
}

function buildTradeoffChart(routes: RouteOption[]) {
  const timeValues = routes.map((route) => route.objectives?.timeMinutes ?? route.totalTravelMinutes);
  const costValues = routes.map((route) => route.objectives?.cost ?? route.totalChargingCost);
  const batteryValues = routes.map((route) => route.objectives?.batteryUsageKwh ?? route.totalDistanceKm);

  return routes.map((route) => ({
    routeId: route.id,
    label: route.label,
    x: round1(normalizeMetric(route.objectives?.timeMinutes ?? route.totalTravelMinutes, Math.min(...timeValues), Math.max(...timeValues)) * 100),
    y: round1(normalizeMetric(route.objectives?.cost ?? route.totalChargingCost, Math.min(...costValues), Math.max(...costValues)) * 100),
    bubbleSize: round1(12 + normalizeMetric(route.objectives?.batteryUsageKwh ?? route.totalDistanceKm, Math.min(...batteryValues), Math.max(...batteryValues)) * 20),
    bubbleLabel: `${route.objectives?.batteryUsageKwh ?? 0} kWh / ${route.objectives?.waitTimeMinutes ?? route.totalWaitMinutes} min wait`
  }));
}

export function getNearbyStations(center: Coordinates, radiusKm = 300) {
  return stations
    .map((station) => ({
      station,
      distanceKm: Number(roadDistanceKm(center, station.coordinates).toFixed(2))
    }))
    .filter(({ distanceKm }) => distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

export function getForecast(stationId: string, departureTime: string, offsetMinutes = 0) {
  const station = stations.find((entry) => entry.id === stationId);
  if (!station) return null;
  return forecastStation(station, departureTime, offsetMinutes);
}

export async function recommendRoute(request: TripRequest): Promise<RecommendationResponse> {
  const hour = new Date(request.departureTime).getHours();
  const directSegment = await routeSegment(request.origin, request.destination, hour);
  const directDistanceKm = directSegment.distanceKm;
  const directDriveMinutes = directSegment.durationMinutes;
  const initialUsableRange = usableRangeKm(request, request.startingSoc - request.reserveSoc);
  const allCandidates: RouteOption[] = [];
  const normalizedPreferences = normalizePreferences(request.preferences, request.mode);

  if (initialUsableRange >= directDistanceKm) {
    allCandidates.push(
      buildRouteOption(
        request,
        "Direct Route",
        directSegment.geometry,
        [],
        directDistanceKm,
        directDistanceKm,
        directDriveMinutes,
        directSegment.source
      )
    );
  }

  const firstLegStations = stations.filter((station) => {
    if (station.connectorType !== request.vehicle.connectorType) return false;
    return roadDistanceKm(request.origin, station.coordinates) <= initialUsableRange;
  });

  for (const station of firstLegStations) {
    const [firstSegment, destinationSegment] = await routeSegments([request.origin, station.coordinates, request.destination], hour);
    const firstLegKm = firstSegment.distanceKm;
    const remainingToDestinationKm = destinationSegment.distanceKm;
    const firstLegMinutes = firstSegment.durationMinutes;
    const firstStop = buildChargingStop(
      request,
      station,
      request.startingSoc,
      firstLegKm,
      remainingToDestinationKm,
      firstLegMinutes
    );
    if (!firstStop) continue;

    const rangeAfterCharge = usableRangeKm(request, firstStop.stop.departureSoc - request.reserveSoc);
    if (rangeAfterCharge >= remainingToDestinationKm) {
      allCandidates.push(
        buildRouteOption(
          request,
          "One-Stop Smart Route",
          [...firstSegment.geometry.slice(0, -1), ...destinationSegment.geometry],
          [firstStop.stop],
          directDistanceKm,
          firstLegKm + remainingToDestinationKm,
          firstLegMinutes + destinationSegment.durationMinutes,
          firstSegment.source === "osrm" || destinationSegment.source === "osrm" ? "osrm" : "heuristic"
        )
      );
    }

    const secondLegStations = stations.filter((nextStation) => {
      if (nextStation.id === station.id) return false;
      if (nextStation.connectorType !== request.vehicle.connectorType) return false;
      return roadDistanceKm(station.coordinates, nextStation.coordinates) <= rangeAfterCharge;
    });

    for (const secondStation of secondLegStations) {
      const [middleSegment, finalSegment] = await routeSegments([station.coordinates, secondStation.coordinates, request.destination], hour);
      const toSecondKm = middleSegment.distanceKm;
      const secondStopArrivalOffset =
        firstLegMinutes + firstStop.stop.waitMinutes + firstStop.stop.chargingMinutes + middleSegment.durationMinutes;
      const secondStop = buildChargingStop(
        request,
        secondStation,
        firstStop.stop.departureSoc,
        toSecondKm,
        finalSegment.distanceKm,
        secondStopArrivalOffset
      );
      if (!secondStop) continue;

      const finalLegKm = finalSegment.distanceKm;
      const finalRange = usableRangeKm(request, secondStop.stop.departureSoc - request.reserveSoc);
      if (finalRange < finalLegKm) continue;

      allCandidates.push(
        buildRouteOption(
          request,
          "Two-Stop Resilient Route",
          [...firstSegment.geometry.slice(0, -1), ...middleSegment.geometry.slice(0, -1), ...finalSegment.geometry],
          [firstStop.stop, secondStop.stop],
          directDistanceKm,
          firstLegKm + toSecondKm + finalLegKm,
          firstLegMinutes + middleSegment.durationMinutes + finalSegment.durationMinutes,
          firstSegment.source === "osrm" || middleSegment.source === "osrm" || finalSegment.source === "osrm" ? "osrm" : "heuristic"
        )
      );
    }
  }

  const uniqueCandidates = Array.from(new Map(allCandidates.map((route) => [route.id, route])).values());

  if (uniqueCandidates.length === 0) {
    return {
      bestRoute: null,
      alternatives: [],
      paretoRoutes: [],
      directDistanceKm: Number(directDistanceKm.toFixed(2)),
      feasible: false,
      reason: "No feasible route was found. Increase starting SOC or choose a corridor with reachable compatible charging stations.",
      generatedAt: new Date().toISOString(),
      routeSource: directSegment.source,
      optimization: {
        strategy: "pareto-dynamic-weighted",
        preferences: normalizedPreferences,
        frontierSize: 0,
        tradeoffChart: []
      }
    };
  }

  const { ranked, paretoRoutes, preferences } = rankRoutes(uniqueCandidates, request);

  return {
    bestRoute: ranked[0],
    alternatives: ranked.slice(1, 4),
    paretoRoutes,
    directDistanceKm: Number(directDistanceKm.toFixed(2)),
    feasible: true,
    generatedAt: new Date().toISOString(),
    routeSource: ranked[0].routeSource,
    optimization: {
      strategy: "pareto-dynamic-weighted",
      preferences,
      frontierSize: paretoRoutes.length,
      tradeoffChart: buildTradeoffChart(ranked)
    }
  };
}

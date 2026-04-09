import { recommendRoute, getForecast, getNearbyStations } from "./routing";
import type {
  OptimizationPreferences,
  RecommendationMode,
  RecommendationResponse,
  RouteObjectives,
  RouteOption,
  RouteTradeoffPoint,
  TripRequest
} from "./types";

const serviceUrl =
  process.env.API_GATEWAY_URL || process.env.PYTHON_SERVICE_URL || "http://127.0.0.1:8000";

const modePreferenceDefaults: Record<RecommendationMode, OptimizationPreferences> = {
  balanced: { time: 32, cost: 24, batteryUsage: 24, waitTime: 20 },
  fastest: { time: 48, cost: 16, batteryUsage: 18, waitTime: 18 },
  cheapest: { time: 18, cost: 46, batteryUsage: 22, waitTime: 14 }
};

function normalizePreferences(
  preferences: OptimizationPreferences | undefined,
  mode: RecommendationMode
): OptimizationPreferences {
  const base = preferences ?? modePreferenceDefaults[mode];
  const total = base.time + base.cost + base.batteryUsage + base.waitTime;

  if (total <= 0) {
    return { time: 25, cost: 25, batteryUsage: 25, waitTime: 25 };
  }

  return {
    time: Math.round((base.time / total) * 100),
    cost: Math.round((base.cost / total) * 100),
    batteryUsage: Math.round((base.batteryUsage / total) * 100),
    waitTime: Math.round((base.waitTime / total) * 100)
  };
}

function buildObjectives(route: RouteOption, request: TripRequest): RouteObjectives {
  const driveEnergyKwh = route.totalDistanceKm / request.vehicle.efficiencyKmPerKwh;
  const chargeEnergyKwh = route.stops.reduce((sum, stop) => sum + stop.chargedEnergyKwh, 0);
  const batteryUsageKwh = Number(Math.max(driveEnergyKwh, chargeEnergyKwh || driveEnergyKwh).toFixed(2));
  const batteryUsagePercent = Number(
    Math.min(100, (batteryUsageKwh / request.vehicle.batteryCapacityKwh) * 100).toFixed(1)
  );

  return {
    timeMinutes: route.totalTravelMinutes,
    cost: route.totalChargingCost,
    batteryUsageKwh,
    batteryUsagePercent,
    waitTimeMinutes: route.totalWaitMinutes
  };
}

function dominates(a: RouteObjectives, b: RouteObjectives) {
  const notWorse =
    a.timeMinutes <= b.timeMinutes &&
    a.cost <= b.cost &&
    a.batteryUsageKwh <= b.batteryUsageKwh &&
    a.waitTimeMinutes <= b.waitTimeMinutes;
  const strictlyBetter =
    a.timeMinutes < b.timeMinutes ||
    a.cost < b.cost ||
    a.batteryUsageKwh < b.batteryUsageKwh ||
    a.waitTimeMinutes < b.waitTimeMinutes;

  return notWorse && strictlyBetter;
}

function normalizeScore(value: number, min: number, max: number) {
  if (max <= min) return 0;
  return (value - min) / (max - min);
}

function buildTradeoffChart(routes: RouteOption[]): RouteTradeoffPoint[] {
  const times = routes.map((route) => route.objectives!.timeMinutes);
  const costs = routes.map((route) => route.objectives!.cost);
  const battery = routes.map((route) => route.objectives!.batteryUsagePercent);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const minBattery = Math.min(...battery);
  const maxBattery = Math.max(...battery);

  return routes.map((route) => {
    const objectives = route.objectives!;
    const bubbleScale = normalizeScore(objectives.batteryUsagePercent, minBattery, maxBattery);
    return {
      routeId: route.id,
      label: route.label,
      x: Number((100 - normalizeScore(objectives.timeMinutes, minTime, maxTime) * 100).toFixed(1)),
      y: Number((100 - normalizeScore(objectives.cost, minCost, maxCost) * 100).toFixed(1)),
      bubbleSize: Math.round(18 + bubbleScale * 18),
      bubbleLabel: `${objectives.timeMinutes} min, INR ${Math.round(objectives.cost)}, ${Math.round(
        objectives.batteryUsagePercent
      )}% battery`
    };
  });
}

function normalizeRecommendationResponse(
  response: RecommendationResponse,
  request: TripRequest
): RecommendationResponse {
  if (!response.bestRoute) {
    return {
      ...response,
      alternatives: response.alternatives ?? [],
      paretoRoutes: [],
      optimization: {
        strategy: "pareto-dynamic-weighted",
        preferences: normalizePreferences(request.preferences, request.mode),
        frontierSize: 0,
        tradeoffChart: []
      }
    };
  }

  const preferences = normalizePreferences(request.preferences, request.mode);
  const routes = [response.bestRoute, ...(response.alternatives ?? [])].map((route) => ({
    ...route,
    weightedScore: route.weightedScore ?? route.score,
    objectives: route.objectives ?? buildObjectives(route, request),
    routePolyline: route.routePolyline ?? "",
    segments: route.segments ?? [],
    finalSoc: route.finalSoc ?? Math.max(request.reserveSoc, request.startingSoc - (route.totalDistanceKm / request.vehicle.efficiencyKmPerKwh / request.vehicle.batteryCapacityKwh) * 100),
    minimumArrivalSoc: route.minimumArrivalSoc ?? request.reserveSoc,
    safetyBufferSoc: route.safetyBufferSoc ?? request.safetyBufferSoc ?? request.reserveSoc,
    explanation: {
      ...route.explanation,
      trafficScore: route.explanation.trafficScore ?? Math.max(0, 100 - route.totalWaitMinutes * 1.2),
      congestionScore: route.explanation.congestionScore ?? Math.max(0, 100 - (route.averageCongestion ?? 0) * 100),
      tradeoffSummary:
        route.explanation.tradeoffSummary ??
        `${route.label} balances ${route.totalTravelMinutes} minutes of travel, INR ${Math.round(route.totalChargingCost)} charging cost, and ${route.totalWaitMinutes} minutes of queue exposure.`,
      chosenBecause:
        route.explanation.chosenBecause ??
        [
          `Travel time: ${route.totalTravelMinutes} min`,
          `Charging cost: INR ${Math.round(route.totalChargingCost)}`,
          `Charging stops: ${route.stops.length}`
        ]
    }
  }));

  for (const route of routes) {
    const dominanceCount = routes.filter(
      (candidate) => candidate.id !== route.id && dominates(candidate.objectives!, route.objectives!)
    ).length;
    route.dominanceCount = route.dominanceCount ?? dominanceCount;
    route.isParetoOptimal = route.isParetoOptimal ?? dominanceCount === 0;
    route.paretoRank = route.paretoRank ?? dominanceCount + 1;
  }

  const paretoRoutes = routes
    .filter((route) => route.isParetoOptimal)
    .sort((a, b) => (a.weightedScore ?? a.score) - (b.weightedScore ?? b.score) || b.score - a.score);

  const rankedRoutes = [...routes].sort((a, b) => (b.weightedScore ?? b.score) - (a.weightedScore ?? a.score) || b.score - a.score);
  const bestRoute = rankedRoutes[0];
  const alternatives = rankedRoutes.slice(1, 4);

  return {
    ...response,
    bestRoute,
    alternatives,
    paretoRoutes,
    optimization: {
      strategy: "pareto-dynamic-weighted",
      preferences,
      frontierSize: paretoRoutes.length,
      tradeoffChart: buildTradeoffChart(paretoRoutes.length > 0 ? paretoRoutes : rankedRoutes)
    }
  };
}

export async function requestRecommendation(payload: TripRequest): Promise<RecommendationResponse> {
  if (payload.liveContext?.refreshToken) {
    return normalizeRecommendationResponse(await recommendRoute(payload), payload);
  }

  try {
    const response = await fetch(`${serviceUrl}/route/recommend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Python service error: ${response.status}`);
    }

    return normalizeRecommendationResponse((await response.json()) as RecommendationResponse, payload);
  } catch {
    return normalizeRecommendationResponse(await recommendRoute(payload), payload);
  }
}

export async function requestNearbyStations(lat: number, lng: number, radiusKm: number) {
  try {
    const response = await fetch(`${serviceUrl}/stations/nearby?lat=${lat}&lng=${lng}&radiusKm=${radiusKm}`, {
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error(`Python service error: ${response.status}`);
    }
    return await response.json();
  } catch {
    return { stations: await getNearbyStations({ lat, lng }, radiusKm) };
  }
}

export async function requestStationForecast(stationId: string, departureTime: string, offsetMinutes = 0) {
  try {
    const response = await fetch(
      `${serviceUrl}/forecast/station/${stationId}?departureTime=${encodeURIComponent(departureTime)}&offsetMinutes=${offsetMinutes}`,
      { cache: "no-store" }
    );
    if (!response.ok) {
      throw new Error(`Python service error: ${response.status}`);
    }
    return await response.json();
  } catch {
    const forecast = getForecast(stationId, departureTime, offsetMinutes);
    return forecast ? { forecast } : { forecast: null };
  }
}

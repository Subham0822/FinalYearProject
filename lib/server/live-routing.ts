import { stationSupportsConnector } from "@/lib/station-normalization";
import { getNearbyStationsLive, getStationsForTrip } from "@/lib/station-service";
import type {
  ChargingStop,
  Coordinates,
  ForecastSnapshot,
  RecommendationMode,
  RecommendationResponse,
  RouteOption,
  Station,
  TripRequest
} from "@/lib/types";

type SegmentResult = {
  stop: ChargingStop;
  distanceFromPreviousKm: number;
};

const ROAD_MULTIPLIER = 1.18;
const OSRM_URL = process.env.OSRM_URL || "https://router.project-osrm.org";

type RouteMetrics = {
  distanceKm: number;
  durationMinutes: number;
  geometry: Coordinates[];
  source: "heuristic" | "osrm";
};

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
  const statusPenalty = station.isOperational === false ? 0.4 : station.liveStatus?.toLowerCase().includes("planned") ? 0.16 : 0;
  const liveStatusBonus = station.isOperational === true ? 0.04 : 0;
  const baseAvailability = clamp(1 - demandIndex * 0.72 - areaPressure + reliabilityBonus - amenityPull - statusPenalty + liveStatusBonus, 0.02, 0.97);
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
  if (!stationSupportsConnector(station, request.vehicle.connectorType)) return null;
  if (station.isOperational === false) return null;
  if (forecast.availablePorts <= 0) return null;

  const requiredDepartureSoc = clamp(request.reserveSoc + (nextLegDistanceKm / fullRange) * 100 + 12, request.reserveSoc + 8, 92);
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

function scoreWeights(mode: RecommendationMode) {
  if (mode === "fastest") return { distance: 0.18, time: 0.34, price: 0.12, availability: 0.2, detour: 0.16 };
  if (mode === "cheapest") return { distance: 0.16, time: 0.16, price: 0.34, availability: 0.18, detour: 0.16 };
  return { distance: 0.2, time: 0.26, price: 0.2, availability: 0.18, detour: 0.16 };
}

function buildExplanation(route: RouteOption, mode: RecommendationMode) {
  const weights = scoreWeights(mode);
  const distancePenalty = route.totalDistanceKm * weights.distance;
  const timePenalty = route.totalTravelMinutes * weights.time;
  const pricePenalty = route.totalChargingCost * weights.price;
  const availabilityBoost =
    route.stops.length === 0
      ? 16
      : (route.stops.reduce((sum, stop) => sum + stop.forecast.availabilityRatio, 0) / route.stops.length) * 20 * weights.availability;
  const detourPenalty = route.detourKm * weights.detour;

  return {
    distanceScore: Number(Math.max(0, 100 - distancePenalty).toFixed(1)),
    timeScore: Number(Math.max(0, 100 - timePenalty).toFixed(1)),
    priceScore: Number(Math.max(0, 100 - pricePenalty).toFixed(1)),
    availabilityScore: Number(Math.min(100, availabilityBoost * 4).toFixed(1)),
    detourScore: Number(Math.max(0, 100 - detourPenalty).toFixed(1)),
    summary:
      route.stops.length === 0
        ? "Direct route is feasible with the current battery, so charging delays and price volatility are avoided."
        : `Route favors stations with stronger predicted availability and lower time-adjusted charging cost under the ${mode} profile.`
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
  const weights = scoreWeights(request.mode);
  const avgAvailability = stops.length === 0 ? 0.92 : stops.reduce((sum, stop) => sum + stop.forecast.availabilityRatio, 0) / stops.length;

  const rawScore =
    100 -
    totalDistanceKm * weights.distance -
    totalTravelMinutes * weights.time -
    totalChargingCost * weights.price -
    detourKm * weights.detour +
    avgAvailability * 100 * weights.availability;

  const route: RouteOption = {
    id: `${label.toLowerCase().replace(/\s+/g, "-")}-${stops.map((stop) => stop.station.id).join("-") || "direct"}`,
    label,
    geometry,
    routePolyline: geometry.map((point) => `${point.lat},${point.lng}`).join(";"),
    segments: [],
    totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
    totalDriveMinutes: Math.round(totalDriveMinutes),
    totalChargingMinutes,
    totalWaitMinutes,
    totalTravelMinutes: Math.round(totalTravelMinutes),
    totalChargingCost,
    detourKm,
    finalSoc: Number(
      Math.max(
        request.reserveSoc,
        request.startingSoc - (totalDistanceKm / (request.vehicle.batteryCapacityKwh * request.vehicle.efficiencyKmPerKwh)) * 100
      ).toFixed(2)
    ),
    minimumArrivalSoc: request.reserveSoc,
    safetyBufferSoc: request.safetyBufferSoc ?? request.reserveSoc,
    trafficDelayMinutes: totalWaitMinutes,
    averageCongestion: Number((1 - avgAvailability).toFixed(2)),
    weightedScore: Number(rawScore.toFixed(2)),
    paretoRank: 1,
    isParetoOptimal: true,
    dominanceCount: 0,
    objectives: {
      timeMinutes: Math.round(totalTravelMinutes),
      cost: totalChargingCost,
      batteryUsageKwh: Number((totalDistanceKm / request.vehicle.efficiencyKmPerKwh).toFixed(2)),
      batteryUsagePercent: Number(((totalDistanceKm / request.vehicle.efficiencyKmPerKwh / request.vehicle.batteryCapacityKwh) * 100).toFixed(1)),
      waitTimeMinutes: totalWaitMinutes
    },
    score: Number(clamp(rawScore, 1, 99).toFixed(1)),
    explanation: {
      distanceScore: 0,
      timeScore: 0,
      priceScore: 0,
      availabilityScore: 0,
      detourScore: 0,
      trafficScore: 0,
      congestionScore: 0,
      summary: ""
    },
    routeSource,
    stops
  };

  route.explanation = buildExplanation(route, request.mode);
  return route;
}

export async function getNearbyStations(center: Coordinates, radiusKm = 300, connectorType?: string) {
  return (await getNearbyStationsLive(center, radiusKm, connectorType)).stations;
}

export function getForecast(stationId: string, departureTime: string, offsetMinutes = 0) {
  void stationId;
  void departureTime;
  void offsetMinutes;
  return null;
}

export async function recommendRoute(request: TripRequest): Promise<RecommendationResponse> {
  const { stations, provider } = await getStationsForTrip(request.origin, request.destination, request.vehicle.connectorType);
  const hour = new Date(request.departureTime).getHours();
  const directSegment = await routeSegment(request.origin, request.destination, hour);
  const directDistanceKm = directSegment.distanceKm;
  const directDriveMinutes = directSegment.durationMinutes;
  const initialUsableRange = usableRangeKm(request, request.startingSoc - request.reserveSoc);
  const allCandidates: RouteOption[] = [];

  if (initialUsableRange >= directDistanceKm) {
    allCandidates.push(
      buildRouteOption(request, "Direct Route", directSegment.geometry, [], directDistanceKm, directDistanceKm, directDriveMinutes, directSegment.source)
    );
  }

  const firstLegStations = stations.filter((station) => {
    if (!stationSupportsConnector(station, request.vehicle.connectorType)) return false;
    if (station.isOperational === false) return false;
    return roadDistanceKm(request.origin, station.coordinates) <= initialUsableRange;
  });

  for (const station of firstLegStations) {
    const [firstSegment, destinationSegment] = await routeSegments([request.origin, station.coordinates, request.destination], hour);
    const firstLegKm = firstSegment.distanceKm;
    const remainingToDestinationKm = destinationSegment.distanceKm;
    const firstLegMinutes = firstSegment.durationMinutes;
    const firstStop = buildChargingStop(request, station, request.startingSoc, firstLegKm, remainingToDestinationKm, firstLegMinutes);
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
      if (!stationSupportsConnector(nextStation, request.vehicle.connectorType)) return false;
      if (nextStation.isOperational === false) return false;
      return roadDistanceKm(station.coordinates, nextStation.coordinates) <= rangeAfterCharge;
    });

    for (const secondStation of secondLegStations) {
      const [middleSegment, finalSegment] = await routeSegments([station.coordinates, secondStation.coordinates, request.destination], hour);
      const toSecondKm = middleSegment.distanceKm;
      const secondStopArrivalOffset = firstLegMinutes + firstStop.stop.waitMinutes + firstStop.stop.chargingMinutes + middleSegment.durationMinutes;
      const secondStop = buildChargingStop(
        request,
        secondStation,
        firstStop.stop.departureSoc,
        toSecondKm,
        finalSegment.distanceKm,
        secondStopArrivalOffset
      );
      if (!secondStop) continue;

      const finalRange = usableRangeKm(request, secondStop.stop.departureSoc - request.reserveSoc);
      if (finalRange < finalSegment.distanceKm) continue;

      allCandidates.push(
        buildRouteOption(
          request,
          "Two-Stop Resilient Route",
          [...firstSegment.geometry.slice(0, -1), ...middleSegment.geometry.slice(0, -1), ...finalSegment.geometry],
          [firstStop.stop, secondStop.stop],
          directDistanceKm,
          firstLegKm + toSecondKm + finalSegment.distanceKm,
          firstLegMinutes + middleSegment.durationMinutes + finalSegment.durationMinutes,
          firstSegment.source === "osrm" || middleSegment.source === "osrm" || finalSegment.source === "osrm" ? "osrm" : "heuristic"
        )
      );
    }
  }

  const uniqueCandidates = Array.from(new Map(allCandidates.map((route) => [route.id, route])).values()).sort((a, b) => b.score - a.score);
  if (uniqueCandidates.length === 0) {
    return {
      bestRoute: null,
      alternatives: [],
      paretoRoutes: [],
      directDistanceKm: Number(directDistanceKm.toFixed(2)),
      feasible: false,
      reason: `No feasible route was found. Increase starting SOC or choose a corridor with reachable compatible charging stations. Data source: ${provider}.`,
      generatedAt: new Date().toISOString(),
      routeSource: directSegment.source,
      optimization: {
        strategy: "pareto-dynamic-weighted",
        preferences: request.preferences ?? { time: 0.3, cost: 0.3, batteryUsage: 0.2, waitTime: 0.2 },
        frontierSize: 0,
        tradeoffChart: []
      }
    };
  }

  return {
    bestRoute: uniqueCandidates[0],
    alternatives: uniqueCandidates.slice(1, 4),
    paretoRoutes: uniqueCandidates,
    directDistanceKm: Number(directDistanceKm.toFixed(2)),
    feasible: true,
    generatedAt: new Date().toISOString(),
    routeSource: uniqueCandidates[0].routeSource,
    optimization: {
      strategy: "pareto-dynamic-weighted",
      preferences: request.preferences ?? { time: 0.3, cost: 0.3, batteryUsage: 0.2, waitTime: 0.2 },
      frontierSize: uniqueCandidates.length,
      tradeoffChart: uniqueCandidates.map((route) => ({
        routeId: route.id,
        label: route.label,
        x: route.totalTravelMinutes,
        y: route.totalChargingCost,
        bubbleSize: 28,
        bubbleLabel: `${route.totalTravelMinutes} min / ${route.totalChargingCost} cost`
      }))
    }
  };
}

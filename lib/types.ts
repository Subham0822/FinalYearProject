export type Coordinates = {
  lat: number;
  lng: number;
};

export type LocationOption = Coordinates & {
  id: string;
  label: string;
  state: string;
};

export type Station = {
  id: string;
  name: string;
  operator: string;
  city: string;
  state: string;
  coordinates: Coordinates;
  chargerType: string;
  connectorType: string;
  connectorTypes?: string[];
  maxPowerKw: number;
  totalPorts: number;
  basePricePerKwh: number;
  busyFactor: number;
  priceSensitivity: number;
  demandProfile: "metro_peak" | "commuter_corridor" | "business_district" | "destination_leisure";
  areaType: "urban" | "highway" | "suburban";
  reliabilityScore: number;
  peakHourCongestionFactor?: number;
  operatorTrustScore?: number;
  historicalDemandProfile?: number[];
  connectorCompatibility?: string[];
  amenityScore: number;
  liveStatus?: string | null;
  liveStatusTypeId?: number | null;
  statusUpdatedAt?: string | null;
  isOperational?: boolean;
  dataSource?: string;
};

export type VehicleInput = {
  batteryCapacityKwh: number;
  efficiencyKmPerKwh: number;
  maxChargingPowerKw: number;
  connectorType: string;
};

export type RecommendationMode = "balanced" | "fastest" | "cheapest";

export type SimulationScenario = "baseline" | "peak_traffic" | "high_station_demand" | "price_surge";

export type OptimizationPreferenceKey = "time" | "cost" | "batteryUsage" | "waitTime";

export type OptimizationPreferences = Record<OptimizationPreferenceKey, number>;

export type LiveContext = {
  refreshToken?: string;
};

export type TripRequest = {
  origin: Coordinates & { label?: string };
  destination: Coordinates & { label?: string };
  departureTime: string;
  startingSoc: number;
  reserveSoc: number;
  safetyBufferSoc?: number;
  simulateAcUsage?: boolean;
  vehicle: VehicleInput;
  mode: RecommendationMode;
  preferences?: OptimizationPreferences;
  simulationScenario?: SimulationScenario;
  liveContext?: LiveContext;
};

export type ForecastSnapshot = {
  stationId: string;
  availablePorts: number;
  availabilityRatio: number;
  predictedWaitMinutes: number;
  currentPricePerKwh: number;
  predictedPricePerKwh: number;
  trafficMultiplier: number;
  timestamp: string;
  confidence: number;
  demandIndex: number;
  forecastConfidence?: number;
  availabilityConfidence?: number;
  priceConfidence?: number;
  waitTimeConfidence?: number;
  probabilityAvailable?: number;
  peakHour?: boolean;
  congestionFactor?: number;
  surgeMultiplier?: number;
  demandLevel?: "low" | "moderate" | "high";
  comparison?: {
    baselineWaitMinutes?: number;
    baselinePricePerKwh?: number;
  };
  validation?: {
    source?: string;
  };
  source?: "heuristic" | "ml";
};

export type ChargingStop = {
  station: Station;
  arrivalSoc: number;
  departureSoc: number;
  chargedEnergyKwh: number;
  chargingMinutes: number;
  chargingCost: number;
  waitMinutes: number;
  forecast: ForecastSnapshot;
  lowBufferRisk?: boolean;
  tightReachability?: boolean;
};

export type RouteStep = {
  instruction: string;
  distanceKm: number;
  durationMinutes: number;
  maneuver: string;
  roadName?: string;
};

export type RouteSegmentPrediction = {
  label: string;
  from: string;
  to: string;
  distanceKm: number;
  durationMinutes: number;
  averageSpeedKph: number;
  socStart: number;
  socEnd: number;
  driveEnergyKwh: number;
  auxiliaryEnergyKwh: number;
  totalEnergyKwh: number;
  trafficMultiplier: number;
  stopGoEvents: number;
  elevationGainM: number;
  elevationLossM: number;
  netElevationDeltaM: number;
  routeSteps?: RouteStep[];
};

export type RouteObjectives = {
  timeMinutes: number;
  cost: number;
  batteryUsageKwh: number;
  batteryUsagePercent: number;
  waitTimeMinutes: number;
};

export type RouteTradeoffPoint = {
  routeId: string;
  label: string;
  x: number;
  y: number;
  bubbleSize: number;
  bubbleLabel: string;
};

export type ScoreContribution = {
  label: string;
  value: number;
  displayValue: string;
  weight: number;
  impact: "penalty" | "boost";
  normalizedMagnitude: number;
};

export type RejectedRouteComparison = {
  routeId: string;
  routeLabel: string;
  scoreGap: number;
  costDelta: number;
  timeDelta: number;
  availabilityDelta: number;
  verdict: string;
};

export type LiveNetworkSnapshot = {
  refreshedAt: string;
  trafficLevel: "light" | "moderate" | "heavy";
  trafficMultiplier: number;
  averageAvailabilityRatio: number;
  averagePredictedPricePerKwh: number;
  monitoredStations: number;
};

export type StationNetworkSummary = {
  count: number;
  live: boolean;
  provider: string;
  connectorType: string;
  fetchedAt: string;
};

export type RouteOption = {
  id: string;
  label: string;
  routeCategory?: "recommended" | "fastest" | "cheapest";
  routeVariant?: "direct" | "one-stop" | "multi-stop";
  geometry: Coordinates[];
  routePolyline?: string;
  segments?: RouteSegmentPrediction[];
  totalDistanceKm: number;
  totalDriveMinutes: number;
  totalChargingMinutes: number;
  totalWaitMinutes: number;
  totalTravelMinutes: number;
  totalChargingCost: number;
  detourKm: number;
  finalSoc?: number;
  minimumArrivalSoc?: number;
  safetyBufferSoc?: number;
  trafficDelayMinutes?: number;
  averageCongestion?: number;
  totalEnergyKwh?: number;
  availabilityProbability?: number;
  warnings?: string[];
  score: number;
  weightedScore?: number;
  paretoRank?: number;
  isParetoOptimal?: boolean;
  dominanceCount?: number;
  objectives?: RouteObjectives;
  explanation: {
    distanceScore: number;
    timeScore: number;
    priceScore: number;
    availabilityScore: number;
    detourScore: number;
    trafficScore?: number;
    congestionScore?: number;
    scoreBreakdown?: {
      costContribution: ScoreContribution;
      timeContribution: ScoreContribution;
      availabilityContribution: ScoreContribution;
      detourContribution?: ScoreContribution;
      energyContribution?: ScoreContribution;
    };
    whyChosen?: string;
    chosenBecause?: string[];
    rejectedRouteComparisons?: RejectedRouteComparison[];
    summary: string;
    tradeoffSummary?: string;
  };
  routeSource: "heuristic" | "osrm" | "mapbox";
  stops: ChargingStop[];
};

export type RecommendationResponse = {
  recommendationId?: string;
  bestRoute: RouteOption | null;
  alternatives: RouteOption[];
  paretoRoutes: RouteOption[];
  directDistanceKm: number;
  feasible: boolean;
  reason?: string;
  generatedAt: string;
  routeSource: "heuristic" | "osrm" | "mapbox";
  simulationScenario?: SimulationScenario;
  optimization: {
    strategy: "pareto-dynamic-weighted";
    preferences: OptimizationPreferences;
    frontierSize: number;
    tradeoffChart: RouteTradeoffPoint[];
  };
  liveSnapshot?: LiveNetworkSnapshot;
};

export type SelectionSource = "recommended-default" | "user-manual";

export type RouteFeedbackPayload = {
  recommendationId: string;
  routeId: string;
  completed: boolean;
  satisfactionScore?: number | null;
  actualTravelMinutes?: number | null;
  actualChargingCost?: number | null;
  actualWaitMinutes?: number | null;
  actualDistanceKm?: number | null;
  actualChargingStops?: number | null;
  notes?: string | null;
};

export type AnalyticsSummary = {
  totals: {
    recommendations: number;
    selections: number;
    feedbackEntries: number;
    retrainingSamples: number;
    feedbackCoverage: number;
  };
  routeChoiceBreakdown: Array<{
    routeLabel: string;
    selections: number;
  }>;
  modeBreakdown: Array<{
    mode: RecommendationMode;
    count: number;
  }>;
  predictionAccuracy: {
    travelMinutesMae: number;
    chargingCostMae: number;
    waitMinutesMae: number;
  };
  recentOutcomes: Array<{
    recommendationId: string;
    routeId: string;
    routeLabel: string;
    submittedAt: string;
    completed: boolean;
    satisfactionScore: number | null;
    predictedTravelMinutes: number;
    actualTravelMinutes: number | null;
    predictedChargingCost: number;
    actualChargingCost: number | null;
    predictedWaitMinutes: number;
    actualWaitMinutes: number | null;
    mode: RecommendationMode;
    notes: string | null;
  }>;
  trainingExportUrl: string;
};

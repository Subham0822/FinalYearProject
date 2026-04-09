import fallbackStations from "@/data/stations.india.json";
import type { Station } from "@/lib/types";

type DemandProfile = Station["demandProfile"];
type AreaType = Station["areaType"];

type OpenChargeMapConnection = {
  ConnectionType?: { Title?: string | null } | null;
  Level?: { Title?: string | null; IsFastChargeCapable?: boolean | null } | null;
  StatusType?: { IsOperational?: boolean | null; Title?: string | null } | null;
  PowerKW?: number | null;
  Quantity?: number | null;
};

type OpenChargeMapPoi = {
  ID: number;
  UUID?: string | null;
  UsageCost?: string | null;
  NumberOfPoints?: number | null;
  DateLastVerified?: string | null;
  DateLastStatusUpdate?: string | null;
  IsRecentlyVerified?: boolean | null;
  OperatorInfo?: { Title?: string | null } | null;
  UsageType?: { Title?: string | null } | null;
  StatusType?: { ID?: number | null; IsOperational?: boolean | null; Title?: string | null } | null;
  Connections?: OpenChargeMapConnection[] | null;
  AddressInfo?: {
    Title?: string | null;
    Town?: string | null;
    StateOrProvince?: string | null;
    Latitude?: number | null;
    Longitude?: number | null;
    Distance?: number | null;
  } | null;
};

const DEFAULT_OPERATOR = "Open Network";
const DEFAULT_CITY = "Unknown";
const DEFAULT_STATE = "Unknown";
const DEFAULT_CONNECTOR = "CCS2";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeConnectorLabel(label?: string | null) {
  const value = (label || "").trim().toLowerCase();
  if (!value) return null;
  if (value.includes("ccs") && value.includes("2")) return "CCS2";
  if (value.includes("ccs")) return "CCS";
  if (value.includes("type 2")) return "Type 2";
  if (value.includes("cha")) return "CHAdeMO";
  if (value.includes("bharat")) return "Bharat DC";
  if (value.includes("gb/t") || value.includes("gbt")) return "GB/T";
  if (value.includes("tesla")) return "Tesla";
  return label?.trim() || null;
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function parseUsageCost(usageCost?: string | null) {
  if (!usageCost) return null;
  const normalized = usageCost.replace(/,/g, " ");
  const match = normalized.match(/(?:rs\.?|inr|₹)\s*([0-9]+(?:\.[0-9]+)?)/i) ?? normalized.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount : null;
}

function detectChargerType(connections: OpenChargeMapConnection[], maxPowerKw: number) {
  const titles = connections
    .flatMap((connection) => [connection.Level?.Title, connection.ConnectionType?.Title])
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  if (titles.includes("rapid") || titles.includes("dc") || maxPowerKw >= 50) return "DC Fast";
  if (titles.includes("slow") || maxPowerKw <= 22) return "AC";
  return maxPowerKw > 22 ? "DC Fast" : "AC";
}

function inferAreaType(poi: OpenChargeMapPoi): AreaType {
  const title = `${poi.AddressInfo?.Title || ""} ${poi.UsageType?.Title || ""}`.toLowerCase();
  if (title.includes("highway") || title.includes("expressway") || title.includes("toll")) return "highway";
  if (title.includes("mall") || title.includes("office") || title.includes("metro") || title.includes("airport")) return "urban";
  return "suburban";
}

function inferDemandProfile(areaType: AreaType, poi: OpenChargeMapPoi): DemandProfile {
  const title = `${poi.AddressInfo?.Title || ""} ${poi.UsageType?.Title || ""}`.toLowerCase();
  if (title.includes("office") || title.includes("business") || title.includes("tech park")) return "business_district";
  if (title.includes("hotel") || title.includes("resort") || title.includes("mall") || title.includes("tour")) return "destination_leisure";
  if (areaType === "highway") return "commuter_corridor";
  if (areaType === "urban") return "metro_peak";
  return "destination_leisure";
}

function deriveAmenityScore(poi: OpenChargeMapPoi, maxPowerKw: number) {
  const title = `${poi.AddressInfo?.Title || ""} ${poi.UsageType?.Title || ""}`.toLowerCase();
  let score = 0.58;
  if (title.includes("mall") || title.includes("hotel") || title.includes("airport")) score += 0.18;
  if (title.includes("restaurant") || title.includes("cafe")) score += 0.1;
  if (maxPowerKw >= 100) score += 0.06;
  if ((poi.NumberOfPoints || 0) >= 4) score += 0.05;
  return Number(clamp(score, 0.45, 0.97).toFixed(2));
}

function deriveReliabilityScore(poi: OpenChargeMapPoi, totalPorts: number, isOperational: boolean | undefined) {
  const now = Date.now();
  const lastVerified = poi.DateLastVerified ? Date.parse(poi.DateLastVerified) : Number.NaN;
  const lastStatusUpdate = poi.DateLastStatusUpdate ? Date.parse(poi.DateLastStatusUpdate) : Number.NaN;
  const freshest = Math.max(Number.isFinite(lastVerified) ? lastVerified : 0, Number.isFinite(lastStatusUpdate) ? lastStatusUpdate : 0);
  const daysSinceRefresh = freshest ? (now - freshest) / 86_400_000 : 9999;

  let score = 0.58;
  if (isOperational === true) score += 0.18;
  if (isOperational === false) score -= 0.26;
  if (poi.IsRecentlyVerified) score += 0.08;
  if (daysSinceRefresh <= 30) score += 0.1;
  else if (daysSinceRefresh <= 180) score += 0.05;
  else if (daysSinceRefresh > 540) score -= 0.08;
  score += Math.min(0.08, Math.max(0, totalPorts - 1) * 0.02);

  return Number(clamp(score, 0.25, 0.98).toFixed(2));
}

export function getFallbackStations() {
  return fallbackStations as Station[];
}

export function stationSupportsConnector(station: Station, connectorType: string) {
  const supported = station.connectorTypes?.length ? station.connectorTypes : [station.connectorType];
  return supported.some((value) => value.toLowerCase() === connectorType.toLowerCase());
}

export function normalizeOpenChargeMapStation(poi: OpenChargeMapPoi): Station | null {
  const latitude = poi.AddressInfo?.Latitude;
  const longitude = poi.AddressInfo?.Longitude;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;

  const connections = poi.Connections || [];
  const connectorTypes = unique(
    connections
      .map((connection) => normalizeConnectorLabel(connection.ConnectionType?.Title))
      .filter((value): value is string => Boolean(value))
  );
  const primaryConnector = connectorTypes[0] || DEFAULT_CONNECTOR;

  const maxPowerKw = Math.max(
    ...connections.map((connection) => connection.PowerKW || 0),
    primaryConnector === "Type 2" ? 22 : 30
  );
  const totalPorts = Math.max(
    1,
    poi.NumberOfPoints || 0,
    connections.reduce((sum, connection) => sum + (connection.Quantity || 1), 0)
  );
  const isOperational =
    poi.StatusType?.IsOperational ?? (connections.some((connection) => connection.StatusType?.IsOperational === true) || undefined);
  const areaType = inferAreaType(poi);
  const basePricePerKwh = parseUsageCost(poi.UsageCost) ?? (maxPowerKw >= 60 ? 24 : 16);
  const reliabilityScore = deriveReliabilityScore(poi, totalPorts, isOperational);

  return {
    id: `ocm-${poi.ID}`,
    name: poi.AddressInfo?.Title?.trim() || `Open Charge Map Station ${poi.ID}`,
    operator: poi.OperatorInfo?.Title?.trim() || DEFAULT_OPERATOR,
    city: poi.AddressInfo?.Town?.trim() || DEFAULT_CITY,
    state: poi.AddressInfo?.StateOrProvince?.trim() || DEFAULT_STATE,
    coordinates: {
      lat: latitude,
      lng: longitude
    },
    chargerType: detectChargerType(connections, maxPowerKw),
    connectorType: primaryConnector,
    connectorTypes: connectorTypes.length ? connectorTypes : [primaryConnector],
    maxPowerKw: Number(maxPowerKw.toFixed(1)),
    totalPorts,
    basePricePerKwh: Number(basePricePerKwh.toFixed(2)),
    busyFactor: Number(clamp(0.38 + (areaType === "urban" ? 0.22 : areaType === "highway" ? 0.16 : 0.1), 0.25, 0.9).toFixed(2)),
    priceSensitivity: Number(clamp(1 + (maxPowerKw >= 100 ? 0.08 : 0.02), 0.92, 1.14).toFixed(2)),
    demandProfile: inferDemandProfile(areaType, poi),
    areaType,
    reliabilityScore,
    amenityScore: deriveAmenityScore(poi, maxPowerKw),
    liveStatus: poi.StatusType?.Title || null || undefined,
    liveStatusTypeId: poi.StatusType?.ID ?? null,
    statusUpdatedAt: poi.DateLastStatusUpdate || poi.DateLastVerified || null,
    isOperational,
    dataSource: "openchargemap"
  };
}

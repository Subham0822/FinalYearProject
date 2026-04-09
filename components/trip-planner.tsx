"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { locations } from "@/lib/locations";
import type {
  RecommendationMode,
  RecommendationResponse,
  RouteOption,
  ScoreContribution,
  SimulationScenario,
  TripRequest
} from "@/lib/types";

const RouteMap = dynamic(() => import("@/components/route-map").then((module) => module.RouteMap), {
  ssr: false
});

const defaultOrigin = locations[0];
const defaultDestination = locations[7];
const REFRESH_INTERVAL_MS = 30_000;
const THEME_STORAGE_KEY = "voltpath-theme";

const vehiclePresets = [
  { id: "tesla-model-y", name: "Tesla Model Y LR", batteryCapacityKwh: 75, efficiencyKmPerKwh: 6.4, maxChargingPowerKw: 210 },
  { id: "kia-ev6", name: "Kia EV6 GT Line", batteryCapacityKwh: 77.4, efficiencyKmPerKwh: 6.1, maxChargingPowerKw: 235 },
  { id: "hyundai-ioniq-5", name: "Hyundai Ioniq 5", batteryCapacityKwh: 72.6, efficiencyKmPerKwh: 5.9, maxChargingPowerKw: 220 },
  { id: "byd-seal", name: "BYD Seal Premium", batteryCapacityKwh: 82.5, efficiencyKmPerKwh: 6.6, maxChargingPowerKw: 150 }
] as const;

const modeOptions: Array<{ value: RecommendationMode; label: string }> = [
  { value: "balanced", label: "Balanced AI" },
  { value: "fastest", label: "Fastest" },
  { value: "cheapest", label: "Cheapest" }
];

const simulationOptions: Array<{ value: SimulationScenario; label: string }> = [
  { value: "peak_traffic", label: "Peak traffic" },
  { value: "high_station_demand", label: "High demand at stations" },
  { value: "price_surge", label: "Price surge" }
];

type LiveAlert = {
  message: string;
  nextRouteId: string;
  timeGainMinutes: number;
  costGain: number;
};

type ThemeMode = "dark" | "light";
type ThemePreference = ThemeMode | "system";

function nowLocalIso() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function formatMinutes(totalMinutes: number) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round(totalMinutes % 60);
  if (hours <= 0) return `${minutes} min`;
  return `${hours}h ${minutes}m`;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
    style: "currency",
    currency: "INR"
  }).format(value);
}

function formatTimestamp(value?: string) {
  if (!value) return "Waiting";
  return new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function routeBadge(route: RouteOption) {
  if (route.routeCategory === "recommended") return "AI Recommended";
  if (route.routeCategory === "fastest") return "Fastest";
  if (route.routeCategory === "cheapest") return "Cheapest";
  return route.routeVariant === "direct" ? "Direct" : route.routeVariant === "one-stop" ? "One stop" : "Multi stop";
}

function demandTone(level?: string) {
  if (level === "high") return "demand-high";
  if (level === "moderate") return "demand-moderate";
  return "demand-low";
}

function buildBetterRouteAlert(current: RecommendationResponse, next: RecommendationResponse): LiveAlert | null {
  if (!current.bestRoute || !next.bestRoute) return null;
  const timeGainMinutes = current.bestRoute.totalTravelMinutes - next.bestRoute.totalTravelMinutes;
  const costGain = current.bestRoute.totalChargingCost - next.bestRoute.totalChargingCost;
  const scoreGain = (next.bestRoute.weightedScore ?? next.bestRoute.score) - (current.bestRoute.weightedScore ?? current.bestRoute.score);
  const availabilityGain = (next.bestRoute.availabilityProbability ?? 0) - (current.bestRoute.availabilityProbability ?? 0);
  const significantlyBetter =
    current.bestRoute.id !== next.bestRoute.id && (timeGainMinutes >= 8 || costGain >= 120 || scoreGain >= 4 || availabilityGain >= 0.08);

  if (!significantlyBetter) return null;

  return {
    message: `Better route found: ${next.bestRoute.label}`,
    nextRouteId: next.bestRoute.id,
    timeGainMinutes: Math.max(0, timeGainMinutes),
    costGain: Math.max(0, costGain)
  };
}

function scoreBarWidth(contribution?: ScoreContribution) {
  return `${Math.max(10, Math.round((contribution?.normalizedMagnitude ?? 0) * 100))}%`;
}

function routeMetric(route: RouteOption, type: "eta" | "cost" | "stops" | "soc") {
  if (type === "eta") return formatMinutes(route.totalTravelMinutes);
  if (type === "cost") return formatCurrency(route.totalChargingCost);
  if (type === "stops") return `${route.stops.length}`;
  return `${route.finalSoc}%`;
}

function icon(name: "moon" | "sun" | "time" | "cost" | "stops" | "battery" | "speed" | "wait" | "confidence" | "availability") {
  const paths = {
    moon: "M12 3a7 7 0 1 0 9 9a8 8 0 1 1-9-9Z",
    sun: "M12 4V2m0 20v-2m8-8h2M2 12h2m12.95 4.95 1.41 1.41M4.64 4.64l1.41 1.41m11.9 0 1.41-1.41M4.64 19.36l1.41-1.41M12 7a5 5 0 1 0 0 10a5 5 0 0 0 0-10Z",
    time: "M12 7v5l3 3m6-3a9 9 0 1 1-18 0a9 9 0 0 1 18 0Z",
    cost: "M12 3v18m4-13.5a4 4 0 0 0-4-1.5a4 4 0 0 0 0 8a4 4 0 0 1 0 8a4 4 0 0 1-4-1.5",
    stops: "M6 6h12M6 12h12M6 18h12",
    battery: "M16 7V5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v2m-3 0H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z",
    speed: "M4 16a8 8 0 1 1 16 0M12 12l4-4",
    wait: "M12 8v4l2 2M5 3l2 2m10-2-2 2",
    confidence: "M12 3l7 3v6c0 4.5-3 7.5-7 9c-4-1.5-7-4.5-7-9V6l7-3Z",
    availability: "M5 12l4 4L19 6"
  } as const;

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="ui-icon">
      <path d={paths[name]} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  );
}

export function TripPlanner() {
  const [originId, setOriginId] = useState(defaultOrigin.id);
  const [destinationId, setDestinationId] = useState(defaultDestination.id);
  const [departureTime, setDepartureTime] = useState(nowLocalIso());
  const [startingSoc, setStartingSoc] = useState(68);
  const [vehicleId, setVehicleId] = useState<string>(vehiclePresets[0].id);
  const [mode, setMode] = useState<RecommendationMode>("balanced");
  const [response, setResponse] = useState<RecommendationResponse | null>(null);
  const [baselineComparison, setBaselineComparison] = useState<RecommendationResponse | null>(null);
  const [scenarioComparison, setScenarioComparison] = useState<RecommendationResponse | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [autoRerouteEnabled, setAutoRerouteEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveAlert, setLiveAlert] = useState<LiveAlert | null>(null);
  const [activeTripRequest, setActiveTripRequest] = useState<Omit<TripRequest, "liveContext"> | null>(null);
  const [simulationMode, setSimulationMode] = useState(false);
  const [simulationScenario, setSimulationScenario] = useState<SimulationScenario>("peak_traffic");
  const [themePreference, setThemePreference] = useState<ThemePreference>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ThemeMode>("dark");
  const loggedDefaultSelection = useRef<string | null>(null);

  const origin = useMemo(() => locations.find((location) => location.id === originId) ?? defaultOrigin, [originId]);
  const destination = useMemo(() => locations.find((location) => location.id === destinationId) ?? defaultDestination, [destinationId]);
  const vehicle = useMemo(() => vehiclePresets.find((entry) => entry.id === vehicleId) ?? vehiclePresets[0], [vehicleId]);
  const routeOptions = useMemo(() => (response?.bestRoute ? [response.bestRoute, ...response.alternatives] : []), [response]);
  const selectedRoute = useMemo(
    () => routeOptions.find((route) => route.id === selectedRouteId) ?? routeOptions[0] ?? null,
    [routeOptions, selectedRouteId]
  );
  const routeRangeKm = Math.round(vehicle.batteryCapacityKwh * vehicle.efficiencyKmPerKwh);
  const fallbackPoints = useMemo(() => [origin, destination], [origin, destination]);
  const whatIfAnalysis = useMemo(() => {
    if (!baselineComparison?.bestRoute || !scenarioComparison?.bestRoute) return null;
    const baseline = baselineComparison.bestRoute;
    const simulated = scenarioComparison.bestRoute;
    return {
      baseline,
      simulated,
      routeChanged: baseline.id !== simulated.id,
      timeDelta: simulated.totalTravelMinutes - baseline.totalTravelMinutes,
      costDelta: simulated.totalChargingCost - baseline.totalChargingCost,
      waitDelta: simulated.totalWaitMinutes - baseline.totalWaitMinutes
    };
  }, [baselineComparison, scenarioComparison]);

  const comparisonRoutes = useMemo(() => {
    const orderedCandidates = [
      routeOptions.find((route) => route.routeCategory === "recommended"),
      routeOptions.find((route) => route.routeCategory === "fastest"),
      routeOptions.find((route) => route.routeCategory === "cheapest"),
      ...routeOptions
    ].filter((route): route is RouteOption => Boolean(route));

    const uniqueRoutes: RouteOption[] = [];
    for (const route of orderedCandidates) {
      if (!uniqueRoutes.some((candidate) => candidate.id === route.id)) {
        uniqueRoutes.push(route);
      }
      if (uniqueRoutes.length === 3) break;
    }

    return uniqueRoutes;
  }, [routeOptions]);

  useEffect(() => {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY) as ThemePreference | null;
    const nextPreference = saved === "dark" || saved === "light" || saved === "system" ? saved : "system";
    setThemePreference(nextPreference);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const applyTheme = () => {
      const nextTheme = themePreference === "system" ? (media.matches ? "light" : "dark") : themePreference;
      setResolvedTheme(nextTheme);
      document.documentElement.dataset.theme = nextTheme;
      document.documentElement.style.colorScheme = nextTheme;
    };

    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themePreference]);

  function cycleTheme() {
    const next = themePreference === "system" ? "light" : themePreference === "light" ? "dark" : "system";
    setThemePreference(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  }

  async function persistSelection(routeId: string, selectionSource: "recommended-default" | "user-manual") {
    if (!response?.recommendationId) return;
    try {
      await fetch("/api/feedback/selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recommendationId: response.recommendationId,
          routeId,
          selectionSource
        })
      });
    } catch {}
  }

  useEffect(() => {
    if (!response?.recommendationId || !response.bestRoute) return;
    const key = `${response.recommendationId}:${response.bestRoute.id}`;
    if (loggedDefaultSelection.current === key) return;
    loggedDefaultSelection.current = key;
    void persistSelection(response.bestRoute.id, "recommended-default");
  }, [response?.recommendationId, response?.bestRoute?.id]);

  function buildBaseRequest(): Omit<TripRequest, "liveContext"> {
    return {
      origin: { lat: origin.lat, lng: origin.lng, label: origin.label },
      destination: { lat: destination.lat, lng: destination.lng, label: destination.label },
      departureTime: new Date(departureTime).toISOString(),
      startingSoc,
      reserveSoc: 12,
      safetyBufferSoc: 18,
      mode,
      simulationScenario: simulationMode ? simulationScenario : "baseline",
      vehicle: {
        batteryCapacityKwh: vehicle.batteryCapacityKwh,
        efficiencyKmPerKwh: vehicle.efficiencyKmPerKwh,
        maxChargingPowerKw: vehicle.maxChargingPowerKw,
        connectorType: "CCS2"
      }
    };
  }

  const requestRecommendation = async (baseRequest: Omit<TripRequest, "liveContext">, source: "manual" | "refresh") => {
    const payload: TripRequest = {
      ...baseRequest,
      liveContext: { refreshToken: new Date().toISOString() }
    };

    if (source === "manual") {
      setLoading(true);
      setLiveAlert(null);
    } else {
      setRefreshing(true);
    }

    try {
      const recommendationResponse = await fetch("/api/route/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = (await recommendationResponse.json()) as RecommendationResponse & { error?: string };
      if (!recommendationResponse.ok) throw new Error(data.error || "Unable to generate a route recommendation");

      setResponse((current) => {
        if (source === "refresh" && current) {
          const alert = buildBetterRouteAlert(current, data);
          setLiveAlert(alert);
          if (alert && autoRerouteEnabled) {
            setSelectedRouteId(data.bestRoute?.id ?? null);
          } else {
            setSelectedRouteId((currentSelection) => {
              if (!currentSelection) return data.bestRoute?.id ?? null;
              return [data.bestRoute, ...data.alternatives].some((route) => route?.id === currentSelection)
                ? currentSelection
                : data.bestRoute?.id ?? null;
            });
          }
        } else {
          setSelectedRouteId(data.bestRoute?.id ?? null);
          setLiveAlert(null);
        }
        return data;
      });

      setActiveTripRequest(baseRequest);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Something went wrong");
      if (source === "manual") setResponse(null);
    } finally {
      if (source === "manual") setLoading(false);
      else setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!autoRefreshEnabled || !activeTripRequest || !response?.bestRoute) return undefined;
    const interval = window.setInterval(() => {
      void requestRecommendation(activeTripRequest, "refresh");
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [activeTripRequest, autoRefreshEnabled, response?.bestRoute]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scenarioRequest = buildBaseRequest();
    if (!simulationMode) {
      setBaselineComparison(null);
      setScenarioComparison(null);
      await requestRecommendation(scenarioRequest, "manual");
      return;
    }

    setLoading(true);
    setLiveAlert(null);
    try {
      const refreshToken = new Date().toISOString();
      const baselinePayload: TripRequest = {
        ...scenarioRequest,
        simulationScenario: "baseline",
        liveContext: { refreshToken }
      };
      const simulatedPayload: TripRequest = {
        ...scenarioRequest,
        liveContext: { refreshToken }
      };

      const [baselineRes, simulatedRes] = await Promise.all([
        fetch("/api/route/recommend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(baselinePayload)
        }),
        fetch("/api/route/recommend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(simulatedPayload)
        })
      ]);

      const baselineData = (await baselineRes.json()) as RecommendationResponse & { error?: string };
      const simulatedData = (await simulatedRes.json()) as RecommendationResponse & { error?: string };
      if (!baselineRes.ok) throw new Error(baselineData.error || "Unable to generate the baseline route");
      if (!simulatedRes.ok) throw new Error(simulatedData.error || "Unable to generate the simulated route");

      setBaselineComparison(baselineData);
      setScenarioComparison(simulatedData);
      setResponse(simulatedData);
      setSelectedRouteId(simulatedData.bestRoute?.id ?? null);
      setActiveTripRequest(scenarioRequest);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Something went wrong");
      setResponse(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleRouteSelect(routeId: string) {
    setSelectedRouteId(routeId);
    await persistSelection(routeId, "user-manual");
  }

  return (
    <main className="planner-shell">
      <section className="hero panel">
        <div className="hero-topbar">
          <div className="brand-lockup">
            <p className="eyebrow">VoltPath Command</p>
          </div>
          <button className="theme-toggle" type="button" onClick={cycleTheme} aria-label="Toggle theme">
            {resolvedTheme === "dark" ? icon("sun") : icon("moon")}
          </button>
        </div>
        <div className="hero-title-block">
          <h1>Real-time adaptive EV routing</h1>
          <p className="muted">
            Real road geometry, adaptive charger intelligence, Pareto-ranked routes, and explainable AI now stay in the same premium control surface.
          </p>
        </div>
        <div className="hero-metrics">
          <article className="metric-card">
            <span>Live traffic</span>
            <strong>{response?.liveSnapshot?.trafficLevel || "idle"}</strong>
            <small>{response?.liveSnapshot ? `${response.liveSnapshot.trafficMultiplier}x corridor load` : "Run a route scan"}</small>
          </article>
          <article className="metric-card">
            <span>Station availability</span>
            <strong>{response?.liveSnapshot ? `${Math.round(response.liveSnapshot.averageAvailabilityRatio * 100)}%` : "--"}</strong>
            <small>{response?.liveSnapshot ? `${response.liveSnapshot.monitoredStations} monitored chargers` : "No active route"}</small>
          </article>
          <article className="metric-card">
            <span>Last refresh</span>
            <strong>{formatTimestamp(response?.liveSnapshot?.refreshedAt)}</strong>
            <small>{refreshing ? "Refreshing now" : autoRefreshEnabled ? "Live monitoring every 30s" : "Manual refresh only"}</small>
          </article>
        </div>
      </section>

      <section className="workspace">
        <form className="panel form-panel" onSubmit={handleSubmit}>
          <div className="section-head">
            <div>
              <p className="eyebrow">Trip setup</p>
              <h2>Plan the next route</h2>
            </div>
          </div>

          <div className="form-stack">
            <section className="form-section">
              <div className="subsection-head">
                <span className="subsection-label">Trip Inputs</span>
              </div>
              <div className="form-grid">
                <label className="field">
                  <span>Source</span>
                  <select value={originId} onChange={(event) => setOriginId(event.target.value)}>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.label}, {location.state}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Destination</span>
                  <select value={destinationId} onChange={(event) => setDestinationId(event.target.value)}>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.label}, {location.state}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Departure</span>
                  <input type="datetime-local" value={departureTime} onChange={(event) => setDepartureTime(event.target.value)} />
                </label>
                <label className="field">
                  <span>Vehicle</span>
                  <select value={vehicleId} onChange={(event) => setVehicleId(event.target.value as (typeof vehiclePresets)[number]["id"])}>
                    {vehiclePresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="soc-row">
                <label className="field field-range">
                  <span>Battery at departure</span>
                  <input type="range" min="10" max="100" value={startingSoc} onChange={(event) => setStartingSoc(Number(event.target.value))} />
                </label>
                <div className="soc-chip">{startingSoc}% SOC</div>
                <div className="soc-chip">{routeRangeKm} km full range</div>
              </div>
            </section>

            <section className="form-section">
              <div className="subsection-head">
                <span className="subsection-label">Mode Selection</span>
              </div>
              <div className="mode-switcher mode-grid">
                {modeOptions.map((option) => (
                  <button
                    key={option.value}
                    className={`pill-button${mode === option.value ? " pill-button-active" : ""}`}
                    type="button"
                    onClick={() => setMode(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="simulation-block">
                <button className={`toggle-card${simulationMode ? " toggle-card-active" : ""}`} type="button" onClick={() => setSimulationMode((value) => !value)}>
                  <strong>{simulationMode ? "Stress mode" : "Normal mode"}</strong>
                  <span>Compare baseline routing against stressed traffic, demand, or price conditions.</span>
                </button>
                {simulationMode ? (
                  <div className="simulation-strip">
                    {simulationOptions.map((option) => (
                      <button
                        key={option.value}
                        className={`pill-button${simulationScenario === option.value ? " pill-button-active" : ""}`}
                        type="button"
                        onClick={() => setSimulationScenario(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="form-section">
              <div className="subsection-head">
                <span className="subsection-label">Live Controls</span>
              </div>
              <div className="live-controls">
                <button className={`toggle-card${autoRefreshEnabled ? " toggle-card-active" : ""}`} type="button" onClick={() => setAutoRefreshEnabled((value) => !value)}>
                  <strong>Live Monitoring {autoRefreshEnabled ? "ON" : "OFF"}</strong>
                  <span>Poll traffic, charger availability, and pricing every 30 seconds.</span>
                </button>
                <button className={`toggle-card${autoRerouteEnabled ? " toggle-card-active" : ""}`} type="button" onClick={() => setAutoRerouteEnabled((value) => !value)}>
                  <strong>Auto re-route {autoRerouteEnabled ? "ON" : "OFF"}</strong>
                  <span>Switch immediately when a stronger route appears under live conditions.</span>
                </button>
              </div>
            </section>
          </div>

          <div className="form-actions">
            <button className="primary-button" type="submit" disabled={loading || originId === destinationId}>
              {loading ? "AI analyzing routes..." : "Find smart route"}
            </button>
            {activeTripRequest ? (
              <button className="secondary-button" type="button" disabled={refreshing} onClick={() => void requestRecommendation(activeTripRequest, "refresh")}>
                {refreshing ? "Refreshing..." : "Refresh now"}
              </button>
            ) : null}
          </div>

          {(loading || refreshing) && !error ? (
            <div className="analysis-banner">
              <strong>AI analyzing routes...</strong>
              <span>Checking OSRM geometry, live charger pressure, battery reachability, and Pareto trade-offs.</span>
            </div>
          ) : null}

          {originId === destinationId ? <p className="error-text">Source and destination must be different.</p> : null}
          {error ? <p className="error-text">{error}</p> : null}
        </form>

        <section className="panel route-panel">
          {liveAlert ? (
            <div className="live-banner">
              <div>
                <strong>{liveAlert.message}</strong>
                <p>
                  Saves {liveAlert.timeGainMinutes > 0 ? `${liveAlert.timeGainMinutes} min` : "time"} and{" "}
                  {liveAlert.costGain > 0 ? formatCurrency(liveAlert.costGain) : "keeps cost stable"} under the latest live conditions.
                </p>
              </div>
              {!autoRerouteEnabled ? (
                <button className="primary-button" type="button" onClick={() => void handleRouteSelect(liveAlert.nextRouteId)}>
                  Switch route
                </button>
              ) : null}
            </div>
          ) : null}

          {selectedRoute ? (
            <>
              <div className="route-stage">
                <div className="map-stage">
                  <div className="section-head">
                    <div>
                      <p className="eyebrow">Live map</p>
                      <h2>{selectedRoute.label}</h2>
                    </div>
                    <div className="map-head-meta">
                      <span className="score-chip">Score {selectedRoute.weightedScore ?? selectedRoute.score}</span>
                      <span className="live-pill">{autoRefreshEnabled ? "Live Monitoring ON" : "Monitoring paused"}</span>
                    </div>
                  </div>

                  <RouteMap
                    fallbackPoints={fallbackPoints}
                    onRouteSelect={(routeId) => void handleRouteSelect(routeId)}
                    routes={routeOptions}
                    selectedRouteId={selectedRoute.id}
                    theme={resolvedTheme}
                  />

                  <div className="route-legend">
                    <span><i className="legend-swatch legend-recommended" />AI Recommended</span>
                    <span><i className="legend-swatch legend-fastest" />Fastest</span>
                    <span><i className="legend-swatch legend-cheapest" />Cheapest</span>
                  </div>

                  <div className={`route-cards comparison-grid${comparisonRoutes.length === 1 ? " comparison-grid-single" : ""}`}>
                    {comparisonRoutes.map((route) => (
                      <button
                        key={`${route.routeCategory ?? route.id}-${route.id}`}
                        className={`route-card ${route.routeCategory === "recommended" ? "route-card-emphasis" : ""}${selectedRoute.id === route.id ? " route-card-active" : ""}`}
                        type="button"
                        onClick={() => void handleRouteSelect(route.id)}
                      >
                        <div className="route-card-head">
                          <strong>{routeBadge(route)}</strong>
                          <span>{route.routeVariant === "multi-stop" ? "Multi stop" : route.routeVariant === "one-stop" ? "One stop" : "Direct"}</span>
                        </div>
                        <div className="route-card-metrics">
                          <span>{icon("time")} {routeMetric(route, "eta")}</span>
                          <span>{icon("cost")} {routeMetric(route, "cost")}</span>
                          <span>{icon("stops")} {routeMetric(route, "stops")} stops</span>
                          <span>{icon("battery")} {routeMetric(route, "soc")} final SOC</span>
                        </div>
                        <p>{route.explanation.summary}</p>
                      </button>
                    ))}
                  </div>

                  <div className="trip-timeline">
                    <div className="subsection-head">
                      <span className="subsection-label">Trip timeline</span>
                    </div>
                    <div className="timeline-track">
                      <article className="timeline-step">
                        <strong>Drive</strong>
                        <span>{formatMinutes(selectedRoute.totalDriveMinutes)}</span>
                      </article>
                      <article className="timeline-step">
                        <strong>Charging</strong>
                        <span>{formatMinutes(selectedRoute.totalChargingMinutes)}</span>
                      </article>
                      <article className="timeline-step">
                        <strong>Wait</strong>
                        <span>{formatMinutes(selectedRoute.totalWaitMinutes)}</span>
                      </article>
                      <article className="timeline-step timeline-step-total">
                        <strong>Total journey</strong>
                        <span>{formatMinutes(selectedRoute.totalTravelMinutes)}</span>
                      </article>
                    </div>
                  </div>
                </div>

                <aside className="insights-panel">
                  <div className="insight-card">
                    <p className="eyebrow">Selected route</p>
                    <h3>{routeBadge(selectedRoute)}</h3>
                    <div className="stats-grid compact-grid">
                      <article className="metric-card"><span>ETA</span><strong>{formatMinutes(selectedRoute.totalTravelMinutes)}</strong></article>
                      <article className="metric-card"><span>Total cost</span><strong>{formatCurrency(selectedRoute.totalChargingCost)}</strong></article>
                      <article className="metric-card"><span>Stops</span><strong>{selectedRoute.stops.length}</strong></article>
                      <article className="metric-card"><span>Final SOC</span><strong>{selectedRoute.finalSoc}%</strong></article>
                    </div>
                    <div className="warning-strip">
                      {(selectedRoute.warnings?.length ? selectedRoute.warnings : ["Buffered route"]).map((warning) => (
                        <span key={warning} className={`warning-chip${warning === "Buffered route" ? " warning-chip-safe" : ""}`}>{warning}</span>
                      ))}
                    </div>
                  </div>

                  <div className="insight-card">
                    <p className="eyebrow">Why this route?</p>
                    <h3>Explainable AI</h3>
                    <p className="insight-copy">{selectedRoute.explanation.whyChosen || selectedRoute.explanation.summary}</p>
                    <div className="contribution-list">
                      {[
                        { iconName: "time" as const, tag: "Better on time", contribution: selectedRoute.explanation.scoreBreakdown?.timeContribution },
                        { iconName: "cost" as const, tag: "Better on cost", contribution: selectedRoute.explanation.scoreBreakdown?.costContribution },
                        { iconName: "availability" as const, tag: "Better charger odds", contribution: selectedRoute.explanation.scoreBreakdown?.availabilityContribution },
                        { iconName: "stops" as const, tag: "Lower detour pressure", contribution: selectedRoute.explanation.scoreBreakdown?.detourContribution },
                        { iconName: "battery" as const, tag: "Stronger energy buffer", contribution: selectedRoute.explanation.scoreBreakdown?.energyContribution }
                      ]
                        .filter((entry) => entry.contribution)
                        .map((entry) => (
                          <div className="contribution-row" key={entry.contribution!.label}>
                            <div className="contribution-head">
                              <span>{icon(entry.iconName)} {entry.contribution!.label}</span>
                              <strong>{entry.contribution!.displayValue}</strong>
                            </div>
                            <div className="contribution-track">
                              <div
                                className={`contribution-bar${entry.contribution!.impact === "boost" ? " contribution-boost" : ""}`}
                                style={{ width: scoreBarWidth(entry.contribution!) }}
                              />
                            </div>
                            <small className="metric-hint">{entry.tag}</small>
                          </div>
                        ))}
                    </div>
                    <div className="comparison-notes">
                      {(selectedRoute.explanation.rejectedRouteComparisons ?? []).slice(0, 2).map((comparison) => (
                        <article className="comparison-note" key={comparison.routeId}>
                          <strong>{comparison.routeLabel}</strong>
                          <span>{comparison.verdict}</span>
                        </article>
                      ))}
                    </div>
                  </div>

                  <div className="insight-card">
                    <p className="eyebrow">Battery model</p>
                    <h3>SOC timeline</h3>
                    <div className="soc-timeline">
                      {(selectedRoute.segments ?? []).map((segment) => (
                        <div className="soc-step" key={segment.label}>
                          <div className="soc-step-head">
                            <strong>{segment.to}</strong>
                            <span>{segment.socEnd}%</span>
                          </div>
                          <div className="soc-track">
                            <div className="soc-fill" style={{ width: `${Math.max(6, Math.min(100, segment.socEnd))}%` }} />
                          </div>
                          <small>
                            {segment.distanceKm} km • {segment.totalEnergyKwh} kWh • {segment.stopGoEvents} stop/start events
                          </small>
                        </div>
                      ))}
                    </div>
                  </div>
                </aside>
              </div>

              {whatIfAnalysis ? (
                <div className="whatif-panel">
                  <div className="section-head">
                    <div>
                      <p className="eyebrow">Scenario simulation</p>
                      <h2>{simulationOptions.find((option) => option.value === simulationScenario)?.label}</h2>
                    </div>
                  </div>
                  <div className="whatif-grid">
                    <article className="metric-card">
                      <span>Normal mode</span>
                      <strong>{whatIfAnalysis.baseline.label}</strong>
                      <small>{formatMinutes(whatIfAnalysis.baseline.totalTravelMinutes)} • {formatCurrency(whatIfAnalysis.baseline.totalChargingCost)}</small>
                    </article>
                    <article className="metric-card">
                      <span>Stress mode</span>
                      <strong>{whatIfAnalysis.simulated.label}</strong>
                      <small>{formatMinutes(whatIfAnalysis.simulated.totalTravelMinutes)} • {formatCurrency(whatIfAnalysis.simulated.totalChargingCost)}</small>
                    </article>
                    <article className="metric-card">
                      <span>Route change</span>
                      <strong>{whatIfAnalysis.routeChanged ? "Changed" : "Stable"}</strong>
                      <small>{whatIfAnalysis.routeChanged ? "The optimal path changed under stress." : "The same path remained best."}</small>
                    </article>
                    <article className="metric-card">
                      <span>Travel delta</span>
                      <strong>{whatIfAnalysis.timeDelta >= 0 ? "+" : "-"}{formatMinutes(Math.abs(whatIfAnalysis.timeDelta))}</strong>
                      <small>Relative to normal mode</small>
                    </article>
                  </div>
                </div>
              ) : null}

              <div className="details-grid">
                <div className="station-list">
                  <div className="section-head">
                    <div>
                      <p className="eyebrow">Charging plan</p>
                      <h2>{selectedRoute.stops.length ? `${selectedRoute.stops.length} planned stops` : "Direct route available"}</h2>
                    </div>
                  </div>
                  {selectedRoute.stops.length ? (
                    selectedRoute.stops.map((stop, index) => (
                      <article className="station-card" key={stop.station.id}>
                        <div className="station-card-head">
                          <strong>Stop {index + 1}: {stop.station.name}</strong>
                          <div className="badge-row">
                            <span className={`demand-pill ${demandTone(stop.forecast.demandLevel)}`}>{stop.forecast.demandLevel} demand</span>
                            <span className="demand-pill demand-safe">High confidence</span>
                          </div>
                        </div>
                        <div className="station-card-grid station-card-grid-rich">
                          <span>{stop.station.city}, {stop.station.state}</span>
                          <span>{icon("cost")} {formatCurrency(stop.forecast.predictedPricePerKwh)}/kWh</span>
                          <span>{icon("speed")} {stop.station.maxPowerKw} kW</span>
                          <span>{icon("wait")} Wait {formatMinutes(stop.waitMinutes)}</span>
                          <span>Charge {formatMinutes(stop.chargingMinutes)} • {stop.chargedEnergyKwh} kWh</span>
                          <span>SOC {stop.arrivalSoc}% to {stop.departureSoc}%</span>
                          <span>{icon("confidence")} {Math.round((stop.forecast.forecastConfidence ?? stop.forecast.confidence) * 100)}% confidence</span>
                          <span>{icon("availability")} {Math.round(stop.forecast.availabilityRatio * 100)}% availability</span>
                          <span>Demand Index {stop.forecast.demandIndex}</span>
                          <span>{stop.forecast.peakHour ? "Peak hour" : "Off peak"}</span>
                          <span>{Math.round((stop.station.operatorTrustScore ?? stop.station.reliabilityScore) * 100)}% operator trust</span>
                        </div>
                      </article>
                    ))
                  ) : (
                    <article className="station-card">
                      <div className="station-card-head">
                        <strong>No charging stop needed</strong>
                        <span>Battery reserve stays protected on the direct corridor.</span>
                      </div>
                    </article>
                  )}
                </div>

                <div className="insight-card full-height">
                  <p className="eyebrow">Segment realism</p>
                  <h3>Turn-by-turn and energy breakdown</h3>
                  <div className="segment-list">
                    {(selectedRoute.segments ?? []).map((segment) => (
                      <article className="segment-card" key={segment.label}>
                        <div className="segment-head">
                          <strong>{segment.label}</strong>
                          <span>{formatMinutes(segment.durationMinutes)}</span>
                        </div>
                        <div className="segment-meta">
                          <span>{segment.distanceKm} km</span>
                          <span>{segment.averageSpeedKph} km/h</span>
                          <span>{segment.totalEnergyKwh} kWh</span>
                          <span>SOC {segment.socStart}% to {segment.socEnd}%</span>
                        </div>
                        <div className="step-list">
                          {(segment.routeSteps ?? []).slice(0, 3).map((step, index) => (
                            <div className="step-row" key={`${segment.label}-${index}`}>
                              <strong>{step.instruction}</strong>
                              <span>{step.distanceKm} km • {formatMinutes(step.durationMinutes)}</span>
                            </div>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <strong>Run a route scan to start live monitoring.</strong>
              <p>The planner begins periodic refreshes, compares Pareto-optimal alternatives, and watches for better route opportunities once a trip is active.</p>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

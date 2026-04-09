"use client";

import { useEffect, useMemo, useState } from "react";
import { CircleMarker, MapContainer, Pane, Popup, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import type { Coordinates, RouteOption } from "@/lib/types";

type RouteMapProps = {
  fallbackPoints: Coordinates[];
  onRouteSelect: (routeId: string) => void;
  routes: RouteOption[];
  selectedRouteId: string | null;
  theme: "dark" | "light";
};

const routePalette = {
  recommended: "#7af6ff",
  fastest: "#8bffb4",
  cheapest: "#9d7bff",
  default: "#60a5fa"
} as const;

function centerOf(points: Coordinates[]) {
  if (points.length === 0) return { lat: 22.9734, lng: 78.6569 };
  const lat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const lng = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
  return { lat, lng };
}

function FitToRoutes({ points }: { points: Coordinates[] }) {
  const map = useMap();

  useEffect(() => {
    if (points.length >= 2) {
      const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lng] as [number, number]));
      map.fitBounds(bounds.pad(0.24));
    }
  }, [map, points]);

  return null;
}

export function RouteMap({ fallbackPoints, onRouteSelect, routes, selectedRouteId, theme }: RouteMapProps) {
  const selectedRoute = routes.find((route) => route.id === selectedRouteId) ?? routes[0] ?? null;
  const mapPoints = selectedRoute?.geometry ?? fallbackPoints;
  const center = centerOf(mapPoints);
  const [hoveredRouteId, setHoveredRouteId] = useState<string | null>(null);

  const stationMarkers = useMemo(() => {
    const deduped = new Map<
      string,
      {
        id: string;
        stationName: string;
        coordinates: Coordinates;
        maxPowerKw: number;
        totalPorts: number;
        availablePorts: number;
        predictedPricePerKwh: number;
        predictedWaitMinutes: number;
        availabilityRatio: number;
        demandIndex: number;
        demandLevel?: string;
        forecastConfidence?: number;
        peakHour: boolean;
        liveStatus?: string;
        connectorTypes?: string[];
        routeLabel: string;
      }
    >();

    for (const route of routes) {
      for (const stop of route.stops) {
        if (!deduped.has(stop.station.id) || route.id === selectedRoute?.id) {
          deduped.set(stop.station.id, {
            id: stop.station.id,
            stationName: stop.station.name,
            coordinates: stop.station.coordinates,
            maxPowerKw: stop.station.maxPowerKw,
            totalPorts: stop.station.totalPorts,
            availablePorts: stop.forecast.availablePorts,
            predictedPricePerKwh: stop.forecast.predictedPricePerKwh,
            predictedWaitMinutes: stop.forecast.predictedWaitMinutes,
            availabilityRatio: stop.forecast.availabilityRatio,
            demandIndex: stop.forecast.demandIndex,
            demandLevel: stop.forecast.demandLevel,
            forecastConfidence: stop.forecast.forecastConfidence ?? stop.forecast.confidence,
            peakHour: stop.forecast.peakHour ?? false,
            liveStatus: stop.station.liveStatus ?? undefined,
            connectorTypes: stop.station.connectorTypes,
            routeLabel: route.label
          });
        }
      }
    }

    return Array.from(deduped.values());
  }, [routes, selectedRoute]);

  const pointsForBounds = selectedRoute?.geometry ?? fallbackPoints;

  return (
    <div className="map-container">
      <MapContainer center={[center.lat, center.lng]} zoom={6} scrollWheelZoom className="map-container">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; CARTO'
          url={
            theme === "light"
              ? "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
              : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          }
        />
        <FitToRoutes points={pointsForBounds} />

        <Pane name="routes" style={{ zIndex: 400 }}>
          {routes.map((route, index) => {
            const selected = route.id === selectedRoute?.id;
            const hovered = route.id === hoveredRouteId;
            const color =
              route.routeCategory === "recommended"
                ? routePalette.recommended
                : route.routeCategory === "fastest"
                  ? routePalette.fastest
                  : route.routeCategory === "cheapest"
                    ? routePalette.cheapest
                    : [routePalette.default, routePalette.fastest, routePalette.cheapest][index % 3];

            return (
              <Polyline
                key={route.id}
                eventHandlers={{
                  click: () => onRouteSelect(route.id),
                  mouseover: () => setHoveredRouteId(route.id),
                  mouseout: () => setHoveredRouteId((current) => (current === route.id ? null : current))
                }}
                pathOptions={{
                  className: `route-line ${selected ? "route-line-selected" : ""} ${hovered ? "route-line-hovered" : ""}`,
                  color,
                  lineCap: "round",
                  lineJoin: "round",
                  opacity: selected ? 0.96 : hovered ? 0.82 : 0.4,
                  weight: selected ? 8 : hovered ? 6 : 4.2
                }}
                positions={route.geometry.map((point) => [point.lat, point.lng])}
              />
            );
          })}
        </Pane>

        {mapPoints.map((point, index) => {
          const isOrigin = index === 0;
          const isDestination = index === mapPoints.length - 1;
          const color = isOrigin ? "#7af6ff" : isDestination ? "#9d7bff" : "#8bffb4";
          const label = isOrigin ? "Source" : isDestination ? "Destination" : "Waypoint";

          return (
            <CircleMarker
              key={`${point.lat}-${point.lng}-${index}`}
              center={[point.lat, point.lng]}
              pathOptions={{ color, fillColor: color, fillOpacity: 1, opacity: 1 }}
              radius={isOrigin || isDestination ? 8 : 5}
            >
              <Popup>
                <strong>{label}</strong>
              </Popup>
            </CircleMarker>
          );
        })}

        {stationMarkers.map((station) => {
          const isAvailable = station.availabilityRatio >= 0.6;
          const isLimited = station.availabilityRatio >= 0.3 && station.availabilityRatio < 0.6;
          const color = isAvailable ? "#5ef2a4" : isLimited ? "#ffd166" : "#ff6b7a";

          return (
            <CircleMarker
              key={station.id}
              center={[station.coordinates.lat, station.coordinates.lng]}
              pathOptions={{ color, fillColor: color, fillOpacity: 0.92, opacity: 1 }}
              radius={7}
            >
              <Tooltip direction="top" offset={[0, -8]} opacity={1} className="station-tooltip">
                <div className="station-tooltip-card">
                  <strong>{station.stationName}</strong>
                  <span>
                    {station.availablePorts}/{station.totalPorts} ports • Rs. {Math.round(station.predictedPricePerKwh)} • {station.predictedWaitMinutes} min
                  </span>
                </div>
              </Tooltip>
              <Popup>
                <div className="map-popup">
                  <span className="map-popup-tag">{station.routeLabel}</span>
                  <h4>{station.stationName}</h4>
                  <div className="map-popup-grid">
                    <div>
                      <span>Availability</span>
                      <strong>
                        {station.availablePorts}/{station.totalPorts} ports
                      </strong>
                    </div>
                    <div>
                      <span>Price / kWh</span>
                      <strong>Rs. {Math.round(station.predictedPricePerKwh)}</strong>
                    </div>
                    <div>
                      <span>Charging Speed</span>
                      <strong>{station.maxPowerKw} kW</strong>
                    </div>
                    <div>
                      <span>Estimated Wait</span>
                      <strong>{station.predictedWaitMinutes} min</strong>
                    </div>
                    <div>
                      <span>Demand Index</span>
                      <strong>{station.demandIndex}</strong>
                    </div>
                    <div>
                      <span>Forecast confidence</span>
                      <strong>{Math.round((station.forecastConfidence ?? 0.7) * 100)}%</strong>
                    </div>
                    <div>
                      <span>Peak indicator</span>
                      <strong>{station.peakHour ? "Peak" : "Off peak"}</strong>
                    </div>
                    <div>
                      <span>Status</span>
                      <strong>{station.liveStatus || "Forecasted"}</strong>
                    </div>
                    <div>
                      <span>Connectors</span>
                      <strong>{station.connectorTypes?.join(", ") || "CCS2"}</strong>
                    </div>
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}

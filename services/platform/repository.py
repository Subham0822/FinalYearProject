from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from .domain import road_distance_km


@dataclass(frozen=True)
class Station:
    id: str
    name: str
    operator: str
    city: str
    state: str
    coordinates: dict[str, float]
    chargerType: str
    connectorType: str
    connectorTypes: list[str] | None = None
    maxPowerKw: float = 0
    totalPorts: int = 0
    basePricePerKwh: float = 0
    busyFactor: float = 0
    priceSensitivity: float = 1
    demandProfile: str = "commuter_corridor"
    areaType: str = "urban"
    reliabilityScore: float = 0.8
    amenityScore: float = 0.7
    liveStatus: str | None = None
    liveStatusTypeId: int | None = None
    statusUpdatedAt: str | None = None
    isOperational: bool | None = None
    dataSource: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _station_file() -> Path:
    return Path(__file__).resolve().parents[2] / "data" / "stations.india.json"


@lru_cache(maxsize=1)
def load_stations() -> tuple[Station, ...]:
    raw = json.loads(_station_file().read_text())
    return tuple(Station(**item) for item in raw)


def get_station(station_id: str) -> Station | None:
    return next((station for station in load_stations() if station.id == station_id), None)


def list_stations(connector_type: str | None = None) -> list[dict[str, Any]]:
    stations = load_stations()
    if connector_type:
        stations = tuple(station for station in stations if station.connectorType == connector_type)
    return [station.to_dict() for station in stations]


def nearby_stations(lat: float, lng: float, radius_km: float = 300, connector_type: str | None = None) -> dict[str, Any]:
    center = {"lat": lat, "lng": lng}
    matches: list[dict[str, Any]] = []
    for station in load_stations():
        if connector_type and station.connectorType != connector_type:
            continue
        distance = round(road_distance_km(center, station.coordinates), 2)
        if distance <= radius_km:
            matches.append({"station": station.to_dict(), "distanceKm": distance})
    matches.sort(key=lambda item: item["distanceKm"])
    return {"stations": matches}

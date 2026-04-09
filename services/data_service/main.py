from __future__ import annotations

from fastapi import FastAPI, Query

from services.platform.models import ServiceHealth
from services.platform.repository import get_station, list_stations, nearby_stations

app = FastAPI(
    title="VoltPath Data Service",
    description="Station catalog and geo lookup service for VoltPath.",
    version="1.0.0",
)


@app.get("/health")
def health() -> ServiceHealth:
    return ServiceHealth(service="data-service", status="ok")


@app.get("/stations")
def stations(connector_type: str | None = Query(default=None, alias="connectorType")) -> dict[str, object]:
    return {"stations": list_stations(connector_type)}


@app.get("/stations/{station_id}")
def station_by_id(station_id: str) -> dict[str, object]:
    station = get_station(station_id)
    return {"station": station.to_dict() if station else None}


@app.get("/stations/nearby")
def stations_nearby_endpoint(
    lat: float = Query(...),
    lng: float = Query(...),
    radius_km: float = Query(300, alias="radiusKm"),
    connector_type: str | None = Query(default=None, alias="connectorType"),
) -> dict[str, object]:
    return nearby_stations(lat, lng, radius_km, connector_type)

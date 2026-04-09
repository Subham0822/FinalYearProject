from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException, Query

from services.platform.http import try_fetch_json
from services.platform.models import ServiceHealth, TripRequest

ROUTING_SERVICE_URL = os.getenv("ROUTING_SERVICE_URL", "http://127.0.0.1:8003")
DATA_SERVICE_URL = os.getenv("DATA_SERVICE_URL", "http://127.0.0.1:8001")
FORECASTING_SERVICE_URL = os.getenv("FORECASTING_SERVICE_URL", "http://127.0.0.1:8002")

app = FastAPI(
    title="VoltPath API Gateway",
    description="API gateway for VoltPath microservices.",
    version="1.0.0",
)


def require_service(payload: dict[str, object] | None, service_name: str) -> dict[str, object]:
    if payload is None:
        raise HTTPException(status_code=503, detail=f"{service_name} is unavailable")
    return payload


@app.get("/health")
def health() -> ServiceHealth:
    dependencies = {
        "routing-service": "ok" if try_fetch_json(f"{ROUTING_SERVICE_URL}/health", timeout=1.5) else "down",
        "data-service": "ok" if try_fetch_json(f"{DATA_SERVICE_URL}/health", timeout=1.5) else "down",
        "forecasting-service": "ok" if try_fetch_json(f"{FORECASTING_SERVICE_URL}/health", timeout=1.5) else "down",
    }
    status = "ok" if all(value == "ok" for value in dependencies.values()) else "degraded"
    return ServiceHealth(service="api-gateway", status=status, dependencies=dependencies)


@app.post("/route/recommend")
def route_recommend(payload: TripRequest):
    return require_service(
        try_fetch_json(
            f"{ROUTING_SERVICE_URL}/route/recommend",
            method="POST",
            payload=payload.model_dump(mode="json"),
            timeout=8,
        ),
        "routing-service",
    )


@app.get("/stations/nearby")
def stations_nearby(
    lat: float = Query(...),
    lng: float = Query(...),
    radius_km: float = Query(300, alias="radiusKm"),
):
    return require_service(
        try_fetch_json(f"{DATA_SERVICE_URL}/stations/nearby?lat={lat}&lng={lng}&radiusKm={radius_km}", timeout=3),
        "data-service",
    )


@app.get("/forecast/station/{station_id}")
def forecast_for_station(
    station_id: str,
    departure_time: str = Query(..., alias="departureTime"),
    offset_minutes: float = Query(0, alias="offsetMinutes"),
):
    result = require_service(
        try_fetch_json(
            f"{FORECASTING_SERVICE_URL}/forecast/station/{station_id}?departureTime={departure_time}&offsetMinutes={offset_minutes}",
            timeout=3,
        ),
        "forecasting-service",
    )
    if not result.get("forecast"):
        raise HTTPException(status_code=404, detail="Station not found")
    return result

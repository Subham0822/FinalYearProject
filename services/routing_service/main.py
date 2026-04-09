from __future__ import annotations

import os

from fastapi import FastAPI

from services.platform.cache import JsonCache
from services.platform.domain import encode_query, stable_hash_payload
from services.platform.forecasting import forecast_station
from services.platform.http import try_fetch_json
from services.platform.models import ServiceHealth, TripRequest
from services.platform.repository import get_station, list_stations
from services.platform.routing import recommend_route

DATA_SERVICE_URL = os.getenv("DATA_SERVICE_URL", "http://127.0.0.1:8001")
FORECASTING_SERVICE_URL = os.getenv("FORECASTING_SERVICE_URL", "http://127.0.0.1:8002")
ROUTE_TTL_SECONDS = int(os.getenv("ROUTE_CACHE_TTL_SECONDS", "180"))

cache = JsonCache("route")

app = FastAPI(
    title="VoltPath Routing Service",
    description="Route recommendation orchestration service for VoltPath.",
    version="1.0.0",
)


def resolve_candidate_stations(connector_type: str) -> list[dict[str, object]]:
    query = encode_query({"connectorType": connector_type})
    payload = try_fetch_json(f"{DATA_SERVICE_URL}/stations?{query}", timeout=2.5)
    if payload and payload.get("stations"):
        return payload["stations"]
    return list_stations(connector_type)


def resolve_forecast(station_id: str, departure_time: str, offset_minutes: float):
    query = encode_query({"departureTime": departure_time, "offsetMinutes": offset_minutes})
    payload = try_fetch_json(f"{FORECASTING_SERVICE_URL}/forecast/station/{station_id}?{query}", timeout=2.5)
    if payload and payload.get("forecast"):
        return payload["forecast"]

    station = get_station(station_id)
    if station is None:
        return None
    from services.platform.domain import parse_datetime

    return forecast_station(station, parse_datetime(departure_time), offset_minutes)


@app.get("/health")
def health() -> ServiceHealth:
    dependencies = {
        "data-service": "ok" if try_fetch_json(f"{DATA_SERVICE_URL}/health", timeout=1.5) else "fallback-local",
        "forecasting-service": "ok" if try_fetch_json(f"{FORECASTING_SERVICE_URL}/health", timeout=1.5) else "fallback-local",
    }
    return ServiceHealth(service="routing-service", status="ok", cache=cache.status(), dependencies=dependencies)


@app.post("/route/recommend")
def route_recommend(payload: TripRequest):
    request_key = stable_hash_payload(payload.model_dump(mode="json"))
    cached = cache.get_json(request_key)
    if cached:
        return cached

    stations = resolve_candidate_stations(payload.vehicle.connectorType)
    result = recommend_route(payload, stations, lambda station_id, offset: resolve_forecast(station_id, payload.departureTime, offset))
    cache.set_json(request_key, result, ROUTE_TTL_SECONDS)
    return result

from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException, Query

from services.platform.cache import JsonCache
from services.platform.domain import parse_datetime
from services.platform.forecasting import forecast_cache_key, forecast_station
from services.platform.http import try_fetch_json
from services.platform.models import ForecastBatchRequest, ServiceHealth
from services.platform.repository import Station, get_station

DATA_SERVICE_URL = os.getenv("DATA_SERVICE_URL", "http://127.0.0.1:8001")
FORECAST_TTL_SECONDS = int(os.getenv("FORECAST_CACHE_TTL_SECONDS", "900"))

cache = JsonCache("forecast")

app = FastAPI(
    title="VoltPath Forecasting Service",
    description="Charging availability and pricing forecast service with Redis caching.",
    version="1.0.0",
)


def resolve_station(station_id: str) -> Station | None:
    station = get_station(station_id)
    if station:
        return station

    payload = try_fetch_json(f"{DATA_SERVICE_URL}/stations/{station_id}", timeout=2.5)
    if payload and payload.get("station"):
        return Station(**payload["station"])
    return None


def resolve_forecast(station_id: str, departure_time: str, offset_minutes: float) -> dict[str, object] | None:
    parsed_departure = parse_datetime(departure_time)
    cache_key = forecast_cache_key(station_id, parsed_departure, offset_minutes)
    cached = cache.get_json(cache_key)
    if cached:
        return cached

    station = resolve_station(station_id)
    if station is None:
        return None

    payload = {"forecast": forecast_station(station, parsed_departure, offset_minutes)}
    cache.set_json(cache_key, payload, FORECAST_TTL_SECONDS)
    return payload


@app.get("/health")
def health() -> ServiceHealth:
    data_dependency = "ok" if try_fetch_json(f"{DATA_SERVICE_URL}/health", timeout=1.5) else "fallback-local"
    return ServiceHealth(
        service="forecasting-service",
        status="ok",
        cache=cache.status(),
        dependencies={"data-service": data_dependency},
    )


@app.get("/forecast/station/{station_id}")
def forecast_for_station(
    station_id: str,
    departure_time: str = Query(..., alias="departureTime"),
    offset_minutes: float = Query(0, alias="offsetMinutes"),
):
    result = resolve_forecast(station_id, departure_time, offset_minutes)
    if not result:
        raise HTTPException(status_code=404, detail="Station not found")
    return result


@app.post("/forecast/batch")
def forecast_batch(payload: ForecastBatchRequest) -> dict[str, object]:
    results = []
    for item in payload.items:
        result = resolve_forecast(item.stationId, payload.departureTime, item.offsetMinutes)
        results.append(
            {
                "stationId": item.stationId,
                "offsetMinutes": item.offsetMinutes,
                "forecast": result["forecast"] if result else None,
            }
        )
    return {"results": results}

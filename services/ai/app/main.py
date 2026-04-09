from __future__ import annotations

from datetime import datetime

from fastapi import FastAPI, HTTPException, Query

from .engine import nearby_stations, recommend_route, station_forecast
from .models import TripRequest

app = FastAPI(
    title="VoltPath AI Service",
    description="AI-assisted EV route recommendation service using distance, time of day, station availability, and dynamic charging prices.",
    version="0.1.0",
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/route/recommend")
def route_recommend(payload: TripRequest):
    return recommend_route(payload)


@app.get("/stations/nearby")
def stations_nearby(
    lat: float = Query(...),
    lng: float = Query(...),
    radius_km: float = Query(300, alias="radiusKm"),
):
    return nearby_stations(lat, lng, radius_km)


@app.get("/forecast/station/{station_id}")
def forecast_for_station(
    station_id: str,
    departure_time: datetime = Query(..., alias="departureTime"),
    offset_minutes: float = Query(0, alias="offsetMinutes"),
):
    result = station_forecast(station_id, departure_time, offset_minutes)
    if not result:
        raise HTTPException(status_code=404, detail="Station not found")
    return result

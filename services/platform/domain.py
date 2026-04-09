from __future__ import annotations

import json
import math
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Any

ROAD_MULTIPLIER = 1.18
OSRM_URL = os.getenv("OSRM_URL", "https://router.project-osrm.org")


def parse_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(max(value, minimum), maximum)


def haversine_distance_km(a: dict[str, float], b: dict[str, float]) -> float:
    radius_km = 6371
    d_lat = math.radians(b["lat"] - a["lat"])
    d_lng = math.radians(b["lng"] - a["lng"])
    lat_1 = math.radians(a["lat"])
    lat_2 = math.radians(b["lat"])
    h = math.sin(d_lat / 2) ** 2 + math.sin(d_lng / 2) ** 2 * math.cos(lat_1) * math.cos(lat_2)
    return 2 * radius_km * math.asin(math.sqrt(h))


def road_distance_km(a: dict[str, float], b: dict[str, float]) -> float:
    return haversine_distance_km(a, b) * ROAD_MULTIPLIER


def traffic_multiplier(hour: int) -> float:
    if 8 <= hour <= 10 or 17 <= hour <= 21:
        return 1.35
    if 11 <= hour <= 16:
        return 1.12
    if hour >= 22 or hour <= 5:
        return 0.9
    return 1.0


def average_speed(hour: int) -> float:
    return clamp(72 / traffic_multiplier(hour), 32, 88)


def route_segment(a: dict[str, float], b: dict[str, float], fallback_hour: int) -> dict[str, Any]:
    try:
        query = (
            f"{OSRM_URL}/route/v1/driving/{a['lng']},{a['lat']};{b['lng']},{b['lat']}"
            "?overview=full&geometries=geojson"
        )
        with urllib.request.urlopen(query, timeout=4) as response:
            payload = json.loads(response.read().decode("utf-8"))
        route = payload["routes"][0]
        geometry = [{"lat": lat, "lng": lng} for lng, lat in route.get("geometry", {}).get("coordinates", [])]
        return {
            "distanceKm": round(route["distance"] / 1000, 2),
            "durationMinutes": round(route["duration"] / 60, 2),
            "geometry": geometry or [a, b],
            "source": "osrm",
        }
    except (urllib.error.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError):
        distance_km = road_distance_km(a, b)
        return {
            "distanceKm": round(distance_km, 2),
            "durationMinutes": round((distance_km / average_speed(fallback_hour)) * 60, 2),
            "geometry": [a, b],
            "source": "heuristic",
        }


def stable_hash_payload(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def encode_query(params: dict[str, Any]) -> str:
    return urllib.parse.urlencode({key: value for key, value in params.items() if value is not None})

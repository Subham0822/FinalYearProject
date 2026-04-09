from __future__ import annotations

import json
import math
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .ml_models import log_prediction, train_forecast_models
from .models import TripRequest

ROAD_MULTIPLIER = 1.18
OSRM_URL = os.getenv("OSRM_URL", "https://router.project-osrm.org")
MAPBOX_DIRECTIONS_URL = os.getenv("MAPBOX_DIRECTIONS_URL", "https://api.mapbox.com/directions/v5/mapbox/driving")
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN")
OPEN_CHARGE_MAP_URL = os.getenv("OPEN_CHARGE_MAP_URL", "https://api.openchargemap.io/v3/poi/")
OPEN_CHARGE_MAP_API_KEY = os.getenv("OPEN_CHARGE_MAP_API_KEY", "")
OPEN_CHARGE_MAP_COUNTRY_CODE = os.getenv("OPEN_CHARGE_MAP_COUNTRY_CODE", "IN")


@dataclass
class Station:
    id: str
    name: str
    operator: str
    city: str
    state: str
    coordinates: dict[str, float]
    chargerType: str
    connectorType: str
    connectorTypes: list[str] = field(default_factory=list)
    maxPowerKw: float = 0
    totalPorts: int = 1
    basePricePerKwh: float = 20
    busyFactor: float = 0.55
    priceSensitivity: float = 1.0
    demandProfile: str = "commuter_corridor"
    areaType: str = "suburban"
    reliabilityScore: float = 0.8
    peakHourCongestionFactor: float = 0.56
    operatorTrustScore: float = 0.8
    historicalDemandProfile: list[float] = field(default_factory=list)
    connectorCompatibility: list[str] = field(default_factory=list)
    amenityScore: float = 0.75
    liveStatus: str | None = None
    liveStatusTypeId: int | None = None
    statusUpdatedAt: str | None = None
    isOperational: bool | None = None
    dataSource: str = "seed"


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


def midpoint(a: dict[str, float], b: dict[str, float]) -> dict[str, float]:
    return {"lat": (a["lat"] + b["lat"]) / 2, "lng": (a["lng"] + b["lng"]) / 2}


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
        query = f"{OSRM_URL}/route/v1/driving/{a['lng']},{a['lat']};{b['lng']},{b['lat']}?overview=full&geometries=geojson&steps=true"
        with urllib.request.urlopen(query, timeout=4) as response:
            payload = json.loads(response.read().decode("utf-8"))
        route = payload["routes"][0]
        geometry = [{"lat": lat, "lng": lng} for lng, lat in route.get("geometry", {}).get("coordinates", [])]
        steps = []
        for leg in route.get("legs", []):
            for step in leg.get("steps", []):
                maneuver = step.get("maneuver") or {}
                steps.append(
                    {
                        "instruction": maneuver.get("instruction") or f"{maneuver.get('type', 'Continue')} on {step.get('name') or 'the road'}",
                        "distanceKm": round((step.get("distance") or 0) / 1000, 2),
                        "durationMinutes": round((step.get("duration") or 0) / 60, 1),
                        "maneuver": " ".join(filter(None, [maneuver.get("type"), maneuver.get("modifier")])) or "continue",
                        "roadName": step.get("name") or None,
                    }
                )
        return {
            "distanceKm": round(route["distance"] / 1000, 2),
            "durationMinutes": round(route["duration"] / 60, 2),
            "geometry": geometry or [a, b],
            "steps": steps,
            "source": "osrm",
        }
    except (urllib.error.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError):
        pass

    if MAPBOX_ACCESS_TOKEN:
        try:
            query = (
                f"{MAPBOX_DIRECTIONS_URL}/{a['lng']},{a['lat']};{b['lng']},{b['lat']}"
                f"?alternatives=false&overview=full&geometries=geojson&steps=true&access_token={MAPBOX_ACCESS_TOKEN}"
            )
            with urllib.request.urlopen(query, timeout=4) as response:
                payload = json.loads(response.read().decode("utf-8"))
            route = payload["routes"][0]
            geometry = [{"lat": lat, "lng": lng} for lng, lat in route.get("geometry", {}).get("coordinates", [])]
            steps = []
            for leg in route.get("legs", []):
                for step in leg.get("steps", []):
                    maneuver = step.get("maneuver") or {}
                    steps.append(
                        {
                            "instruction": maneuver.get("instruction") or f"{maneuver.get('type', 'Continue')} on {step.get('name') or 'the road'}",
                            "distanceKm": round((step.get("distance") or 0) / 1000, 2),
                            "durationMinutes": round((step.get("duration") or 0) / 60, 1),
                            "maneuver": " ".join(filter(None, [maneuver.get("type"), maneuver.get("modifier")])) or "continue",
                            "roadName": step.get("name") or None,
                        }
                    )
            return {
                "distanceKm": round(route["distance"] / 1000, 2),
                "durationMinutes": round(route["duration"] / 60, 2),
                "geometry": geometry or [a, b],
                "steps": steps,
                "source": "mapbox",
            }
        except (urllib.error.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError):
            pass

    distance_km = road_distance_km(a, b)
    duration_minutes = round((distance_km / average_speed(fallback_hour)) * 60, 2)
    return {
        "distanceKm": round(distance_km, 2),
        "durationMinutes": duration_minutes,
        "geometry": [a, b],
        "steps": [
            {
                "instruction": "Follow the primary corridor toward the next waypoint",
                "distanceKm": round(distance_km, 2),
                "durationMinutes": duration_minutes,
                "maneuver": "continue",
                "roadName": None,
            },
            {
                "instruction": "Arrive at the waypoint",
                "distanceKm": 0,
                "durationMinutes": 0,
                "maneuver": "arrive",
                "roadName": None,
            },
        ],
        "source": "heuristic",
    }


def station_supports_connector(station: Station, connector_type: str) -> bool:
    supported = station.connectorCompatibility or station.connectorTypes or [station.connectorType]
    return any(value.lower() == connector_type.lower() for value in supported)


def _load_seed_stations() -> list[Station]:
    root = Path(__file__).resolve().parents[3]
    station_file = root / "data" / "stations.india.json"
    raw = json.loads(station_file.read_text())
    return [Station(**item) for item in raw]


SEED_STATIONS = _load_seed_stations()
FORECAST_MODELS = train_forecast_models(SEED_STATIONS)


def _normalize_connector_label(label: str | None) -> str | None:
    value = (label or "").strip().lower()
    if not value:
        return None
    if "ccs" in value and "2" in value:
        return "CCS2"
    if "type 2" in value:
        return "Type 2"
    if "cha" in value:
        return "CHAdeMO"
    if "bharat" in value:
        return "Bharat DC"
    if "gb/t" in value or "gbt" in value:
        return "GB/T"
    if "tesla" in value:
        return "Tesla"
    return label.strip()


def _parse_usage_cost(usage_cost: str | None) -> float | None:
    if not usage_cost:
        return None
    cleaned = usage_cost.replace(",", " ")
    import re

    match = re.search(r"(?:rs\.?|inr|₹)\s*([0-9]+(?:\.[0-9]+)?)", cleaned, re.IGNORECASE) or re.search(
        r"([0-9]+(?:\.[0-9]+)?)", cleaned
    )
    if not match:
        return None
    return float(match.group(1))


def _infer_area_type(payload: dict[str, Any]) -> str:
    title = f"{payload.get('AddressInfo', {}).get('Title', '')} {payload.get('UsageType', {}).get('Title', '')}".lower()
    if "highway" in title or "expressway" in title or "toll" in title:
        return "highway"
    if "mall" in title or "office" in title or "airport" in title:
        return "urban"
    return "suburban"


def _infer_demand_profile(area_type: str, payload: dict[str, Any]) -> str:
    title = f"{payload.get('AddressInfo', {}).get('Title', '')} {payload.get('UsageType', {}).get('Title', '')}".lower()
    if "office" in title or "business" in title:
        return "business_district"
    if "hotel" in title or "mall" in title or "tour" in title:
        return "destination_leisure"
    if area_type == "highway":
        return "commuter_corridor"
    if area_type == "urban":
        return "metro_peak"
    return "destination_leisure"


def _derive_reliability(payload: dict[str, Any], total_ports: int, is_operational: bool | None) -> float:
    now = datetime.now(UTC)
    freshest = None
    for field_name in ("DateLastStatusUpdate", "DateLastVerified"):
        if payload.get(field_name):
            try:
                freshest = datetime.fromisoformat(payload[field_name].replace("Z", "+00:00"))
                break
            except ValueError:
                continue

    days_since_refresh = 9999 if freshest is None else (now - freshest).total_seconds() / 86400
    score = 0.58
    if is_operational is True:
        score += 0.18
    elif is_operational is False:
        score -= 0.26
    if payload.get("IsRecentlyVerified"):
        score += 0.08
    if days_since_refresh <= 30:
        score += 0.1
    elif days_since_refresh <= 180:
        score += 0.05
    elif days_since_refresh > 540:
        score -= 0.08
    score += min(0.08, max(0, total_ports - 1) * 0.02)
    return round(clamp(score, 0.25, 0.98), 2)


def _derive_amenity(payload: dict[str, Any], max_power_kw: float) -> float:
    title = f"{payload.get('AddressInfo', {}).get('Title', '')} {payload.get('UsageType', {}).get('Title', '')}".lower()
    score = 0.58
    if "mall" in title or "hotel" in title or "airport" in title:
        score += 0.18
    if "restaurant" in title or "cafe" in title:
        score += 0.1
    if max_power_kw >= 100:
        score += 0.06
    if (payload.get("NumberOfPoints") or 0) >= 4:
        score += 0.05
    return round(clamp(score, 0.45, 0.97), 2)


def _normalize_open_charge_map_station(payload: dict[str, Any]) -> Station | None:
    address = payload.get("AddressInfo") or {}
    latitude = address.get("Latitude")
    longitude = address.get("Longitude")
    if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
        return None

    connections = payload.get("Connections") or []
    connector_types: list[str] = []
    max_power_kw = 0.0
    quantity_total = 0
    has_fast = False
    for connection in connections:
        normalized = _normalize_connector_label((connection.get("ConnectionType") or {}).get("Title"))
        if normalized and normalized not in connector_types:
            connector_types.append(normalized)
        max_power_kw = max(max_power_kw, float(connection.get("PowerKW") or 0))
        quantity_total += int(connection.get("Quantity") or 1)
        title = f"{(connection.get('Level') or {}).get('Title', '')} {(connection.get('ConnectionType') or {}).get('Title', '')}".lower()
        has_fast = has_fast or "rapid" in title or "dc" in title or max_power_kw >= 50

    primary_connector = connector_types[0] if connector_types else "CCS2"
    total_ports = max(1, int(payload.get("NumberOfPoints") or 0), quantity_total)
    is_operational = (payload.get("StatusType") or {}).get("IsOperational")
    area_type = _infer_area_type(payload)
    base_price = _parse_usage_cost(payload.get("UsageCost")) or (24 if max_power_kw >= 60 else 16)
    station = Station(
        id=f"ocm-{payload['ID']}",
        name=(address.get("Title") or f"Open Charge Map Station {payload['ID']}").strip(),
        operator=((payload.get("OperatorInfo") or {}).get("Title") or "Open Network").strip(),
        city=(address.get("Town") or "Unknown").strip(),
        state=(address.get("StateOrProvince") or "Unknown").strip(),
        coordinates={"lat": float(latitude), "lng": float(longitude)},
        chargerType="DC Fast" if has_fast or max_power_kw >= 50 else "AC",
        connectorType=primary_connector,
        connectorTypes=connector_types or [primary_connector],
        maxPowerKw=round(max(max_power_kw, 22 if primary_connector == "Type 2" else 30), 1),
        totalPorts=total_ports,
        basePricePerKwh=round(float(base_price), 2),
        busyFactor=round(clamp(0.38 + (0.22 if area_type == "urban" else 0.16 if area_type == "highway" else 0.1), 0.25, 0.9), 2),
        priceSensitivity=round(clamp(1 + (0.08 if max_power_kw >= 100 else 0.02), 0.92, 1.14), 2),
        demandProfile=_infer_demand_profile(area_type, payload),
        areaType=area_type,
        reliabilityScore=_derive_reliability(payload, total_ports, is_operational),
        peakHourCongestionFactor=round(clamp(0.42 + (0.12 if area_type == "urban" else 0.08 if area_type == "highway" else 0.06), 0.25, 0.92), 2),
        operatorTrustScore=round(clamp(0.62 + _derive_reliability(payload, total_ports, is_operational) * 0.32, 0.58, 0.96), 2),
        historicalDemandProfile=[],
        connectorCompatibility=connector_types or [primary_connector],
        amenityScore=_derive_amenity(payload, max_power_kw),
        liveStatus=(payload.get("StatusType") or {}).get("Title"),
        liveStatusTypeId=(payload.get("StatusType") or {}).get("ID"),
        statusUpdatedAt=payload.get("DateLastStatusUpdate") or payload.get("DateLastVerified"),
        isOperational=is_operational,
        dataSource="openchargemap",
    )
    return station


def _fetch_open_charge_map(**params: Any) -> list[Station]:
    query = {
        "output": "json",
        "compact": "true",
        "verbose": "false",
        "countrycode": OPEN_CHARGE_MAP_COUNTRY_CODE,
        **{key: str(value) for key, value in params.items()},
    }
    if OPEN_CHARGE_MAP_API_KEY:
        query["key"] = OPEN_CHARGE_MAP_API_KEY

    request = urllib.request.Request(
        f"{OPEN_CHARGE_MAP_URL}?{urllib.parse.urlencode(query)}",
        headers={"X-API-Key": OPEN_CHARGE_MAP_API_KEY, "X-Requested-With": "VoltPath AI"},
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        payload = json.loads(response.read().decode("utf-8"))
    stations = []
    for item in payload:
        normalized = _normalize_open_charge_map_station(item)
        if normalized:
            stations.append(normalized)
    unique: dict[str, Station] = {}
    for station in stations:
        unique[station.id] = station
    return list(unique.values())


def _stations_for_trip(request: TripRequest) -> tuple[list[Station], str, bool]:
    route_midpoint = midpoint(request.origin.model_dump(), request.destination.model_dump())
    direct_distance = haversine_distance_km(request.origin.model_dump(), request.destination.model_dump())
    search_radius = clamp(math.ceil(direct_distance / 2) + 180, 120, 450)
    max_results = int(clamp(math.ceil(direct_distance * 0.75), 80, 250))

    try:
        stations = _fetch_open_charge_map(
            latitude=route_midpoint["lat"],
            longitude=route_midpoint["lng"],
            distance=search_radius,
            distanceunit="KM",
            maxresults=max_results,
        )
        compatible = [station for station in stations if station_supports_connector(station, request.vehicle.connectorType)]
        if compatible:
            return compatible, "Open Charge Map", True
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError, ValueError):
        pass

    fallback = [station for station in SEED_STATIONS if station_supports_connector(station, request.vehicle.connectorType)]
    return fallback, "Seed fallback", False


def _nearby_live_stations(center: dict[str, float], radius_km: float, connector_type: str | None = None) -> tuple[list[dict[str, Any]], bool, str]:
    try:
        stations = _fetch_open_charge_map(
            latitude=center["lat"],
            longitude=center["lng"],
            distance=clamp(radius_km, 25, 500),
            distanceunit="KM",
            maxresults=int(clamp(round(radius_km * 1.6), 40, 250)),
        )
        matches = [
            {
                "station": station.__dict__,
                "distanceKm": round(haversine_distance_km(center, station.coordinates), 2),
            }
            for station in stations
            if connector_type is None or station_supports_connector(station, connector_type)
        ]
        matches.sort(key=lambda item: item["distanceKm"])
        if matches:
            return matches, True, "Open Charge Map"
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError, ValueError):
        pass

    matches = [
        {
            "station": station.__dict__,
            "distanceKm": round(haversine_distance_km(center, station.coordinates), 2),
        }
        for station in SEED_STATIONS
        if (connector_type is None or station_supports_connector(station, connector_type))
        and haversine_distance_km(center, station.coordinates) <= radius_km
    ]
    matches.sort(key=lambda item: item["distanceKm"])
    return matches, False, "Seed fallback"


def forecast_station(station: Station, departure: datetime, arrival_minutes: float) -> dict[str, Any]:
    arrival = departure + timedelta(minutes=arrival_minutes)
    prediction = FORECAST_MODELS.predict(station, arrival)
    availability_ratio = prediction["availabilityRatio"]
    peak_hour = 8 <= arrival.hour <= 10 or 17 <= arrival.hour <= 21
    congestion_factor = clamp((station.peakHourCongestionFactor or 0.56) + (0.14 if peak_hour else 0) + max(0, traffic_multiplier(arrival.hour) - 1) * 0.22, 0.25, 1.45)
    if station.isOperational is False:
        availability_ratio = 0.0
    elif station.isOperational is True:
        availability_ratio = min(0.99, availability_ratio + 0.04)
    available_ports = int(clamp(round(station.totalPorts * availability_ratio), 0, station.totalPorts))
    predicted_wait = round(
        clamp((1 - availability_ratio) * 46 + (1 - station.reliabilityScore) * 14 + (traffic_multiplier(arrival.hour) - 1) * 24, 4, 70)
    )
    payload = {
        "stationId": station.id,
        "availablePorts": available_ports,
        "availabilityRatio": round(availability_ratio, 2),
        "predictedWaitMinutes": predicted_wait,
        "currentPricePerKwh": station.basePricePerKwh,
        "predictedPricePerKwh": prediction["predictedPricePerKwh"],
        "trafficMultiplier": traffic_multiplier(arrival.hour),
        "timestamp": arrival.isoformat(),
        "confidence": round((prediction["availabilityConfidence"] + prediction["priceConfidence"]) / 2, 2),
        "demandIndex": round(clamp(1 - availability_ratio + station.busyFactor * 0.25, 0.08, 1.5), 2),
        "forecastConfidence": round((prediction["availabilityConfidence"] + prediction["priceConfidence"]) / 2, 2),
        "availabilityConfidence": prediction["availabilityConfidence"],
        "priceConfidence": prediction["priceConfidence"],
        "waitTimeConfidence": round(clamp((prediction["availabilityConfidence"] + prediction["priceConfidence"]) / 2 - congestion_factor * 0.08, 0.5, 0.92), 2),
        "probabilityAvailable": prediction["probabilityAvailable"],
        "peakHour": peak_hour,
        "congestionFactor": round(congestion_factor, 2),
        "surgeMultiplier": round(max(1.0, prediction["predictedPricePerKwh"] / max(station.basePricePerKwh, 1)), 2),
        "demandLevel": "high" if (1 - availability_ratio + station.busyFactor * 0.25) >= 0.92 else "moderate" if (1 - availability_ratio + station.busyFactor * 0.25) >= 0.58 else "low",
        "comparison": prediction["comparison"],
        "validation": prediction["validation"],
        "source": "ml",
    }
    log_prediction(
        {
            "stationId": station.id,
            "timestamp": datetime.now(UTC).isoformat(),
            "arrivalTimestamp": arrival.isoformat(),
            "prediction": payload,
        }
    )
    return payload


def full_range_km(request: TripRequest) -> float:
    return request.vehicle.batteryCapacityKwh * request.vehicle.efficiencyKmPerKwh


def usable_range_km(request: TripRequest, soc: float) -> float:
    return full_range_km(request) * (soc / 100)


def effective_reserve_soc(request: TripRequest) -> float:
    return clamp(request.reserveSoc + request.safetyBufferSoc, request.reserveSoc, 35)


def segment_energy_kwh(request: TripRequest, segment_distance_km: float, segment_minutes: float, start_hour: int) -> float:
    traffic = traffic_multiplier(start_hour)
    average_speed_kph = clamp(segment_distance_km / max(segment_minutes / 60, 0.15), 18, 120)
    base_energy = segment_distance_km / request.vehicle.efficiencyKmPerKwh
    speed_multiplier = clamp(1 + max(0, average_speed_kph - 62) * 0.009, 1, 1.45) if average_speed_kph > 62 else clamp(1 - (62 - average_speed_kph) * 0.0035, 0.9, 1.02)
    stop_go_events = max(0, round(segment_distance_km * max(0.08, (traffic - 0.72) * 0.42) + segment_minutes / 22))
    stop_go_penalty = stop_go_events * 0.035
    elevation_gain_m = segment_distance_km * 2.8
    elevation_loss_m = segment_distance_km * 2.1
    uphill_energy = (2100 * 9.81 * elevation_gain_m) / (3_600_000 * 0.9)
    regen_recovery = (2100 * 9.81 * elevation_loss_m * 0.55) / 3_600_000
    elevation_energy = max(-0.35, uphill_energy - regen_recovery)
    ac_power_kw = 0 if not request.simulateAcUsage else 1.8 if 11 <= start_hour <= 17 else 1.25 if 8 <= start_hour <= 10 or 18 <= start_hour <= 21 else 0.75
    auxiliary_energy = ac_power_kw * (segment_minutes / 60)
    return round(max(0.05, base_energy * speed_multiplier * (1 + max(0, traffic - 1) * 0.08) + stop_go_penalty + elevation_energy + auxiliary_energy), 2)


def segment_soc_after(request: TripRequest, current_soc: float, segment_distance_km: float, segment_minutes: float, start_hour: int) -> float:
    energy = segment_energy_kwh(request, segment_distance_km, segment_minutes, start_hour)
    return round(clamp(current_soc - (energy / request.vehicle.batteryCapacityKwh) * 100, 0, 100), 2)


def build_segment_predictions(request: TripRequest, stops: list[dict[str, Any]], total_distance_km: float, total_drive_minutes: float) -> list[dict[str, Any]]:
    points = [request.origin.model_dump(), *[stop["station"]["coordinates"] for stop in stops], request.destination.model_dump()]
    labels = [request.origin.label or "Origin", *[stop["station"]["name"] for stop in stops], request.destination.label or "Destination"]
    base_leg_distances = [road_distance_km(points[index], points[index + 1]) for index in range(len(points) - 1)]
    total_base_distance = sum(base_leg_distances) or 1
    current_soc = request.startingSoc
    segments: list[dict[str, Any]] = []

    for index, base_leg_distance in enumerate(base_leg_distances):
        distance_km = round(base_leg_distance / total_base_distance * total_distance_km, 2)
        duration_minutes = max(1, round(base_leg_distance / total_base_distance * total_drive_minutes))
        start_hour = (request.departureTime + timedelta(minutes=sum(segment["durationMinutes"] for segment in segments))).hour
        total_energy = segment_energy_kwh(request, distance_km, duration_minutes, start_hour)
        average_speed_kph = round(clamp(distance_km / max(duration_minutes / 60, 0.15), 18, 120), 1)
        drive_energy = round(max(0, total_energy - ((0 if not request.simulateAcUsage else 1.1) * (duration_minutes / 60))), 2)
        auxiliary_energy = round(total_energy - drive_energy, 2)
        soc_end = round(clamp(current_soc - (total_energy / request.vehicle.batteryCapacityKwh) * 100, 0, 100), 2)
        segments.append(
            {
                "label": f"{labels[index]} to {labels[index + 1]}",
                "from": labels[index],
                "to": labels[index + 1],
                "distanceKm": distance_km,
                "durationMinutes": duration_minutes,
                "averageSpeedKph": average_speed_kph,
                "socStart": round(current_soc, 2),
                "socEnd": soc_end,
                "driveEnergyKwh": drive_energy,
                "auxiliaryEnergyKwh": auxiliary_energy,
                "totalEnergyKwh": total_energy,
                "trafficMultiplier": round(traffic_multiplier(start_hour), 2),
                "stopGoEvents": max(0, round(distance_km * max(0.1, traffic_multiplier(start_hour) - 0.7))),
                "elevationGainM": round(distance_km * 2.8),
                "elevationLossM": round(distance_km * 2.1),
                "netElevationDeltaM": round(distance_km * 0.7),
            }
        )
        current_soc = stops[index]["departureSoc"] if index < len(stops) else soc_end

    return segments


def _weights(mode: str) -> dict[str, float]:
    if mode == "fastest":
        return {"distance": 0.18, "time": 0.34, "price": 0.12, "availability": 0.2, "detour": 0.16}
    if mode == "cheapest":
        return {"distance": 0.16, "time": 0.16, "price": 0.34, "availability": 0.18, "detour": 0.16}
    return {"distance": 0.2, "time": 0.26, "price": 0.2, "availability": 0.18, "detour": 0.16}


def _build_stop(
    request: TripRequest,
    station: Station,
    current_soc: float,
    segment_distance_km: float,
    next_leg_distance_km: float,
    travel_minutes_before_arrival: float,
) -> dict[str, Any] | None:
    arrival_hour = (request.departureTime + timedelta(minutes=travel_minutes_before_arrival)).hour
    arrival_soc = segment_soc_after(request, current_soc, segment_distance_km, max(travel_minutes_before_arrival, 1), arrival_hour)
    if arrival_soc <= effective_reserve_soc(request):
        return None

    forecast = forecast_station(station, request.departureTime, travel_minutes_before_arrival)
    if not station_supports_connector(station, request.vehicle.connectorType) or station.isOperational is False:
        return None
    if forecast["availablePorts"] <= 0:
        return None

    next_leg_hour = (request.departureTime + timedelta(minutes=travel_minutes_before_arrival + 30)).hour
    next_leg_energy = segment_energy_kwh(request, next_leg_distance_km, max(next_leg_distance_km / average_speed(next_leg_hour) * 60, 1), next_leg_hour)
    required_departure_soc = clamp(
        effective_reserve_soc(request) + (next_leg_energy / request.vehicle.batteryCapacityKwh) * 100 + 4,
        effective_reserve_soc(request) + 6,
        92,
    )
    charged_energy = max(0, (required_departure_soc - arrival_soc) / 100 * request.vehicle.batteryCapacityKwh)
    charging_power = min(request.vehicle.maxChargingPowerKw, station.maxPowerKw)
    charging_minutes = round((charged_energy / charging_power) * 60 * 1.12) if charged_energy > 0 else 0
    charging_cost = round(charged_energy * forecast["predictedPricePerKwh"], 2)

    return {
        "station": station.__dict__,
        "arrivalSoc": arrival_soc,
        "departureSoc": round(required_departure_soc, 2),
        "chargedEnergyKwh": round(charged_energy, 2),
        "chargingMinutes": charging_minutes,
        "chargingCost": charging_cost,
        "waitMinutes": forecast["predictedWaitMinutes"],
        "forecast": forecast,
        "lowBufferRisk": arrival_soc <= effective_reserve_soc(request) + 6,
        "tightReachability": required_departure_soc >= 88,
    }


def _route_option(
    request: TripRequest,
    label: str,
    geometry: list[dict[str, float]],
    stops: list[dict[str, Any]],
    direct_distance_km: float,
    total_distance_km: float,
    total_drive_minutes: float,
    route_source: str,
) -> dict[str, Any]:
    segments = build_segment_predictions(request, stops, total_distance_km, total_drive_minutes)
    total_charging_minutes = sum(stop["chargingMinutes"] for stop in stops)
    total_wait_minutes = sum(stop["waitMinutes"] for stop in stops)
    total_travel_minutes = round(total_drive_minutes + total_charging_minutes + total_wait_minutes)
    total_cost = round(sum(stop["chargingCost"] for stop in stops), 2)
    detour = round(max(0, total_distance_km - direct_distance_km), 2)
    weights = _weights(request.mode)
    avg_availability = 0.92 if not stops else sum(stop["forecast"]["availabilityRatio"] for stop in stops) / len(stops)
    raw_score = (
        100
        - total_distance_km * weights["distance"]
        - total_travel_minutes * weights["time"]
        - total_cost * weights["price"]
        - detour * weights["detour"]
        + avg_availability * 100 * weights["availability"]
    )
    score = round(clamp(raw_score, 1, 99), 1)
    final_soc = segments[-1]["socEnd"] if segments else request.startingSoc
    minimum_arrival_soc = round(min([request.startingSoc, *[segment["socEnd"] for segment in segments], *[stop["arrivalSoc"] for stop in stops]]), 2)
    availability_probability = round(
        0.95 if not stops else max(0.05, math.prod(max(0.08, stop["forecast"].get("probabilityAvailable", stop["forecast"]["availabilityRatio"])) for stop in stops)),
        2,
    )
    warnings = [
        warning
        for warning in [
            "Low buffer risk" if minimum_arrival_soc <= effective_reserve_soc(request) + 4 else None,
            "Tight reachability" if any(stop.get("tightReachability") for stop in stops) else None,
            "High charger congestion" if any(stop["forecast"].get("demandLevel") == "high" for stop in stops) else None,
        ]
        if warning
    ]
    return {
        "id": f"{label.lower().replace(' ', '-')}-{'-'.join(stop['station']['id'] for stop in stops) or 'direct'}",
        "label": label,
        "routeVariant": "direct" if not stops else "one-stop" if len(stops) == 1 else "multi-stop",
        "geometry": geometry,
        "routePolyline": ";".join(f"{point['lat']:.5f},{point['lng']:.5f}" for point in geometry),
        "segments": segments,
        "totalDistanceKm": round(total_distance_km, 2),
        "totalDriveMinutes": round(total_drive_minutes),
        "totalChargingMinutes": total_charging_minutes,
        "totalWaitMinutes": total_wait_minutes,
        "totalTravelMinutes": total_travel_minutes,
        "totalChargingCost": total_cost,
        "detourKm": detour,
        "finalSoc": round(final_soc, 2),
        "minimumArrivalSoc": minimum_arrival_soc,
        "safetyBufferSoc": round(request.safetyBufferSoc, 2),
        "trafficDelayMinutes": round(max(0, total_drive_minutes * max(0, traffic_multiplier(request.departureTime.hour) - 1) * 0.42)),
        "averageCongestion": round(clamp((traffic_multiplier(request.departureTime.hour) - 0.84) / 0.86, 0, 1), 2),
        "totalEnergyKwh": round(sum(segment["totalEnergyKwh"] for segment in segments), 2),
        "availabilityProbability": availability_probability,
        "warnings": warnings,
        "score": score,
        "weightedScore": score,
        "paretoRank": 1,
        "isParetoOptimal": False,
        "dominanceCount": 0,
        "objectives": {
            "timeMinutes": total_travel_minutes,
            "cost": total_cost,
            "batteryUsageKwh": round(sum(segment["totalEnergyKwh"] for segment in segments), 2),
            "batteryUsagePercent": round(max(0, request.startingSoc - final_soc), 1),
            "waitTimeMinutes": total_wait_minutes,
        },
        "routeSource": route_source,
        "explanation": {
            "distanceScore": round(max(0, 100 - total_distance_km * weights["distance"]), 1),
            "timeScore": round(max(0, 100 - total_travel_minutes * weights["time"]), 1),
            "priceScore": round(max(0, 100 - total_cost * weights["price"]), 1),
            "availabilityScore": round(min(100, (avg_availability * 20 * weights["availability"]) * 4), 1),
            "detourScore": round(max(0, 100 - detour * weights["detour"]), 1),
            "trafficScore": round(max(0, 100 - max(0, total_drive_minutes * max(0, traffic_multiplier(request.departureTime.hour) - 1) * 0.2)), 1),
            "congestionScore": round(max(0, 100 - clamp((traffic_multiplier(request.departureTime.hour) - 0.84) / 0.86, 0, 1) * 65), 1),
            "scoreBreakdown": {
                "costContribution": {"label": "Charging cost", "value": total_cost, "displayValue": f"Rs {round(total_cost)}", "weight": weights["price"], "impact": "penalty", "normalizedMagnitude": round(clamp(total_cost / 1500, 0, 1), 2)},
                "timeContribution": {"label": "Travel time", "value": total_travel_minutes, "displayValue": f"{total_travel_minutes} min", "weight": weights["time"], "impact": "penalty", "normalizedMagnitude": round(clamp(total_travel_minutes / 900, 0, 1), 2)},
                "availabilityContribution": {"label": "Station availability", "value": avg_availability, "displayValue": f"{round(avg_availability * 100)}%", "weight": weights["availability"], "impact": "boost", "normalizedMagnitude": round(clamp(avg_availability, 0, 1), 2)},
                "detourContribution": {"label": "Detour penalty", "value": detour, "displayValue": f"{detour:.1f} km", "weight": weights["detour"], "impact": "penalty", "normalizedMagnitude": round(clamp(detour / 180, 0, 1), 2)},
                "energyContribution": {"label": "Energy use", "value": round(sum(segment["totalEnergyKwh"] for segment in segments), 2), "displayValue": f"{round(sum(segment['totalEnergyKwh'] for segment in segments), 1)} kWh", "weight": 0.2, "impact": "penalty", "normalizedMagnitude": round(clamp(sum(segment["totalEnergyKwh"] for segment in segments) / max(request.vehicle.batteryCapacityKwh, 1), 0, 1), 2)},
            },
            "whyChosen": "Direct route maintains the buffered reserve." if not stops else "This route keeps the trip feasible with buffered SOC while balancing wait time and price.",
            "chosenBecause": [
                f"Minimum predicted SOC stays at {minimum_arrival_soc}%",
                f"Buffered reserve target is {effective_reserve_soc(request):.0f}%",
                f"Total segment energy is {round(sum(segment['totalEnergyKwh'] for segment in segments), 1)} kWh",
            ],
            "rejectedRouteComparisons": [],
            "summary": "Direct route avoids charging uncertainty."
            if not stops
            else f"Route prioritizes live-compatible chargers and dynamic energy efficiency under the {request.mode} profile.",
            "tradeoffSummary": f"Predicted SOC never drops below {minimum_arrival_soc}% while preserving a {request.safetyBufferSoc}% safety buffer.",
        },
        "stops": stops,
    }


def recommend_route(request: TripRequest) -> dict[str, Any]:
    stations, provider, _live = _stations_for_trip(request)
    departure_hour = request.departureTime.hour
    direct_segment = route_segment(request.origin.model_dump(), request.destination.model_dump(), departure_hour)
    direct_distance_km = direct_segment["distanceKm"]
    direct_drive_minutes = direct_segment["durationMinutes"]
    initial_usable_range = usable_range_km(request, max(0, request.startingSoc - effective_reserve_soc(request)))
    candidates: list[dict[str, Any]] = []

    direct_arrival_soc = segment_soc_after(request, request.startingSoc, direct_distance_km, direct_drive_minutes, departure_hour)
    if direct_arrival_soc >= effective_reserve_soc(request):
        candidates.append(
            _route_option(
                request,
                "Direct Route",
                direct_segment["geometry"],
                [],
                direct_distance_km,
                direct_distance_km,
                direct_drive_minutes,
                direct_segment["source"],
            )
        )

    first_leg_stations = [
        station
        for station in stations
        if station_supports_connector(station, request.vehicle.connectorType)
        and station.isOperational is not False
        and road_distance_km(request.origin.model_dump(), station.coordinates) <= initial_usable_range
    ]

    for station in first_leg_stations:
        first_segment = route_segment(request.origin.model_dump(), station.coordinates, departure_hour)
        destination_segment = route_segment(station.coordinates, request.destination.model_dump(), departure_hour)
        first_leg_km = first_segment["distanceKm"]
        to_destination_km = destination_segment["distanceKm"]
        first_leg_minutes = first_segment["durationMinutes"]
        first_stop = _build_stop(request, station, request.startingSoc, first_leg_km, to_destination_km, first_leg_minutes)
        if not first_stop:
            continue

        range_after_charge = usable_range_km(request, max(0, first_stop["departureSoc"] - effective_reserve_soc(request)))
        if range_after_charge >= to_destination_km:
            candidates.append(
                _route_option(
                    request,
                    "One-Stop Route",
                    [*first_segment["geometry"][:-1], *destination_segment["geometry"]],
                    [first_stop],
                    direct_distance_km,
                    first_leg_km + to_destination_km,
                    first_leg_minutes + destination_segment["durationMinutes"],
                    "osrm" if first_segment["source"] == "osrm" or destination_segment["source"] == "osrm" else "heuristic",
                )
            )

        second_leg_stations = [
            next_station
            for next_station in stations
            if next_station.id != station.id
            and station_supports_connector(next_station, request.vehicle.connectorType)
            and next_station.isOperational is not False
            and road_distance_km(station.coordinates, next_station.coordinates) <= range_after_charge
        ]

        for second_station in second_leg_stations:
            middle_segment = route_segment(station.coordinates, second_station.coordinates, departure_hour)
            final_segment = route_segment(second_station.coordinates, request.destination.model_dump(), departure_hour)
            second_stop_arrival_offset = first_leg_minutes + first_stop["waitMinutes"] + first_stop["chargingMinutes"] + middle_segment["durationMinutes"]
            second_stop = _build_stop(
                request,
                second_station,
                first_stop["departureSoc"],
                middle_segment["distanceKm"],
                final_segment["distanceKm"],
                second_stop_arrival_offset,
            )
            if not second_stop:
                continue

            final_range = usable_range_km(request, max(0, second_stop["departureSoc"] - effective_reserve_soc(request)))
            if final_range < final_segment["distanceKm"]:
                continue

            candidates.append(
                _route_option(
                    request,
                    "Multi-Stop Route",
                    [*first_segment["geometry"][:-1], *middle_segment["geometry"][:-1], *final_segment["geometry"]],
                    [first_stop, second_stop],
                    direct_distance_km,
                    first_leg_km + middle_segment["distanceKm"] + final_segment["distanceKm"],
                    first_leg_minutes + middle_segment["durationMinutes"] + final_segment["durationMinutes"],
                    "osrm"
                    if first_segment["source"] == "osrm" or middle_segment["source"] == "osrm" or final_segment["source"] == "osrm"
                    else "heuristic",
                )
            )

    unique_candidates = sorted({candidate["id"]: candidate for candidate in candidates}.values(), key=lambda item: item["score"], reverse=True)
    pareto_routes = unique_candidates[: max(1, min(3, len(unique_candidates)))]
    for index, route in enumerate(unique_candidates):
        route["weightedScore"] = route["score"]
        route["paretoRank"] = 1 if route in pareto_routes else index + 1
        route["isParetoOptimal"] = route in pareto_routes
        route["dominanceCount"] = 0 if route in pareto_routes else 1
    if unique_candidates:
        fastest = min(unique_candidates, key=lambda item: item["totalTravelMinutes"])
        cheapest = min(unique_candidates, key=lambda item: item["totalChargingCost"])
        unique_candidates[0]["routeCategory"] = "recommended"
        if fastest["id"] != unique_candidates[0]["id"]:
            fastest["routeCategory"] = "fastest"
        if cheapest["id"] not in {unique_candidates[0]["id"], fastest["id"]}:
            cheapest["routeCategory"] = "cheapest"
    if not unique_candidates:
        return {
            "bestRoute": None,
            "alternatives": [],
            "paretoRoutes": [],
            "directDistanceKm": round(direct_distance_km, 2),
            "feasible": False,
            "reason": f"No feasible route was found. Increase starting SOC or choose a corridor with reachable compatible charging stations. Data source: {provider}.",
            "generatedAt": datetime.now(UTC).isoformat(),
            "routeSource": direct_segment["source"],
            "simulationScenario": request.simulationScenario,
            "optimization": {
                "strategy": "pareto-dynamic-weighted",
                "preferences": request.preferences.model_dump() if request.preferences else {"time": 0.35, "cost": 0.25, "batteryUsage": 0.2, "waitTime": 0.2},
                "frontierSize": 0,
                "tradeoffChart": [],
            },
        }

    return {
        "bestRoute": unique_candidates[0],
        "alternatives": unique_candidates[1:4],
        "paretoRoutes": pareto_routes,
        "directDistanceKm": round(direct_distance_km, 2),
        "feasible": True,
        "generatedAt": datetime.now(UTC).isoformat(),
        "routeSource": unique_candidates[0]["routeSource"],
        "simulationScenario": request.simulationScenario,
        "optimization": {
            "strategy": "pareto-dynamic-weighted",
            "preferences": request.preferences.model_dump() if request.preferences else {"time": 0.35, "cost": 0.25, "batteryUsage": 0.2, "waitTime": 0.2},
            "frontierSize": len(pareto_routes),
            "tradeoffChart": [
                {
                    "routeId": route["id"],
                    "label": route["label"],
                    "x": route["totalTravelMinutes"],
                    "y": route["totalChargingCost"],
                    "bubbleSize": max(14, round((1 - route["averageCongestion"]) * 28)),
                    "bubbleLabel": f"{len(route['stops'])} stop" if len(route["stops"]) == 1 else f"{len(route['stops'])} stops",
                }
                for route in unique_candidates
            ],
        },
    }


def nearby_stations(lat: float, lng: float, radius_km: float) -> dict[str, Any]:
    matches, live, provider = _nearby_live_stations({"lat": lat, "lng": lng}, radius_km)
    return {"stations": matches, "live": live, "provider": provider}


def station_forecast(station_id: str, departure_time: datetime, offset_minutes: float) -> dict[str, Any] | None:
    station = next((item for item in SEED_STATIONS if item.id == station_id), None)
    if station is None:
        return None
    return {"forecast": forecast_station(station, departure_time, offset_minutes)}

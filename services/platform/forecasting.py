from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from .domain import clamp, stable_hash_payload, traffic_multiplier
from .repository import Station

DEMAND_PROFILES: dict[str, dict[str, Any]] = {
    "metro_peak": {
        "hourlyDemand": [0.34, 0.28, 0.24, 0.22, 0.2, 0.26, 0.46, 0.72, 0.92, 0.98, 0.84, 0.76, 0.7, 0.72, 0.78, 0.83, 0.92, 1, 0.96, 0.88, 0.74, 0.6, 0.48, 0.4],
        "weekendDemand": 0.9,
        "priceElasticity": 1.12,
    },
    "commuter_corridor": {
        "hourlyDemand": [0.26, 0.22, 0.2, 0.18, 0.2, 0.28, 0.5, 0.7, 0.82, 0.76, 0.66, 0.62, 0.64, 0.68, 0.72, 0.8, 0.88, 0.92, 0.86, 0.78, 0.66, 0.52, 0.4, 0.3],
        "weekendDemand": 1.04,
        "priceElasticity": 1.02,
    },
    "business_district": {
        "hourlyDemand": [0.18, 0.16, 0.14, 0.12, 0.12, 0.2, 0.38, 0.58, 0.78, 0.9, 0.96, 0.92, 0.86, 0.84, 0.82, 0.8, 0.86, 0.9, 0.82, 0.66, 0.48, 0.34, 0.26, 0.2],
        "weekendDemand": 0.78,
        "priceElasticity": 1.08,
    },
    "destination_leisure": {
        "hourlyDemand": [0.22, 0.18, 0.16, 0.14, 0.16, 0.2, 0.26, 0.32, 0.4, 0.5, 0.62, 0.72, 0.8, 0.86, 0.9, 0.92, 0.94, 0.88, 0.76, 0.6, 0.46, 0.36, 0.28, 0.24],
        "weekendDemand": 1.16,
        "priceElasticity": 0.98,
    },
}


def forecast_cache_key(station_id: str, departure_time: datetime, offset_minutes: float) -> str:
    return stable_hash_payload(
        {
            "stationId": station_id,
            "departureTime": departure_time.isoformat(),
            "offsetMinutes": round(offset_minutes, 2),
        }
    )


def forecast_station(station: Station, departure: datetime, arrival_minutes: float) -> dict[str, Any]:
    arrival = departure + timedelta(minutes=arrival_minutes)
    hour = arrival.hour
    weekday = arrival.weekday()
    profile = DEMAND_PROFILES[station.demandProfile]
    profile_demand = profile["hourlyDemand"][hour]
    weekend_multiplier = profile["weekendDemand"] if weekday >= 5 else 1
    traffic = traffic_multiplier(hour)
    demand_index = clamp(profile_demand * weekend_multiplier * (0.86 + station.busyFactor * 0.42), 0.14, 1.35)
    area_pressure = 0.06 if station.areaType == "urban" else 0.04 if station.areaType == "highway" else 0.02
    reliability_bonus = (station.reliabilityScore - 0.75) * 0.22
    amenity_pull = 0.04 if station.amenityScore > 0.84 else 0
    availability_ratio = clamp(1 - demand_index * 0.72 - area_pressure + reliability_bonus - amenity_pull, 0.06, 0.97)
    available_ports = int(clamp(round(station.totalPorts * availability_ratio), 0, station.totalPorts))
    wait_minutes = round(
        clamp(
            (1 - availability_ratio) * 46
            + demand_index * 18
            + (traffic - 1) * 24
            + (1 - station.reliabilityScore) * 14,
            4,
            70,
        )
    )
    surge_multiplier = 1 + max(0, traffic - 1) * 0.65 + (demand_index - 0.4) * 0.35 + (profile["priceElasticity"] - 1)
    predicted_price = round(station.basePricePerKwh * station.priceSensitivity * surge_multiplier, 2)
    confidence = clamp(0.58 + station.reliabilityScore * 0.28 + (station.totalPorts / 12) * 0.12, 0.55, 0.95)
    return {
        "stationId": station.id,
        "availablePorts": available_ports,
        "availabilityRatio": round(availability_ratio, 2),
        "predictedWaitMinutes": wait_minutes,
        "currentPricePerKwh": station.basePricePerKwh,
        "predictedPricePerKwh": predicted_price,
        "trafficMultiplier": traffic,
        "timestamp": arrival.isoformat(),
        "confidence": round(confidence, 2),
        "demandIndex": round(demand_index, 2),
    }

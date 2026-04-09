from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Callable

from .domain import clamp, parse_datetime, road_distance_km, route_segment
from .models import TripRequest


def full_range_km(request: TripRequest) -> float:
    return request.vehicle.batteryCapacityKwh * request.vehicle.efficiencyKmPerKwh


def usable_range_km(request: TripRequest, soc: float) -> float:
    return full_range_km(request) * (soc / 100)


def weights(mode: str) -> dict[str, float]:
    if mode == "fastest":
        return {"distance": 0.18, "time": 0.34, "price": 0.12, "availability": 0.2, "detour": 0.16}
    if mode == "cheapest":
        return {"distance": 0.16, "time": 0.16, "price": 0.34, "availability": 0.18, "detour": 0.16}
    return {"distance": 0.2, "time": 0.26, "price": 0.2, "availability": 0.18, "detour": 0.16}


def build_stop(
    request: TripRequest,
    station: dict[str, Any],
    current_soc: float,
    segment_distance_km: float,
    next_leg_distance_km: float,
    forecast: dict[str, Any],
) -> dict[str, Any] | None:
    full_range = full_range_km(request)
    arrival_soc = round(current_soc - (segment_distance_km / full_range) * 100, 2)
    if arrival_soc <= request.reserveSoc:
        return None

    if station["connectorType"] != request.vehicle.connectorType or forecast["availablePorts"] <= 0:
        return None

    required_departure_soc = clamp(
        request.reserveSoc + (next_leg_distance_km / full_range) * 100 + 12,
        request.reserveSoc + 8,
        92,
    )
    charged_energy = max(0, (required_departure_soc - arrival_soc) / 100 * request.vehicle.batteryCapacityKwh)
    charging_power = min(request.vehicle.maxChargingPowerKw, station["maxPowerKw"])
    charging_minutes = round((charged_energy / charging_power) * 60 * 1.12) if charged_energy > 0 else 0
    charging_cost = round(charged_energy * forecast["predictedPricePerKwh"], 2)

    return {
        "station": station,
        "arrivalSoc": arrival_soc,
        "departureSoc": round(required_departure_soc, 2),
        "chargedEnergyKwh": round(charged_energy, 2),
        "chargingMinutes": charging_minutes,
        "chargingCost": charging_cost,
        "waitMinutes": forecast["predictedWaitMinutes"],
        "forecast": forecast,
    }


def route_option(
    request: TripRequest,
    label: str,
    geometry: list[dict[str, float]],
    stops: list[dict[str, Any]],
    direct_distance_km: float,
    total_distance_km: float,
    total_drive_minutes: float,
    route_source: str,
) -> dict[str, Any]:
    total_charging_minutes = sum(stop["chargingMinutes"] for stop in stops)
    total_wait_minutes = sum(stop["waitMinutes"] for stop in stops)
    total_travel_minutes = round(total_drive_minutes + total_charging_minutes + total_wait_minutes)
    total_cost = round(sum(stop["chargingCost"] for stop in stops), 2)
    detour = round(max(0, total_distance_km - direct_distance_km), 2)
    route_weights = weights(request.mode)
    avg_availability = 0.92 if not stops else sum(stop["forecast"]["availabilityRatio"] for stop in stops) / len(stops)
    raw_score = (
        100
        - total_distance_km * route_weights["distance"]
        - total_travel_minutes * route_weights["time"]
        - total_cost * route_weights["price"]
        - detour * route_weights["detour"]
        + avg_availability * 100 * route_weights["availability"]
    )
    score = round(clamp(raw_score, 1, 99), 1)
    return {
        "id": f"{label.lower().replace(' ', '-')}-{'-'.join(stop['station']['id'] for stop in stops) or 'direct'}",
        "label": label,
        "geometry": geometry,
        "routePolyline": "",
        "segments": [],
        "totalDistanceKm": round(total_distance_km, 2),
        "totalDriveMinutes": round(total_drive_minutes),
        "totalChargingMinutes": total_charging_minutes,
        "totalWaitMinutes": total_wait_minutes,
        "totalTravelMinutes": total_travel_minutes,
        "totalChargingCost": total_cost,
        "detourKm": detour,
        "finalSoc": round(stops[-1]["departureSoc"] if stops else request.startingSoc, 2),
        "minimumArrivalSoc": round(min([stop["arrivalSoc"] for stop in stops], default=request.startingSoc), 2),
        "safetyBufferSoc": request.safetyBufferSoc or request.reserveSoc,
        "trafficDelayMinutes": total_wait_minutes,
        "averageCongestion": round(1 - avg_availability, 2),
        "score": score,
        "routeSource": route_source,
        "explanation": {
            "distanceScore": round(max(0, 100 - total_distance_km * route_weights["distance"]), 1),
            "timeScore": round(max(0, 100 - total_travel_minutes * route_weights["time"]), 1),
            "priceScore": round(max(0, 100 - total_cost * route_weights["price"]), 1),
            "availabilityScore": round(min(100, (avg_availability * 20 * route_weights["availability"]) * 4), 1),
            "detourScore": round(max(0, 100 - detour * route_weights["detour"]), 1),
            "trafficScore": round(max(0, 100 - total_wait_minutes * 0.8), 1),
            "congestionScore": round(max(0, 100 - (1 - avg_availability) * 100), 1),
            "summary": "Direct route avoids charging uncertainty."
            if not stops
            else f"Route prioritizes available chargers and dynamic price efficiency under the {request.mode} profile.",
        },
        "stops": stops,
    }


def recommend_route(
    request: TripRequest,
    stations: list[dict[str, Any]],
    forecast_resolver: Callable[[str, float], dict[str, Any] | None],
) -> dict[str, Any]:
    departure_time = parse_datetime(request.departureTime)
    departure_hour = departure_time.hour
    origin = request.origin.model_dump()
    destination = request.destination.model_dump()
    direct_segment = route_segment(origin, destination, departure_hour)
    direct_distance_km = direct_segment["distanceKm"]
    direct_drive_minutes = direct_segment["durationMinutes"]
    initial_usable_range = usable_range_km(request, request.startingSoc - request.reserveSoc)
    candidates: list[dict[str, Any]] = []

    if initial_usable_range >= direct_distance_km:
        candidates.append(
            route_option(
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
        if station["connectorType"] == request.vehicle.connectorType
        and road_distance_km(origin, station["coordinates"]) <= initial_usable_range
    ]

    for station in first_leg_stations:
        first_segment = route_segment(origin, station["coordinates"], departure_hour)
        destination_segment = route_segment(station["coordinates"], destination, departure_hour)
        first_leg_km = first_segment["distanceKm"]
        remaining_to_destination_km = destination_segment["distanceKm"]
        first_leg_minutes = first_segment["durationMinutes"]
        first_forecast = forecast_resolver(station["id"], first_leg_minutes)
        if not first_forecast:
            continue
        first_stop = build_stop(
            request,
            station,
            request.startingSoc,
            first_leg_km,
            remaining_to_destination_km,
            first_forecast,
        )
        if not first_stop:
            continue

        range_after_charge = usable_range_km(request, first_stop["departureSoc"] - request.reserveSoc)
        if range_after_charge >= remaining_to_destination_km:
            candidates.append(
                route_option(
                    request,
                    "One-Stop Smart Route",
                    [*first_segment["geometry"][:-1], *destination_segment["geometry"]],
                    [first_stop],
                    direct_distance_km,
                    first_leg_km + remaining_to_destination_km,
                    first_leg_minutes + destination_segment["durationMinutes"],
                    "osrm" if first_segment["source"] == "osrm" or destination_segment["source"] == "osrm" else "heuristic",
                )
            )

        second_leg_stations = [
            next_station
            for next_station in stations
            if next_station["id"] != station["id"]
            and next_station["connectorType"] == request.vehicle.connectorType
            and road_distance_km(station["coordinates"], next_station["coordinates"]) <= range_after_charge
        ]

        for second_station in second_leg_stations:
            middle_segment = route_segment(station["coordinates"], second_station["coordinates"], departure_hour)
            final_segment = route_segment(second_station["coordinates"], destination, departure_hour)
            to_second_km = middle_segment["distanceKm"]
            second_arrival_offset = first_leg_minutes + first_stop["waitMinutes"] + first_stop["chargingMinutes"] + middle_segment["durationMinutes"]
            second_forecast = forecast_resolver(second_station["id"], second_arrival_offset)
            if not second_forecast:
                continue
            second_stop = build_stop(
                request,
                second_station,
                first_stop["departureSoc"],
                to_second_km,
                final_segment["distanceKm"],
                second_forecast,
            )
            if not second_stop:
                continue

            final_leg_km = final_segment["distanceKm"]
            if usable_range_km(request, second_stop["departureSoc"] - request.reserveSoc) < final_leg_km:
                continue

            candidates.append(
                route_option(
                    request,
                    "Two-Stop Resilient Route",
                    [*first_segment["geometry"][:-1], *middle_segment["geometry"][:-1], *final_segment["geometry"]],
                    [first_stop, second_stop],
                    direct_distance_km,
                    first_leg_km + to_second_km + final_leg_km,
                    first_leg_minutes + middle_segment["durationMinutes"] + final_segment["durationMinutes"],
                    "osrm"
                    if first_segment["source"] == "osrm" or middle_segment["source"] == "osrm" or final_segment["source"] == "osrm"
                    else "heuristic",
                )
            )

    unique_candidates = sorted({candidate["id"]: candidate for candidate in candidates}.values(), key=lambda item: item["score"], reverse=True)
    if not unique_candidates:
        return {
            "bestRoute": None,
            "alternatives": [],
            "directDistanceKm": round(direct_distance_km, 2),
            "feasible": False,
            "reason": "No feasible route was found. Increase starting SOC or choose a corridor with reachable compatible charging stations.",
            "generatedAt": datetime.now(UTC).isoformat(),
            "routeSource": direct_segment["source"],
        }

    return {
        "bestRoute": unique_candidates[0],
        "alternatives": unique_candidates[1:4],
        "directDistanceKm": round(direct_distance_km, 2),
        "feasible": True,
        "generatedAt": datetime.now(UTC).isoformat(),
        "routeSource": unique_candidates[0]["routeSource"],
    }

from __future__ import annotations

import unittest
from datetime import datetime

from services.ai.app import engine
from services.ai.app.engine import recommend_route, station_forecast
from services.ai.app.models import Coordinates, TripRequest, VehicleInput


engine.OSRM_URL = "http://127.0.0.1:9"
engine.MAPBOX_ACCESS_TOKEN = None


def build_request(
    *,
    origin: Coordinates,
    destination: Coordinates,
    starting_soc: float,
    departure_time: datetime,
    mode: str = "balanced",
) -> TripRequest:
    return TripRequest(
        origin=origin,
        destination=destination,
        departureTime=departure_time,
        startingSoc=starting_soc,
        reserveSoc=12,
        mode=mode,
        vehicle=VehicleInput(
            batteryCapacityKwh=75,
            efficiencyKmPerKwh=6.4,
            maxChargingPowerKw=90,
            connectorType="CCS2",
        ),
    )


class RoutingEngineTests(unittest.TestCase):
    def test_direct_route_is_feasible_when_soc_is_high(self):
        request = build_request(
            origin=Coordinates(lat=19.076, lng=72.8777, label="Mumbai"),
            destination=Coordinates(lat=18.5204, lng=73.8567, label="Pune"),
            starting_soc=90,
            departure_time=datetime.fromisoformat("2026-03-29T09:30:00"),
        )

        result = recommend_route(request)
        self.assertTrue(result["feasible"])
        self.assertIn("Route", result["bestRoute"]["label"])

    def test_route_uses_charging_stop_when_direct_trip_is_not_feasible(self):
        request = build_request(
            origin=Coordinates(lat=28.6139, lng=77.209, label="New Delhi"),
            destination=Coordinates(lat=26.8467, lng=80.9462, label="Lucknow"),
            starting_soc=42,
            departure_time=datetime.fromisoformat("2026-03-29T18:00:00"),
        )

        result = recommend_route(request)
        self.assertTrue(result["feasible"])
        self.assertGreaterEqual(len(result["bestRoute"]["stops"]), 1)

    def test_low_soc_can_make_route_infeasible(self):
        request = build_request(
            origin=Coordinates(lat=28.6139, lng=77.209, label="New Delhi"),
            destination=Coordinates(lat=13.0827, lng=80.2707, label="Chennai"),
            starting_soc=18,
            departure_time=datetime.fromisoformat("2026-03-29T08:00:00"),
        )

        result = recommend_route(request)
        self.assertFalse(result["feasible"])

    def test_time_of_day_changes_route_metrics(self):
        base_args = {
            "origin": Coordinates(lat=19.076, lng=72.8777, label="Mumbai"),
            "destination": Coordinates(lat=18.5204, lng=73.8567, label="Pune"),
            "starting_soc": 55,
        }
        peak = build_request(
            departure_time=datetime.fromisoformat("2026-03-29T18:00:00"),
            **base_args,
        )
        late_night = build_request(
            departure_time=datetime.fromisoformat("2026-03-29T23:00:00"),
            **base_args,
        )

        peak_result = recommend_route(peak)
        night_result = recommend_route(late_night)

        self.assertGreater(peak_result["bestRoute"]["totalTravelMinutes"], night_result["bestRoute"]["totalTravelMinutes"])

    def test_forecast_contains_confidence_and_demand_signals(self):
        result = station_forecast(
            "st-delhi-01",
            datetime.fromisoformat("2026-03-29T09:00:00"),
            35,
        )
        assert result is not None
        forecast = result["forecast"]
        self.assertIn("confidence", forecast)
        self.assertIn("demandIndex", forecast)
        self.assertIn("predictedPricePerKwh", forecast)

    def test_route_tracks_polyline_and_traffic_metrics(self):
        request = build_request(
            origin=Coordinates(lat=19.076, lng=72.8777, label="Mumbai"),
            destination=Coordinates(lat=18.5204, lng=73.8567, label="Pune"),
            starting_soc=90,
            departure_time=datetime.fromisoformat("2026-03-29T18:00:00"),
        )

        result = recommend_route(request)
        best_route = result["bestRoute"]
        self.assertIn("routePolyline", best_route)
        self.assertIn("trafficDelayMinutes", best_route)
        self.assertIn("averageCongestion", best_route)


if __name__ == "__main__":
    unittest.main()

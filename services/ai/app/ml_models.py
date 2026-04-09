from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(max(value, minimum), maximum)


def traffic_multiplier(hour: int) -> float:
    if 8 <= hour <= 10 or 17 <= hour <= 21:
        return 1.35
    if 11 <= hour <= 16:
        return 1.12
    if hour >= 22 or hour <= 5:
        return 0.9
    return 1.0


def _area_pressure(area_type: str) -> float:
    if area_type == "urban":
        return 0.08
    if area_type == "highway":
        return 0.05
    return 0.03


def _encode_features(snapshot: dict[str, Any]) -> list[float]:
    hour = snapshot["hour"]
    weekday = snapshot["weekday"]
    angle_hour = 2 * math.pi * hour / 24
    angle_weekday = 2 * math.pi * weekday / 7
    profile = snapshot["demandProfile"]
    area_type = snapshot["areaType"]
    return [
        1.0,
        math.sin(angle_hour),
        math.cos(angle_hour),
        math.sin(angle_weekday),
        math.cos(angle_weekday),
        1.0 if weekday >= 5 else 0.0,
        snapshot["busyFactor"],
        snapshot["priceSensitivity"],
        snapshot["reliabilityScore"],
        snapshot["amenityScore"],
        snapshot["totalPorts"] / 12,
        snapshot["maxPowerKw"] / 150,
        traffic_multiplier(hour),
        1.0 if profile == "metro_peak" else 0.0,
        1.0 if profile == "commuter_corridor" else 0.0,
        1.0 if profile == "business_district" else 0.0,
        1.0 if profile == "destination_leisure" else 0.0,
        1.0 if area_type == "urban" else 0.0,
        1.0 if area_type == "highway" else 0.0,
        1.0 if area_type == "suburban" else 0.0,
    ]


@dataclass
class StandardScaler:
    means: list[float]
    scales: list[float]

    @classmethod
    def fit(cls, rows: list[list[float]]) -> "StandardScaler":
        columns = list(zip(*rows))
        means: list[float] = []
        scales: list[float] = []
        for index, column in enumerate(columns):
            if index == 0:
                means.append(0.0)
                scales.append(1.0)
                continue
            mean = sum(column) / len(column)
            variance = sum((value - mean) ** 2 for value in column) / max(1, len(column))
            means.append(mean)
            scales.append(math.sqrt(variance) or 1.0)
        return cls(means=means, scales=scales)

    def transform(self, row: list[float]) -> list[float]:
        scaled = [row[0]]
        for index in range(1, len(row)):
            scaled.append((row[index] - self.means[index]) / self.scales[index])
        return scaled

    def transform_rows(self, rows: list[list[float]]) -> list[list[float]]:
        return [self.transform(row) for row in rows]


@dataclass
class LinearRegressionModel:
    weights: list[float]

    @classmethod
    def fit(cls, x_rows: list[list[float]], y_values: list[float], *, learning_rate: float = 0.05, epochs: int = 60) -> "LinearRegressionModel":
        weights = [0.0] * len(x_rows[0])
        sample_count = len(x_rows)
        for _ in range(epochs):
            gradients = [0.0] * len(weights)
            for row, target in zip(x_rows, y_values, strict=False):
                prediction = sum(weight * value for weight, value in zip(weights, row, strict=False))
                error = prediction - target
                for index, value in enumerate(row):
                    gradients[index] += error * value
            for index in range(len(weights)):
                weights[index] -= learning_rate * (gradients[index] / sample_count)
        return cls(weights=weights)

    def predict(self, row: list[float]) -> float:
        return sum(weight * value for weight, value in zip(self.weights, row, strict=False))


@dataclass
class LogisticRegressionModel:
    weights: list[float]

    @classmethod
    def fit(cls, x_rows: list[list[float]], y_values: list[float], *, learning_rate: float = 0.09, epochs: int = 70) -> "LogisticRegressionModel":
        weights = [0.0] * len(x_rows[0])
        sample_count = len(x_rows)
        for _ in range(epochs):
            gradients = [0.0] * len(weights)
            for row, target in zip(x_rows, y_values, strict=False):
                raw = sum(weight * value for weight, value in zip(weights, row, strict=False))
                prediction = 1 / (1 + math.exp(-clamp(raw, -40, 40)))
                error = prediction - target
                for index, value in enumerate(row):
                    gradients[index] += error * value
            for index in range(len(weights)):
                weights[index] -= learning_rate * (gradients[index] / sample_count)
        return cls(weights=weights)

    def predict_proba(self, row: list[float]) -> float:
        raw = sum(weight * value for weight, value in zip(self.weights, row, strict=False))
        return 1 / (1 + math.exp(-clamp(raw, -40, 40)))


def _simulate_row(station: dict[str, Any], timestamp: datetime, rnd: random.Random) -> dict[str, Any]:
    hour = timestamp.hour
    weekday = timestamp.weekday()
    weekend_multiplier = 1.12 if weekday >= 5 else 1.0
    profile_peaks = {
        "metro_peak": 17,
        "commuter_corridor": 9,
        "business_district": 11,
        "destination_leisure": 15,
    }
    peak_hour = profile_peaks[station["demandProfile"]]
    peak_distance = min(abs(hour - peak_hour), 24 - abs(hour - peak_hour))
    cyclical_demand = 1 - (peak_distance / 12)
    traffic = traffic_multiplier(hour)
    random_noise = rnd.uniform(-0.08, 0.08)
    demand_index = clamp(
        0.28
        + cyclical_demand * 0.46
        + station["busyFactor"] * 0.34
        + (traffic - 1) * 0.44
        + weekend_multiplier * 0.05
        + random_noise,
        0.08,
        1.55,
    )
    raw_ratio = (
        1.18
        - demand_index * 0.63
        - _area_pressure(station["areaType"])
        + (station["reliabilityScore"] - 0.75) * 0.34
        - station["amenityScore"] * 0.06
        + (station["totalPorts"] / 12) * 0.16
        + rnd.uniform(-0.09, 0.09)
    )
    availability_ratio = clamp(raw_ratio, 0.03, 0.98)
    available_ports = int(clamp(round(station["totalPorts"] * availability_ratio), 0, station["totalPorts"]))
    price = clamp(
        station["basePricePerKwh"]
        * station["priceSensitivity"]
        * (
            0.88
            + demand_index * 0.44
            + (traffic - 1) * 0.52
            + (1 - station["reliabilityScore"]) * 0.1
            + rnd.uniform(-0.05, 0.05)
        ),
        station["basePricePerKwh"] * 0.8,
        station["basePricePerKwh"] * 2.4,
    )
    return {
        "stationId": station["id"],
        "timestamp": timestamp.isoformat(),
        "hour": hour,
        "weekday": weekday,
        "busyFactor": station["busyFactor"],
        "priceSensitivity": station["priceSensitivity"],
        "reliabilityScore": station["reliabilityScore"],
        "amenityScore": station["amenityScore"],
        "totalPorts": station["totalPorts"],
        "maxPowerKw": station["maxPowerKw"],
        "demandProfile": station["demandProfile"],
        "areaType": station["areaType"],
        "demandIndex": round(demand_index, 4),
        "availabilityRatio": round(availability_ratio, 4),
        "availablePorts": available_ports,
        "hasAvailability": 1 if available_ports > 0 else 0,
        "actualPricePerKwh": round(price, 4),
    }


def ensure_historical_dataset(stations: list[Any], *, history_days: int = 7) -> Path:
    root = Path(__file__).resolve().parents[1]
    data_dir = root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    dataset_path = data_dir / "historical_station_metrics.jsonl"
    expected_rows = history_days * 24 * len(stations)
    if dataset_path.exists():
        existing_rows = sum(1 for line in dataset_path.read_text().splitlines() if line.strip())
        if existing_rows == expected_rows:
            return dataset_path

    rnd = random.Random(7)
    end = datetime(2026, 3, 29, 0, 0, 0)
    rows: list[str] = []
    for day in range(history_days):
        for hour in range(24):
            timestamp = end - timedelta(days=day, hours=(23 - hour))
            for station in stations:
                row = _simulate_row(station.__dict__ if hasattr(station, "__dict__") else station, timestamp, rnd)
                rows.append(json.dumps(row))
    dataset_path.write_text("\n".join(rows) + "\n")
    return dataset_path


def _load_history(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


@dataclass
class HistoricalComparison:
    sample_count: int
    avg_actual_availability_ratio: float
    avg_actual_price_per_kwh: float


@dataclass
class ForecastModels:
    scaler: StandardScaler
    availability_classifier: LogisticRegressionModel
    availability_regressor: LinearRegressionModel
    price_regressor: LinearRegressionModel
    validation_metrics: dict[str, float]
    historical_rows: list[dict[str, Any]]

    def snapshot_features(self, station: Any, when: datetime) -> dict[str, Any]:
        return {
            "stationId": station.id,
            "hour": when.hour,
            "weekday": when.weekday(),
            "busyFactor": station.busyFactor,
            "priceSensitivity": station.priceSensitivity,
            "reliabilityScore": station.reliabilityScore,
            "amenityScore": station.amenityScore,
            "totalPorts": station.totalPorts,
            "maxPowerKw": station.maxPowerKw,
            "demandProfile": station.demandProfile,
            "areaType": station.areaType,
        }

    def compare_with_history(self, station: Any, when: datetime) -> HistoricalComparison | None:
        hour = when.hour
        weekday = when.weekday()
        matching = [
            row
            for row in self.historical_rows
            if row["stationId"] == station.id and row["hour"] == hour and row["weekday"] == weekday
        ]
        if not matching:
            return None
        return HistoricalComparison(
            sample_count=len(matching),
            avg_actual_availability_ratio=sum(item["availabilityRatio"] for item in matching) / len(matching),
            avg_actual_price_per_kwh=sum(item["actualPricePerKwh"] for item in matching) / len(matching),
        )

    def predict(self, station: Any, when: datetime) -> dict[str, Any]:
        snapshot = self.snapshot_features(station, when)
        encoded = self.scaler.transform(_encode_features(snapshot))
        probability_available = self.availability_classifier.predict_proba(encoded)
        raw_availability = self.availability_regressor.predict(encoded)
        availability_ratio = clamp(raw_availability * (0.72 + probability_available * 0.28), 0.02, 0.99)
        if probability_available < 0.32:
            availability_ratio = min(availability_ratio, 0.18)
        available_ports = int(clamp(round(station.totalPorts * availability_ratio), 0, station.totalPorts))
        raw_price = self.price_regressor.predict(encoded)
        price = clamp(raw_price, station.basePricePerKwh * 0.75, station.basePricePerKwh * 2.5)
        comparison = self.compare_with_history(station, when)
        availability_confidence = clamp(
            0.52
            + abs(probability_available - 0.5) * 0.7
            + (1 - self.validation_metrics["availability_mae"]) * 0.16,
            0.5,
            0.97,
        )
        price_confidence = clamp(
            0.48
            + (1 - min(1.0, self.validation_metrics["price_mae"] / max(1.0, station.basePricePerKwh))) * 0.36
            + station.reliabilityScore * 0.16,
            0.48,
            0.94,
        )
        comparison_payload = None
        if comparison:
            comparison_payload = {
                "historicalSamples": comparison.sample_count,
                "avgActualAvailabilityRatio": round(comparison.avg_actual_availability_ratio, 2),
                "avgActualPricePerKwh": round(comparison.avg_actual_price_per_kwh, 2),
                "availabilityDelta": round(availability_ratio - comparison.avg_actual_availability_ratio, 2),
                "priceDelta": round(price - comparison.avg_actual_price_per_kwh, 2),
            }
        return {
            "probabilityAvailable": round(probability_available, 3),
            "availabilityRatio": round(availability_ratio, 2),
            "availablePorts": available_ports,
            "predictedPricePerKwh": round(price, 2),
            "availabilityConfidence": round(availability_confidence, 2),
            "priceConfidence": round(price_confidence, 2),
            "comparison": comparison_payload,
            "validation": {
                "availabilityMae": round(self.validation_metrics["availability_mae"], 3),
                "availabilityAccuracy": round(self.validation_metrics["availability_accuracy"], 3),
                "priceMae": round(self.validation_metrics["price_mae"], 3),
            },
        }


def train_forecast_models(stations: list[Any]) -> ForecastModels:
    dataset_path = ensure_historical_dataset(stations)
    rows = _load_history(dataset_path)
    split_index = int(len(rows) * 0.8)
    train_rows = rows[:split_index]
    validation_rows = rows[split_index:]

    train_features = [_encode_features(row) for row in train_rows]
    scaler = StandardScaler.fit(train_features)
    train_x = scaler.transform_rows(train_features)
    classifier = LogisticRegressionModel.fit(train_x, [row["hasAvailability"] for row in train_rows])
    availability_regressor = LinearRegressionModel.fit(train_x, [row["availabilityRatio"] for row in train_rows])
    price_regressor = LinearRegressionModel.fit(train_x, [row["actualPricePerKwh"] for row in train_rows])

    validation_x = scaler.transform_rows([_encode_features(row) for row in validation_rows])
    availability_errors: list[float] = []
    availability_hits = 0
    price_errors: list[float] = []
    for row, features in zip(validation_rows, validation_x, strict=False):
        availability_prediction = clamp(availability_regressor.predict(features), 0.0, 1.0)
        price_prediction = price_regressor.predict(features)
        probability_available = classifier.predict_proba(features)
        availability_errors.append(abs(availability_prediction - row["availabilityRatio"]))
        price_errors.append(abs(price_prediction - row["actualPricePerKwh"]))
        availability_hits += 1 if (probability_available >= 0.5) == bool(row["hasAvailability"]) else 0

    metrics = {
        "availability_mae": sum(availability_errors) / len(availability_errors),
        "availability_accuracy": availability_hits / len(validation_rows),
        "price_mae": sum(price_errors) / len(price_errors),
    }
    return ForecastModels(
        scaler=scaler,
        availability_classifier=classifier,
        availability_regressor=availability_regressor,
        price_regressor=price_regressor,
        validation_metrics=metrics,
        historical_rows=rows,
    )


def log_prediction(payload: dict[str, Any]) -> None:
    root = Path(__file__).resolve().parents[1]
    data_dir = root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    log_file = data_dir / "prediction_logs.jsonl"
    with log_file.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload) + "\n")

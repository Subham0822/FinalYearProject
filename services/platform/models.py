from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class Coordinates(BaseModel):
    lat: float
    lng: float
    label: str | None = None


class VehicleInput(BaseModel):
    batteryCapacityKwh: float = Field(gt=0)
    efficiencyKmPerKwh: float = Field(gt=0)
    maxChargingPowerKw: float = Field(gt=0)
    connectorType: str


class TripRequest(BaseModel):
    origin: Coordinates
    destination: Coordinates
    departureTime: str
    startingSoc: float = Field(ge=0, le=100)
    reserveSoc: float = Field(ge=0, le=100)
    safetyBufferSoc: float | None = Field(default=None, ge=0, le=100)
    simulateAcUsage: bool | None = None
    vehicle: VehicleInput
    mode: Literal["balanced", "fastest", "cheapest"] = "balanced"


class ForecastBatchItem(BaseModel):
    stationId: str
    offsetMinutes: float = 0


class ForecastBatchRequest(BaseModel):
    departureTime: str
    items: list[ForecastBatchItem]


class ServiceHealth(BaseModel):
    service: str
    status: Literal["ok", "degraded"]
    cache: str | None = None
    dependencies: dict[str, Any] | None = None

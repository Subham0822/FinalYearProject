from __future__ import annotations

from datetime import datetime
from typing import Literal

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


class LiveContext(BaseModel):
    refreshToken: str | None = None


class OptimizationPreferences(BaseModel):
    time: float = Field(default=0.35, ge=0)
    cost: float = Field(default=0.25, ge=0)
    batteryUsage: float = Field(default=0.2, ge=0)
    waitTime: float = Field(default=0.2, ge=0)


class TripRequest(BaseModel):
    origin: Coordinates
    destination: Coordinates
    departureTime: datetime
    startingSoc: float = Field(ge=0, le=100)
    reserveSoc: float = Field(ge=0, le=100)
    safetyBufferSoc: float = Field(default=5, ge=0, le=25)
    simulateAcUsage: bool = True
    vehicle: VehicleInput
    mode: Literal["balanced", "fastest", "cheapest"] = "balanced"
    preferences: OptimizationPreferences | None = None
    liveContext: LiveContext | None = None
    simulationScenario: Literal["baseline", "peak_traffic", "high_station_demand", "price_surge"] = "baseline"

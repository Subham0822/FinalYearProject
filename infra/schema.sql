CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  operator TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  charger_type TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  max_power_kw NUMERIC NOT NULL,
  total_ports INTEGER NOT NULL,
  base_price_per_kwh NUMERIC NOT NULL,
  busy_factor NUMERIC NOT NULL,
  price_sensitivity NUMERIC NOT NULL,
  coordinates GEOGRAPHY(POINT, 4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS station_dynamic_states (
  id BIGSERIAL PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  timestamp_utc TIMESTAMPTZ NOT NULL,
  available_ports INTEGER NOT NULL,
  availability_ratio NUMERIC NOT NULL,
  predicted_wait_minutes NUMERIC NOT NULL,
  current_price_per_kwh NUMERIC NOT NULL,
  predicted_price_per_kwh NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
  id UUID PRIMARY KEY,
  origin GEOGRAPHY(POINT, 4326) NOT NULL,
  destination GEOGRAPHY(POINT, 4326) NOT NULL,
  departure_time TIMESTAMPTZ NOT NULL,
  starting_soc NUMERIC NOT NULL,
  reserve_soc NUMERIC NOT NULL,
  mode TEXT NOT NULL,
  total_distance_km NUMERIC,
  total_travel_minutes NUMERIC,
  total_charging_cost NUMERIC,
  best_route JSONB
);

CREATE TABLE IF NOT EXISTS recommendation_sessions (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mode TEXT NOT NULL,
  origin_label TEXT,
  destination_label TEXT,
  request_payload JSONB NOT NULL,
  response_payload JSONB NOT NULL,
  feasible BOOLEAN NOT NULL,
  best_route_id TEXT,
  route_source TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS recommendation_routes (
  id BIGSERIAL PRIMARY KEY,
  recommendation_id UUID NOT NULL REFERENCES recommendation_sessions(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL,
  label TEXT NOT NULL,
  rank_index INTEGER NOT NULL,
  is_best BOOLEAN NOT NULL DEFAULT FALSE,
  total_distance_km NUMERIC NOT NULL,
  total_drive_minutes NUMERIC NOT NULL,
  total_charging_minutes NUMERIC NOT NULL,
  total_wait_minutes NUMERIC NOT NULL,
  total_travel_minutes NUMERIC NOT NULL,
  total_charging_cost NUMERIC NOT NULL,
  detour_km NUMERIC NOT NULL,
  score NUMERIC NOT NULL,
  route_source TEXT NOT NULL,
  route_payload JSONB NOT NULL,
  UNIQUE (recommendation_id, route_id)
);

CREATE TABLE IF NOT EXISTS route_selection_events (
  id UUID PRIMARY KEY,
  recommendation_id UUID NOT NULL REFERENCES recommendation_sessions(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL,
  route_label TEXT NOT NULL,
  selection_source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS route_feedback (
  id UUID PRIMARY KEY,
  recommendation_id UUID NOT NULL REFERENCES recommendation_sessions(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed BOOLEAN NOT NULL,
  satisfaction_score INTEGER,
  actual_travel_minutes NUMERIC,
  actual_charging_cost NUMERIC,
  actual_wait_minutes NUMERIC,
  actual_distance_km NUMERIC,
  actual_charging_stops NUMERIC,
  notes TEXT,
  UNIQUE (recommendation_id, route_id)
);

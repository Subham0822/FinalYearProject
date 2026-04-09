# VoltPath AI

VoltPath AI is a topic-focused EV routing application that recommends routes using:

- distance
- time of day
- charging-station location and reachability
- forecasted charging availability
- dynamic charging prices

The project is split into:

- a `Next.js` frontend and thin API adapter layer
- a Python microservice backend behind an API gateway
- live Open Charge Map integration with seeded fallback data
- PostgreSQL/PostGIS schema for geo-ready persistence

## Core features

- route planning between Indian cities
- EV-specific trip inputs: SOC, reserve SOC, battery capacity, efficiency, charging power
- ranked route recommendations
- direct, one-stop, and two-stop route generation
- live corridor-based charging-station discovery
- connector compatibility filtering across route planning and nearby-station lookup
- real-time operational status ingestion when the upstream provider exposes it
- derived reliability scoring based on verification freshness, operational status, and port redundancy
- time-sensitive availability and price forecasting
- ML-backed availability classification/regression and price regression
- optional real-road routing via OSRM with automatic fallback
- profile-driven station forecasting using hour, weekday, reliability, and corridor behavior
- explainable scoring for distance, time, price, and availability
- map-based route and charging-stop visualization

## Project structure

```text
app/                        Next.js app router pages and API routes
components/                 React UI and map components
lib/                        shared TypeScript routing logic and gateway adapters
data/                       seeded station dataset
services/api_gateway/       frontend-facing API gateway
services/data_service/      station catalog and geo lookup service
services/forecasting_service/ charging forecast service with Redis caching
services/routing_service/   route orchestration service
services/platform/          shared Python domain logic
services/ai/                legacy single-service AI module
infra/                      PostGIS schema
```

## Scalable backend architecture

The backend is now split into independently deployable services:

- `api-gateway`: single entry point used by the frontend
- `data-service`: serves station catalog and nearby-station queries
- `forecasting-service`: predicts charger availability, wait time, and price
- `routing-service`: composes data and forecast responses into route recommendations

Production-oriented upgrades included in this refactor:

- API gateway pattern for frontend traffic
- Redis-backed caching for forecast and route responses
- service-level health endpoints for readiness checks
- Dockerized backend orchestration for local and deployment parity

## Run the frontend

1. Install dependencies:

```bash
npm install
```

2. Start Next.js:

```bash
npm run dev
```

The frontend calls the API gateway when it is running. If the gateway is unavailable, the Next.js API routes still fall back to the local TypeScript routing engine so the app remains usable in development.

To enable more realistic road distances and travel times, set:

```bash
OSRM_URL=https://router.project-osrm.org
```

To enable live charging-station data from Open Charge Map, optionally set:

```bash
OPEN_CHARGE_MAP_API_KEY=your_api_key
OPEN_CHARGE_MAP_COUNTRY_CODE=IN
```

If OSRM is unavailable, the app falls back automatically to the local heuristic route model.
If the live station feed is unavailable, the app falls back automatically to the bundled seed dataset.

## Run the backend microservices

1. Create a virtual environment if you want:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

2. Install Python dependencies:

```bash
python3 -m pip install -r services/requirements.txt
```

3. Start the backend services in separate terminals:

```bash
uvicorn services.data_service.main:app --reload --port 8001
uvicorn services.forecasting_service.main:app --reload --port 8002
uvicorn services.routing_service.main:app --reload --port 8003
uvicorn services.api_gateway.main:app --reload --port 8000
```

The API gateway exposes:

- `POST /route/recommend`
- `GET /stations/nearby`
- `GET /forecast/station/{id}`

Each backend service also exposes its own `/health` endpoint for readiness checks and infrastructure monitoring.

## Run tests

```bash
python3 -m unittest discover services/ai/tests
```

## Database and cache

The repo includes:

- `docker-compose.yml` for PostgreSQL/PostGIS, Redis, and all backend services
- `infra/schema.sql` with a starter geo-aware schema

Start infrastructure with:

```bash
docker compose up -d api-gateway data-service forecasting-service routing-service postgres redis
```

Set the frontend gateway URL with:

```bash
API_GATEWAY_URL=http://127.0.0.1:8000
```

## Recommended next upgrades

- replace simulated telemetry with real charger utilization and tariff history
- connect data-service to PostgreSQL/PostGIS instead of the seeded JSON file
- use live routing geometry from OSRM, Mapbox Directions, or OpenRouteService
- feed logged predictions back into periodic retraining and actual-vs-predicted evaluation

## Repository standards

This repository includes:

- `LICENSE` (MIT)
- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- GitHub issue and pull request templates in `.github/`

## Publish to GitHub

If you are starting from a local folder:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```

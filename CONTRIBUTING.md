# Contributing

Thanks for contributing to VoltPath AI.

## Development setup

1. Fork and clone the repository.
2. Install frontend dependencies:
   - `npm install`
3. Create and populate environment variables:
   - `cp .env.example .env.local`
4. (Optional) Set up Python virtual environment and backend dependencies:
   - `python3 -m venv .venv`
   - `source .venv/bin/activate`
   - `python3 -m pip install -r services/requirements.txt`

## Run locally

- Frontend:
  - `npm run dev`
- Backend services (separate terminals):
  - `uvicorn services.data_service.main:app --reload --port 8001`
  - `uvicorn services.forecasting_service.main:app --reload --port 8002`
  - `uvicorn services.routing_service.main:app --reload --port 8003`
  - `uvicorn services.api_gateway.main:app --reload --port 8000`

## Pull request checklist

- Keep PRs focused and scoped.
- Add or update tests for behavior changes.
- Run validation before opening PR:
  - `npm run lint`
  - `npm run build`
  - `python3 -m unittest discover services/ai/tests`
- Update `README.md` and `.env.example` if configuration changes.

## Commit style

Use clear, imperative commit messages, for example:

- `feat: add connector-aware route scoring`
- `fix: handle empty station responses in gateway`
- `docs: update local setup steps`

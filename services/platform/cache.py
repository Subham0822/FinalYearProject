from __future__ import annotations

import json
import os
from typing import Any

try:
    from redis import Redis
    from redis.exceptions import RedisError
except Exception:  # pragma: no cover
    Redis = None  # type: ignore[assignment]

    class RedisError(Exception):
        pass


class JsonCache:
    def __init__(self, namespace: str):
        self.namespace = namespace
        self.redis_url = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
        self._client: Redis | None = None  # type: ignore[type-arg]

    def _connect(self) -> Redis | None:  # type: ignore[type-arg]
        if Redis is None:
            return None
        if self._client is None:
            try:
                self._client = Redis.from_url(self.redis_url, decode_responses=True)
                self._client.ping()
            except RedisError:
                self._client = None
        return self._client

    def _key(self, key: str) -> str:
        return f"{self.namespace}:{key}"

    def get_json(self, key: str) -> dict[str, Any] | None:
        client = self._connect()
        if client is None:
            return None
        try:
            raw = client.get(self._key(key))
        except RedisError:
            return None
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def set_json(self, key: str, value: dict[str, Any], ttl_seconds: int) -> None:
        client = self._connect()
        if client is None:
            return
        try:
            client.setex(self._key(key), ttl_seconds, json.dumps(value, separators=(",", ":")))
        except RedisError:
            return

    def status(self) -> str:
        return "redis" if self._connect() is not None else "disabled"

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


def fetch_json(url: str, *, method: str = "GET", payload: dict[str, Any] | None = None, timeout: float = 4.0) -> dict[str, Any]:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def try_fetch_json(
    url: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: float = 4.0,
) -> dict[str, Any] | None:
    try:
        return fetch_json(url, method=method, payload=payload, timeout=timeout)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None

import socket
import json
import os
import time
import asyncio
import threading
from typing import Callable, Optional

class GICSClient:
    """
    A zero-dependency Python client for the GICS Daemon.
    Supports Unix Sockets (Linux/Mac) and Named Pipes (Windows).
    """

    def __init__(
        self,
        address=None,
        token=None,
        max_retries=3,
        retry_delay=0.1,
        request_timeout=5.0,
        pool_size=4,
    ):
        """
        :param address: Path to the socket or named pipe. 
                        Defaults to /tmp/gics.sock or \\.\\pipe\\gics.
        :param token: Security token from .gics_token.
        """
        if address is None:
            if os.name == 'nt':
                self.address = r'\\.\pipe\gics'
            else:
                self.address = '/tmp/gics.sock'
        else:
            self.address = address

        self._token = token
        self._request_id = 1
        self._max_retries = max_retries
        self._retry_delay = retry_delay
        self._request_timeout = request_timeout
        self._pool_size = max(1, int(pool_size))
        self._pool = []
        self._pool_lock = threading.Lock()
        self._request_id_lock = threading.Lock()

    def _next_request_id(self):
        with self._request_id_lock:
            rid = self._request_id
            self._request_id += 1
            return rid

    def _get_token(self):
        if self._token:
            return self._token
        
        # Try to find .gics_token in current or parent dirs
        paths = [
            '.gics_token',
            os.path.expanduser('~/.gics_token'),
            '../.gics_token'
        ]
        for p in paths:
            if os.path.exists(p):
                with open(p, 'r') as f:
                    self._token = f.read().strip()
                    return self._token
        return None

    def _open_unix_socket(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self._request_timeout)
        s.connect(self.address)
        return s

    def _acquire_unix_socket(self):
        with self._pool_lock:
            if self._pool:
                return self._pool.pop()
        return self._open_unix_socket()

    def _release_unix_socket(self, s, healthy=True):
        if s is None:
            return

        if not healthy:
            try:
                s.close()
            except OSError:
                pass
            return

        with self._pool_lock:
            if len(self._pool) < self._pool_size:
                self._pool.append(s)
                return

        try:
            s.close()
        except OSError:
            pass

    def close(self):
        with self._pool_lock:
            sockets = self._pool
            self._pool = []

        for s in sockets:
            try:
                s.close()
            except OSError:
                pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()

    def _call(self, method, params=None):
        params = params or {}
        request = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": self._next_request_id(),
            "token": self._get_token()
        }

        payload = (json.dumps(request) + '\n').encode('utf-8')

        last_error = None
        for attempt in range(self._max_retries + 1):
            try:
                if os.name == 'nt':
                    # Windows Named Pipe
                    with open(self.address, 'r+b', buffering=0) as f:
                        f.write(payload)
                        response_line = f.readline()
                        return json.loads(response_line.decode('utf-8'))
                else:
                    # Unix Socket with basic connection pooling + auto-reconnect.
                    s = None
                    healthy = True
                    try:
                        s = self._acquire_unix_socket()
                        try:
                            s.sendall(payload)

                            buffer = b""
                            while True:
                                chunk = s.recv(4096)
                                if not chunk:
                                    # Socket closed by daemon, force reconnect on next attempt.
                                    healthy = False
                                    raise ConnectionResetError("Daemon closed IPC socket")
                                buffer += chunk
                                if b'\n' in buffer:
                                    break

                            response_line = buffer.split(b'\n')[0]
                            return json.loads(response_line.decode('utf-8'))
                        except (OSError, ConnectionError, TimeoutError, json.JSONDecodeError):
                            healthy = False
                            raise
                    finally:
                        self._release_unix_socket(s, healthy=healthy)
            except (FileNotFoundError, ConnectionRefusedError, OSError, json.JSONDecodeError) as e:
                last_error = e
                if attempt < self._max_retries:
                    time.sleep(self._retry_delay)
                else:
                    raise

        raise last_error

    async def _acall(self, method, params=None):
        return await asyncio.to_thread(self._call, method, params)

    def _unwrap_result(self, response: dict):
        if response.get('error'):
            code = response['error'].get('code', -1)
            message = response['error'].get('message', 'Unknown error')
            raise RuntimeError(f"GICS error {code}: {message}")
        return response.get('result')

    def put(self, key, fields):
        resp = self._call("put", {"key": key, "fields": fields})
        return self._unwrap_result(resp).get('ok', False)

    def get(self, key):
        resp = self._call("get", {"key": key})
        return self._unwrap_result(resp)

    def delete(self, key):
        resp = self._call("delete", {"key": key})
        return self._unwrap_result(resp).get('ok', False)

    def scan(self, prefix="", tiers="all", include_system=False, limit=None, cursor=None, mode="current"):
        params = {"prefix": prefix, "tiers": tiers, "includeSystem": include_system, "mode": mode}
        if limit is not None:
            params["limit"] = limit
        if cursor is not None:
            params["cursor"] = cursor
        resp = self._call("scan", params)
        return self._unwrap_result(resp).get('items', [])

    def flush(self):
        resp = self._call("flush")
        return self._unwrap_result(resp)

    def compact(self):
        resp = self._call("compact")
        return self._unwrap_result(resp)

    def rotate(self):
        resp = self._call("rotate")
        return self._unwrap_result(resp)

    def verify(self, tier=None):
        params = {}
        if tier is not None:
            params["tier"] = tier
        resp = self._call("verify", params)
        return self._unwrap_result(resp)

    def get_insight(self, key):
        resp = self._call("getInsight", {"key": key})
        return self._unwrap_result(resp)

    def get_insights(self, insight_type=None):
        params = {}
        if insight_type:
            params["type"] = insight_type
        resp = self._call("getInsights", params)
        return self._unwrap_result(resp)

    def report_outcome(self, insight_id, result, context=None):
        params = {"insightId": insight_id, "result": result}
        if context is not None:
            params["context"] = context
        resp = self._call("reportOutcome", params)
        return self._unwrap_result(resp).get('ok', False)

    def get_correlations(self, key=None):
        params = {}
        if key is not None:
            params["key"] = key
        resp = self._call("getCorrelations", params)
        return self._unwrap_result(resp)

    def get_clusters(self):
        resp = self._call("getClusters")
        return self._unwrap_result(resp)

    def get_leading_indicators(self, key=None):
        params = {}
        if key is not None:
            params["key"] = key
        resp = self._call("getLeadingIndicators", params)
        return self._unwrap_result(resp)

    def get_seasonal_patterns(self, key=None):
        params = {}
        if key is not None:
            params["key"] = key
        resp = self._call("getSeasonalPatterns", params)
        return self._unwrap_result(resp)

    def get_forecast(self, key, field, horizon=None):
        params = {"key": key, "field": field}
        if horizon is not None:
            params["horizon"] = horizon
        resp = self._call("getForecast", params)
        return self._unwrap_result(resp)

    def get_anomalies(self, since=None):
        params = {}
        if since is not None:
            params["since"] = since
        resp = self._call("getAnomalies", params)
        return self._unwrap_result(resp)

    def get_recommendations(self, filter_type=None, target=None):
        params = {}
        if filter_type is not None:
            params["type"] = filter_type
        if target is not None:
            params["target"] = target
        resp = self._call("getRecommendations", params)
        return self._unwrap_result(resp)

    def infer(self, domain, objective=None, subject=None, context=None, candidates=None):
        params = {"domain": domain}
        if objective is not None:
            params["objective"] = objective
        if subject is not None:
            params["subject"] = subject
        if context is not None:
            params["context"] = context
        if candidates is not None:
            params["candidates"] = candidates
        resp = self._call("infer", params)
        return self._unwrap_result(resp)

    def get_profile(self, scope=None):
        params = {}
        if scope is not None:
            params["scope"] = scope
        resp = self._call("getProfile", params)
        return self._unwrap_result(resp)

    def get_accuracy(self, insight_type=None, scope=None):
        params = {}
        if insight_type is not None:
            params["insightType"] = insight_type
        if scope is not None:
            params["scope"] = scope
        resp = self._call("getAccuracy", params)
        return self._unwrap_result(resp)

    def subscribe(self, event_types, callback: Optional[Callable[[dict], None]] = None):
        resp = self._call("subscribe", {"events": event_types})
        result = self._unwrap_result(resp)
        # Callback wiring for streaming transport is deferred to daemon event-stream phase.
        return result.get("subscriptionId")

    def unsubscribe(self, subscription_id):
        resp = self._call("unsubscribe", {"subscriptionId": subscription_id})
        return self._unwrap_result(resp).get("ok", False)

    def ping(self):
        return self._unwrap_result(self._call("ping"))

    async def aput(self, key: str, fields: dict) -> bool:
        resp = await self._acall("put", {"key": key, "fields": fields})
        return self._unwrap_result(resp).get('ok', False)

    async def aget(self, key: str):
        resp = await self._acall("get", {"key": key})
        return self._unwrap_result(resp)

    async def adelete(self, key: str) -> bool:
        resp = await self._acall("delete", {"key": key})
        return self._unwrap_result(resp).get('ok', False)

    async def ascan(self, prefix: str = ""):
        resp = await self._acall("scan", {"prefix": prefix})
        return self._unwrap_result(resp).get('items', [])

    async def aflush(self):
        resp = await self._acall("flush")
        return self._unwrap_result(resp)

    async def acompact(self):
        resp = await self._acall("compact")
        return self._unwrap_result(resp)

    async def arotate(self):
        resp = await self._acall("rotate")
        return self._unwrap_result(resp)

    async def averify(self, tier: Optional[str] = None):
        params = {}
        if tier is not None:
            params["tier"] = tier
        resp = await self._acall("verify", params)
        return self._unwrap_result(resp)

    async def aget_insight(self, key: str):
        resp = await self._acall("getInsight", {"key": key})
        return self._unwrap_result(resp)

    async def aget_insights(self, insight_type: Optional[str] = None):
        params = {}
        if insight_type:
            params["type"] = insight_type
        resp = await self._acall("getInsights", params)
        return self._unwrap_result(resp)

    async def areport_outcome(self, insight_id: str, result: str, context: Optional[str] = None) -> bool:
        params = {"insightId": insight_id, "result": result}
        if context is not None:
            params["context"] = context
        resp = await self._acall("reportOutcome", params)
        return self._unwrap_result(resp).get('ok', False)

    async def aget_correlations(self, key: Optional[str] = None):
        params = {}
        if key is not None:
            params["key"] = key
        resp = await self._acall("getCorrelations", params)
        return self._unwrap_result(resp)

    async def aget_clusters(self):
        resp = await self._acall("getClusters")
        return self._unwrap_result(resp)

    async def aget_leading_indicators(self, key: Optional[str] = None):
        params = {}
        if key is not None:
            params["key"] = key
        resp = await self._acall("getLeadingIndicators", params)
        return self._unwrap_result(resp)

    async def aget_seasonal_patterns(self, key: Optional[str] = None):
        params = {}
        if key is not None:
            params["key"] = key
        resp = await self._acall("getSeasonalPatterns", params)
        return self._unwrap_result(resp)

    async def aget_forecast(self, key: str, field: str, horizon: Optional[int] = None):
        params = {"key": key, "field": field}
        if horizon is not None:
            params["horizon"] = horizon
        resp = await self._acall("getForecast", params)
        return self._unwrap_result(resp)

    async def aget_anomalies(self, since: Optional[int] = None):
        params = {}
        if since is not None:
            params["since"] = since
        resp = await self._acall("getAnomalies", params)
        return self._unwrap_result(resp)

    async def aget_recommendations(self, filter_type: Optional[str] = None, target: Optional[str] = None):
        params = {}
        if filter_type is not None:
            params["type"] = filter_type
        if target is not None:
            params["target"] = target
        resp = await self._acall("getRecommendations", params)
        return self._unwrap_result(resp)

    async def aget_accuracy(self, insight_type: Optional[str] = None, scope: Optional[str] = None):
        params = {}
        if insight_type is not None:
            params["insightType"] = insight_type
        if scope is not None:
            params["scope"] = scope
        resp = await self._acall("getAccuracy", params)
        return self._unwrap_result(resp)

    async def asubscribe(self, event_types: list[str]):
        resp = await self._acall("subscribe", {"events": event_types})
        return self._unwrap_result(resp).get("subscriptionId")

    async def aunsubscribe(self, subscription_id: str) -> bool:
        resp = await self._acall("unsubscribe", {"subscriptionId": subscription_id})
        return self._unwrap_result(resp).get("ok", False)

    async def aping(self):
        resp = await self._acall("ping")
        return self._unwrap_result(resp)

# Example Usage:
# client = GICSClient()
# client.put("user_1", {"name": "Alice", "trust": 0.95})
# print(client.get("user_1"))

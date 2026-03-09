"""
a2a_worker — Python SDK for building A2A-compatible workers.

Minimal dependencies: only stdlib + any ASGI server (uvicorn recommended).

Usage:
    from a2a_worker import A2AWorker, Skill

    worker = A2AWorker(name="my-agent", port=8090)

    @worker.skill("greet", description="Greet the user")
    async def greet(args: dict, message: str) -> str:
        name = args.get("name", "world")
        return f"Hello, {name}!"

    @worker.skill("summarize", description="Summarize text")
    async def summarize(args: dict, message: str) -> str:
        # Use any framework: LangChain, CrewAI, raw API calls, etc.
        return f"Summary of: {message[:100]}..."

    if __name__ == "__main__":
        worker.run()
"""

from __future__ import annotations

import json
import uuid
import time
import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

# ── Types ──────────────────────────────────────────────────────


@dataclass
class Skill:
    id: str
    name: str
    description: str
    handler: Callable[[dict, str], Awaitable[str]] | None = None


@dataclass
class AgentCard:
    name: str
    url: str
    description: str
    version: str = "1.0.0"
    skills: list[dict[str, str]] = field(default_factory=list)
    capabilities: dict[str, bool] = field(default_factory=lambda: {"streaming": False})


# ── Worker ─────────────────────────────────────────────────────


class A2AWorker:
    """A2A-compatible worker server in pure Python."""

    def __init__(
        self,
        name: str,
        port: int = 8090,
        description: str | None = None,
        version: str = "1.0.0",
        host: str = "0.0.0.0",
    ):
        self.name = name
        self.port = port
        self.host = host
        self.description = description or f"{name} worker"
        self.version = version
        self._skills: dict[str, Skill] = {}
        self._start_time = time.time()

    def skill(
        self,
        skill_id: str,
        *,
        name: str | None = None,
        description: str = "",
    ) -> Callable:
        """Decorator to register a skill handler."""

        def decorator(fn: Callable[[dict, str], Awaitable[str]]) -> Callable:
            self._skills[skill_id] = Skill(
                id=skill_id,
                name=name or skill_id.replace("_", " ").title(),
                description=description,
                handler=fn,
            )
            return fn

        return decorator

    def _build_card(self) -> dict:
        return {
            "name": f"{self.name}-agent",
            "url": f"http://localhost:{self.port}",
            "description": self.description,
            "version": self.version,
            "capabilities": {"streaming": False},
            "skills": [
                {"id": s.id, "name": s.name, "description": s.description}
                for s in self._skills.values()
            ],
        }

    async def _handle_request(self, method: str, path: str, body: bytes) -> tuple[int, dict | list]:
        """Route HTTP requests to handlers."""

        if method == "GET" and path == "/.well-known/agent.json":
            return 200, self._build_card()

        if method == "GET" and path == "/healthz":
            return 200, {
                "status": "ok",
                "agent": f"{self.name}-agent",
                "uptime": time.time() - self._start_time,
                "skills": list(self._skills.keys()),
            }

        if method == "POST" and path in ("/", "/a2a"):
            return await self._handle_task(body)

        return 404, {"error": "not found"}

    async def _handle_task(self, body: bytes) -> tuple[int, dict]:
        """Handle an A2A task/send request."""
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            return 400, {"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}}

        request_id = data.get("id", str(uuid.uuid4()))
        params = data.get("params", {})
        task_id = params.get("id", str(uuid.uuid4()))

        # Extract skill ID and args
        parts = params.get("message", {}).get("parts", [])
        first_part = parts[0] if parts else {}
        metadata = first_part.get("metadata", {})

        skill_id = metadata.get("skillId") or params.get("skillId")
        args = metadata.get("args") or params.get("args", {})
        message_text = first_part.get("text", "")

        # Default to first registered skill if none specified
        if not skill_id and self._skills:
            skill_id = next(iter(self._skills))

        skill = self._skills.get(skill_id) if skill_id else None
        if not skill or not skill.handler:
            return 200, {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "id": task_id,
                    "status": {"state": "failed", "message": {
                        "role": "agent",
                        "parts": [{"kind": "text", "text": f"Unknown skill: {skill_id}"}],
                    }},
                    "artifacts": [],
                },
            }

        try:
            result = await skill.handler(args, message_text)
            return 200, {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "id": task_id,
                    "status": {"state": "completed"},
                    "artifacts": [{"parts": [{"kind": "text", "text": result}]}],
                },
            }
        except Exception as e:
            return 200, {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "id": task_id,
                    "status": {"state": "failed", "message": {
                        "role": "agent",
                        "parts": [{"kind": "text", "text": str(e)}],
                    }},
                    "artifacts": [],
                },
            }

    def run(self) -> None:
        """Start the worker using asyncio with a built-in HTTP server."""
        import sys
        print(f"[{self.name}] starting on :{self.port}", file=sys.stderr)
        print(f"[{self.name}] skills: {', '.join(self._skills.keys())}", file=sys.stderr)
        asyncio.run(self._serve())

    async def _serve(self) -> None:
        """Minimal asyncio HTTP server (no external deps required)."""
        server = await asyncio.start_server(
            self._handle_connection, self.host, self.port
        )
        import sys
        print(f"[{self.name}] listening on {self.host}:{self.port}", file=sys.stderr)
        async with server:
            await server.serve_forever()

    async def _handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """Handle a single HTTP connection."""
        try:
            # Read request line
            request_line = await asyncio.wait_for(reader.readline(), timeout=10)
            if not request_line:
                writer.close()
                return

            parts = request_line.decode().strip().split(" ")
            if len(parts) < 2:
                writer.close()
                return

            method, path = parts[0], parts[1]

            # Read headers
            content_length = 0
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=10)
                if line == b"\r\n" or line == b"\n" or not line:
                    break
                header = line.decode().strip().lower()
                if header.startswith("content-length:"):
                    content_length = int(header.split(":")[1].strip())

            # Read body
            body = b""
            if content_length > 0:
                body = await asyncio.wait_for(reader.readexactly(content_length), timeout=30)

            # Handle request
            status, response = await self._handle_request(method, path, body)

            # Write response
            response_body = json.dumps(response).encode()
            status_text = {200: "OK", 400: "Bad Request", 404: "Not Found"}.get(status, "OK")
            header = (
                f"HTTP/1.1 {status} {status_text}\r\n"
                f"Content-Type: application/json\r\n"
                f"Content-Length: {len(response_body)}\r\n"
                f"Connection: close\r\n"
                f"\r\n"
            )
            writer.write(header.encode() + response_body)
            await writer.drain()
        except (asyncio.TimeoutError, ConnectionResetError, BrokenPipeError):
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

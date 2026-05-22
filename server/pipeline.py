"""
Spawns the C++ cfar_processor binary in stream mode and feeds frames
to all connected WebSocket clients.
"""
import asyncio
import json
import logging
from pathlib import Path

import sys
_exe = ".exe" if sys.platform == "win32" else ""
BINARY = Path(__file__).parent / "bin" / f"cfar_processor{_exe}"

logger = logging.getLogger(__name__)


class CfarPipeline:
    def __init__(self):
        self._subscribers: list[asyncio.Queue] = []
        self._proc: asyncio.subprocess.Process | None = None
        self._task: asyncio.Task | None = None

    async def start(self, config: dict):
        """Start the C++ binary in stream+json mode."""
        args = [
            str(BINARY),
            "--mode", "stream",
            "--format", "json",
            "--fft-size", str(config.get("fftSize", 1024)),
            "--guard", str(config.get("guardCells", 4)),
            "--training", str(config.get("trainingCells", 16)),
            "--pfa", str(config.get("pfa", 1e-4)),
            "--variant", config.get("variant", "CA"),
        ]
        self._proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=4 * 1024 * 1024,  # 4MB: handles large JSON frames
        )
        self._task = asyncio.create_task(self._reader())
        logger.info("C++ pipeline started (pid=%s)", self._proc.pid)

    async def _reader(self):
        """Read JSON lines from C++ stdout and broadcast to all subscribers."""
        try:
            while True:
                line = await self._proc.stdout.readline()
                if not line:
                    break
                try:
                    frame = json.loads(line.decode())
                    for q in list(self._subscribers):
                        try:
                            await q.put(frame)
                        except asyncio.QueueFull:
                            pass  # drop frame if subscriber is slow
                except json.JSONDecodeError:
                    pass
        except Exception as e:
            logger.warning("Pipeline reader error: %s", e)
        finally:
            # Notify subscribers that backend disconnected
            err = {"error": "backend_disconnected"}
            for q in list(self._subscribers):
                try:
                    await q.put(err)
                except asyncio.QueueFull:
                    pass

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=3)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def stop(self):
        if self._proc and self._proc.returncode is None:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                self._proc.kill()
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

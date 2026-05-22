"""
FastAPI server:
  GET  /             → serves frontend/index.html
  GET  /static/**    → serves frontend static files
  GET  /api/health   → {"status":"ok","binary_found":true/false}
  GET  /api/scenes   → returns frontend/public/data/manifest.json
  GET  /api/scenes/{id} → returns frontend/public/data/scenes/{id}.json
  GET  /api/benchmark → runs C++ binary --benchmark, returns stdout as text
  WS   /ws/live      → streams live frames from C++ backend in real-time
  WS   /ws/scene/{id} → streams a pre-built JSON scene at configurable speed
"""

import asyncio
import json
import subprocess
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from pipeline import CfarPipeline

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

ROOT     = Path(__file__).parent
FRONTEND = ROOT.parent / "frontend"
SCENES   = FRONTEND / "public" / "data" / "scenes"
MANIFEST = FRONTEND / "public" / "data" / "manifest.json"
_exe = ".exe" if sys.platform == "win32" else ""
BINARY   = ROOT / "bin" / f"cfar_processor{_exe}"

pipeline = CfarPipeline()


@asynccontextmanager
async def lifespan(app: FastAPI):
    if BINARY.exists():
        try:
            await pipeline.start({})
        except Exception as e:
            logger.warning("Failed to start C++ pipeline: %s", e)
    else:
        logger.warning("C++ binary not found at %s — live mode disabled", BINARY)
    yield
    await pipeline.stop()


app = FastAPI(title="CFAR Radar API", lifespan=lifespan)

# Serve frontend static files
app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="static")
# index.html references src/* as relative paths — serve them directly
app.mount("/src", StaticFiles(directory=str(FRONTEND / "src")), name="frontend-src")
# bundle.jsx fetches /public/data/manifest.json and scenes as raw static files
app.mount("/public", StaticFiles(directory=str(FRONTEND / "public")), name="frontend-public")


@app.get("/")
async def index():
    return FileResponse(str(FRONTEND / "index.html"))


@app.get("/api/health")
async def health():
    return {"status": "ok", "binary_found": BINARY.exists()}


@app.get("/api/scenes")
async def scenes():
    return JSONResponse(json.loads(MANIFEST.read_text(encoding="utf-8")))


@app.get("/api/scenes/{scene_id}")
async def scene(scene_id: str):
    path = SCENES / f"{scene_id}.json"
    if not path.exists():
        return JSONResponse({"error": "scene not found"}, status_code=404)
    return JSONResponse(json.loads(path.read_text(encoding="utf-8")))


@app.get("/api/benchmark")
async def benchmark():
    if not BINARY.exists():
        return PlainTextResponse(
            "Binary not found. Build the C++ backend first.", status_code=503
        )
    result = subprocess.run(
        [str(BINARY), "--benchmark", "--format", "terminal"],
        capture_output=True, text=True, timeout=60,
    )
    return PlainTextResponse(result.stdout + result.stderr)


@app.websocket("/ws/live")
async def ws_live(websocket: WebSocket):
    """Stream live frames from the C++ pipeline."""
    await websocket.accept()
    q = pipeline.subscribe()
    try:
        while True:
            frame = await asyncio.wait_for(q.get(), timeout=5.0)
            await websocket.send_json(frame)
    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    except Exception as e:
        logger.warning("ws_live error: %s", e)
        try:
            await websocket.send_json({"error": "backend_disconnected"})
        except Exception:
            pass
    finally:
        pipeline.unsubscribe(q)


@app.websocket("/ws/scene/{scene_id}")
async def ws_scene(websocket: WebSocket, scene_id: str, speed: float = 1.0):
    """Stream a pre-built scene's frames over WebSocket at configurable speed."""
    await websocket.accept()
    path = SCENES / f"{scene_id}.json"
    if not path.exists():
        await websocket.send_json({"error": "scene not found"})
        await websocket.close()
        return

    scene_data = json.loads(path.read_text(encoding="utf-8"))
    frames = scene_data.get("frames", [])
    fps    = scene_data.get("meta", {}).get("fps", 25) * max(0.1, min(5.0, speed))
    delay  = 1.0 / max(fps, 0.1)

    try:
        for frame in frames:
            await websocket.send_json(frame)
            await asyncio.sleep(delay)
    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)

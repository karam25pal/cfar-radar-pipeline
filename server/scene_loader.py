"""
Utility helpers for loading pre-built scene files.
main.py handles serving inline; this module provides reusable helpers.
"""
import json
from pathlib import Path


def load_scene(scenes_dir: Path, scene_id: str) -> dict | None:
    path = scenes_dir / f"{scene_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def list_scene_ids(scenes_dir: Path) -> list[str]:
    return [p.stem for p in scenes_dir.glob("*.json")]

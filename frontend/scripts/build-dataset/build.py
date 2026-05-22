#!/usr/bin/env python3
"""
Build script for the onboard CFAR-radar sample datasets.

Generates synthetic ground-truth target tracks for a set of canonical FMCW
test scenes and writes them to ``public/data/scenes/*.json`` plus a manifest
at ``public/data/manifest.json``.

These files are the exact format the dashboard's React Query loader expects:
    {
      "meta": { id, label, sub, sensor, license, citation, fps, frame_count, ... },
      "frames": [ { "targets": [ {bin, mag, doppler}, ... ] }, ... ]
    }

The frontend runs CA-CFAR on these targets live (per frame) against
in-browser-generated Rayleigh noise. Latency / FAR / SNR are measured
against the ground-truth targets in each frame.

Usage:
    python scripts/build-dataset/build.py
"""

from __future__ import annotations

import json
import math
import os
import struct
from pathlib import Path
from typing import Callable, Iterable, List

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "public" / "data" / "scenes"
MANIFEST = ROOT / "public" / "data" / "manifest.json"

SENSOR = {
    "type": "FMCW automotive MIMO",
    "bandwidth_ghz": 4.0,
    "chirp_us": 40,
    "sample_rate_mhz": 10,
    "center_freq_ghz": 77,
    "fft_size": 1024,
    "doppler_bins": 64,
}


def mulberry32(seed: int) -> Callable[[], float]:
    """Deterministic PRNG matching the frontend generator (used for parity)."""
    state = [seed & 0xFFFFFFFF]

    def next_() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = state[0]
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + ((t ^ (t >> 7)) * (t | 61))) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4_294_967_296.0

    return next_


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def scene(
    meta: dict,
    frames_fn: Callable[[int, int, Callable[[], float]], List[dict]],
) -> dict:
    """Materialise a scene definition into a serialisable dict."""
    rng = mulberry32(meta.get("seed", 1))
    N = SENSOR["fft_size"] // 2  # half-spectrum range bins
    frames = []
    for i in range(meta["frame_count"]):
        frames.append({"targets": frames_fn(i, N, rng)})
    return {
        "meta": {
            "id": meta["id"],
            "label": meta["label"],
            "sub": meta["sub"],
            "sensor": SENSOR,
            "license": meta.get("license", "CC-BY 4.0 (synthetic, generated)"),
            "citation": meta.get(
                "citation",
                "Synthetic FMCW CA-CFAR test set v1, generated 2026",
            ),
            "fps": meta.get("fps", 25),
            "frame_count": meta["frame_count"],
            "noise_floor": 25,
            "noise_sigma": 1.0,
            "scene_notes": meta.get("scene_notes", ""),
        },
        "frames": frames,
    }


# ---------------------------------------------------------------------------
# Scene definitions
# ---------------------------------------------------------------------------

def highway(i: int, N: int, r: Callable[[], float]) -> List[dict]:
    return [
        {"bin": int(clamp(round(N * 0.78 - i * 0.55), 20, N - 6)),
         "mag": 28 + (r() - 0.5) * 1.2,
         "doppler": 22 + (r() - 0.5) * 1.5},
        {"bin": int(clamp(round(N * 0.55 - i * 0.42), 20, N - 6)),
         "mag": 24 + (r() - 0.5) * 1.2,
         "doppler": 18 + (r() - 0.5) * 1.5},
        {"bin": int(clamp(round(N * 0.34 - i * 0.30), 20, N - 6)),
         "mag": 22 + (r() - 0.5) * 1.2,
         "doppler": 14 + (r() - 0.5) * 1.5},
    ]


def urban(i: int, N: int, r: Callable[[], float]) -> List[dict]:
    return [
        {"bin": int(round(N * 0.08 + math.sin(i * 0.05) * 3)),
         "mag": 20 + (r() - 0.5), "doppler": 2 + (r() - 0.5) * 0.6},
        {"bin": int(round(N * 0.17 + math.cos(i * 0.04) * 2)),
         "mag": 18 + (r() - 0.5), "doppler": -3 + (r() - 0.5) * 0.6},
        {"bin": int(round(N * 0.32 + math.sin(i * 0.08) * 2)),
         "mag": 22 + (r() - 0.5), "doppler": 1 + (r() - 0.5) * 0.4},
        {"bin": int(round(N * 0.50 + math.cos(i * 0.06) * 3)),
         "mag": 19 + (r() - 0.5), "doppler": -2 + (r() - 0.5) * 0.6},
        {"bin": int(round(N * 0.74 + math.sin(i * 0.04) * 2)),
         "mag": 24 + (r() - 0.5), "doppler": 4 + (r() - 0.5) * 0.5},
    ]


def swarm(i: int, N: int, r: Callable[[], float]) -> List[dict]:
    out = []
    for k in range(7):
        out.append({
            "bin": int(round(N * (0.25 + k * 0.055) + math.sin(i * 0.18 + k) * 2.5)),
            "mag": 14 + math.sin(i * 0.1 + k * 0.7) * 1.6 + (r() - 0.5) * 0.6,
            "doppler": -10 + k * 3 + math.sin(i * 0.15 + k) * 2,
        })
    return out


def parking(i: int, N: int, r: Callable[[], float]) -> List[dict]:
    return [
        {"bin": int(round(N * (0.12 + k * 0.10) + (r() - 0.5) * 0.5)),
         "mag": 18 + math.cos(k) * 2 + (r() - 0.5) * 0.4,
         "doppler": 0 + (r() - 0.5) * 0.3}
        for k in range(8)
    ]


SCENES = [
    (
        {"id": "highway", "label": "Highway · A14",
         "sub": "3 vehicles · +14–22 m/s closing",
         "frame_count": 120, "fps": 25, "seed": 11,
         "scene_notes": "Three-lane motorway scene. Lead, mid, and trailing vehicles moving toward ego."},
        highway,
    ),
    (
        {"id": "urban", "label": "Urban · Uxbridge Rd",
         "sub": "5 slow movers · pedestrians + cars at 30 km/h",
         "frame_count": 160, "fps": 20, "seed": 23,
         "scene_notes": "Mixed urban traffic with multiple slow-moving returns including pedestrian-scale targets."},
        urban,
    ),
    (
        {"id": "swarm", "label": "Drone swarm · low-RCS",
         "sub": "7 UAVs · clustered · low SNR",
         "frame_count": 100, "fps": 30, "seed": 41,
         "scene_notes": "Coordinated quadcopter swarm at low radar cross-section, formation drifting laterally."},
        swarm,
    ),
    (
        {"id": "parking", "label": "Parking lot · static",
         "sub": "8 parked vehicles · 0 m/s baseline",
         "frame_count": 80, "fps": 15, "seed": 67,
         "scene_notes": "Static reference scene used for false-alarm rate validation."},
        parking,
    ),
]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {"version": 1, "scenes": []}

    for meta, fn in SCENES:
        sc = scene(meta, fn)
        path = OUT_DIR / f"{sc['meta']['id']}.json"
        with path.open("w", encoding="utf-8") as f:
            json.dump(sc, f, separators=(",", ":"))
        manifest["scenes"].append({
            "id": sc["meta"]["id"],
            "label": sc["meta"]["label"],
            "sub": sc["meta"]["sub"],
            "frame_count": sc["meta"]["frame_count"],
            "fps": sc["meta"]["fps"],
        })
        print(f"  wrote {path.relative_to(ROOT)}  ({sc['meta']['frame_count']} frames)")

    with MANIFEST.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"  wrote {MANIFEST.relative_to(ROOT)}")
    print(f"Done. {len(SCENES)} scene(s).")


if __name__ == "__main__":
    main()

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .pipeline import PipelineConfig, preprocess_pose_capture
from .render import render_skeleton_video
from .schemas import UploadPayload

APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent
DATA_DIR = BACKEND_DIR / "data"
RAW_JSON_DIR = DATA_DIR / "raw_json"
RAW_PTH_DIR = DATA_DIR / "raw_pth"
PROCESSED_PTH_DIR = DATA_DIR / "processed_pth"
RENDER_DIR = DATA_DIR / "renders"

for folder in [RAW_JSON_DIR, RAW_PTH_DIR, PROCESSED_PTH_DIR, RENDER_DIR]:
    folder.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Pose Capture Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _slugify_session(session_id: str | None) -> str:
    if not session_id:
        return "capture"
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", session_id).strip("-")
    return slug[:48] if slug else "capture"


def _capture_id(session_id: str | None) -> str:
    now = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    suffix = uuid.uuid4().hex[:8]
    return f"{_slugify_session(session_id)}-{now}-{suffix}"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/upload")
def upload_capture(payload: UploadPayload) -> dict[str, object]:
    capture_id = _capture_id(payload.meta.session_id)
    raw_json_path = RAW_JSON_DIR / f"{capture_id}.json"
    raw_pth_path = RAW_PTH_DIR / f"{capture_id}.pth"
    processed_pth_path = PROCESSED_PTH_DIR / f"{capture_id}.pth"
    render_path = RENDER_DIR / f"{capture_id}.mp4"

    try:
        keypoints_np = np.asarray(payload.keypoints, dtype=np.float32)
        timestamps_np = np.asarray(payload.timestamps, dtype=np.float64)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid numeric payload: {exc}") from exc

    raw_json_path.write_text(
        json.dumps(payload.model_dump(), separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )

    torch.save(
        {
            "keypoints": torch.from_numpy(keypoints_np),
            "timestamps": torch.from_numpy(timestamps_np),
            "meta": payload.meta.model_dump(),
        },
        raw_pth_path,
    )

    config = PipelineConfig(
        target_fps=float(payload.meta.fps_nominal),
        smoothing_alpha=0.35,
        visibility_threshold=0.5,
    )
    processed = preprocess_pose_capture(keypoints_np, timestamps_np, config)

    torch.save(
        {
            "keypoints": torch.from_numpy(processed.keypoints.astype(np.float32)),
            "timestamps": torch.from_numpy(processed.timestamps.astype(np.float64)),
            "meta": {
                **payload.meta.model_dump(),
                "processing": processed.processing_meta,
            },
        },
        processed_pth_path,
    )

    try:
        render_skeleton_video(
            keypoints=processed.keypoints,
            output_path=render_path,
            fps=float(payload.meta.fps_nominal),
            canvas_size=720,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Render failed: {exc}") from exc

    return {
        "status": "ok",
        "capture_id": capture_id,
        "raw_json_path": str(raw_json_path),
        "raw_pth_path": str(raw_pth_path),
        "processed_pth_path": str(processed_pth_path),
        "render_path": str(render_path),
        "frames_in": int(keypoints_np.shape[0]),
        "frames_out": int(processed.keypoints.shape[0]),
    }

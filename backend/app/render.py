from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
import torch

SKELETON_EDGES: list[tuple[int, int]] = [
    (11, 13),
    (13, 15),
    (12, 14),
    (14, 16),
    (11, 12),
    (23, 24),
    (11, 23),
    (12, 24),
    (23, 25),
    (25, 27),
    (24, 26),
    (26, 28),
]


def _depth_to_color(z: float, z_min: float, z_max: float) -> tuple[int, int, int]:
    if z_max - z_min < 1e-6:
        t = 0.5
    else:
        t = float((z - z_min) / (z_max - z_min))
    t = float(np.clip(t, 0.0, 1.0))

    red = int(255 * (1.0 - t))
    blue = int(255 * t)
    green = int(180)
    return blue, green, red


def _project_xy(
    keypoints: np.ndarray,
    canvas_size: int
) -> tuple[np.ndarray, np.ndarray]:
    xy = keypoints[:, :, :2]
    max_abs = float(np.max(np.abs(xy)))
    if max_abs < 1e-5:
        max_abs = 1.0
    scale = 0.42 / max_abs

    x_px = ((xy[:, :, 0] * scale + 0.5) * canvas_size).astype(np.int32)
    y_px = ((0.5 - xy[:, :, 1] * scale) * canvas_size).astype(np.int32)

    x_px = np.clip(x_px, 0, canvas_size - 1)
    y_px = np.clip(y_px, 0, canvas_size - 1)
    return x_px, y_px


def render_skeleton_video(
    keypoints: np.ndarray,
    output_path: Path | str,
    fps: float = 60.0,
    canvas_size: int = 720
) -> Path:
    keypoints_np = np.asarray(keypoints, dtype=np.float32)
    if keypoints_np.ndim != 3 or keypoints_np.shape[1:] != (33, 4):
        raise ValueError("Expected keypoints with shape [T, 33, 4].")

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    x_px, y_px = _project_xy(keypoints_np, canvas_size)
    z_values = keypoints_np[:, :, 2]
    z_min = float(np.min(z_values))
    z_max = float(np.max(z_values))

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(output), fourcc, float(fps), (canvas_size, canvas_size))
    if not writer.isOpened():
        raise RuntimeError(f"Could not open video writer for: {output}")

    try:
        for frame_idx in range(keypoints_np.shape[0]):
            frame = np.zeros((canvas_size, canvas_size, 3), dtype=np.uint8)
            frame[:, :] = (8, 10, 14)

            for start_idx, end_idx in SKELETON_EDGES:
                start = (int(x_px[frame_idx, start_idx]), int(y_px[frame_idx, start_idx]))
                end = (int(x_px[frame_idx, end_idx]), int(y_px[frame_idx, end_idx]))

                vis = float(
                    min(
                        keypoints_np[frame_idx, start_idx, 3],
                        keypoints_np[frame_idx, end_idx, 3]
                    )
                )
                if vis < 0.05:
                    continue

                color = (120, 220, 255)
                thickness = 2
                cv2.line(frame, start, end, color, thickness, cv2.LINE_AA)

            for joint_idx in range(33):
                visibility = float(keypoints_np[frame_idx, joint_idx, 3])
                if visibility < 0.05:
                    continue

                center = (int(x_px[frame_idx, joint_idx]), int(y_px[frame_idx, joint_idx]))
                depth = float(keypoints_np[frame_idx, joint_idx, 2])
                color = _depth_to_color(depth, z_min, z_max)
                radius = 2 + int(np.clip(visibility, 0.0, 1.0) * 2.0)
                cv2.circle(frame, center, radius, color, -1, cv2.LINE_AA)

            writer.write(frame)
    finally:
        writer.release()

    return output


def _cli() -> None:
    parser = argparse.ArgumentParser(description="Render skeleton video from a .pth file.")
    parser.add_argument("--pth", type=str, required=True, help="Input .pth path")
    parser.add_argument("--output", type=str, required=True, help="Output .mp4 path")
    parser.add_argument("--fps", type=float, default=60.0, help="Output FPS")
    args = parser.parse_args()

    data = torch.load(args.pth, map_location="cpu")
    keypoints = data["keypoints"]
    if isinstance(keypoints, torch.Tensor):
        keypoints = keypoints.cpu().numpy()

    render_skeleton_video(
        keypoints=np.asarray(keypoints, dtype=np.float32),
        output_path=Path(args.output),
        fps=float(args.fps)
    )


if __name__ == "__main__":
    _cli()

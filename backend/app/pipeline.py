from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np


@dataclass(frozen=True)
class PipelineConfig:
    target_fps: float = 60.0
    smoothing_alpha: float = 0.35
    visibility_threshold: float = 0.5


@dataclass(frozen=True)
class PipelineResult:
    keypoints: np.ndarray
    timestamps: np.ndarray
    processing_meta: dict[str, float | int]


def _sorted_unique_timestamps(
    keypoints: np.ndarray, timestamps: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    order = np.argsort(timestamps)
    sorted_ts = timestamps[order]
    sorted_keypoints = keypoints[order]

    unique_ts, unique_indices = np.unique(sorted_ts, return_index=True)
    unique_keypoints = sorted_keypoints[unique_indices]
    return unique_keypoints, unique_ts


def infer_timestamp_scale_to_ms(timestamps: np.ndarray, target_fps: float) -> float:
    finite = timestamps[np.isfinite(timestamps)]
    if finite.shape[0] == 0:
        return 1.0

    candidate_scales = np.array([1.0, 1e-3, 1e-6, 1000.0], dtype=np.float64)

    # Prefer candidates that look like wall-clock epoch milliseconds.
    sample_ts = float(finite[0])
    now_ms = datetime.now(timezone.utc).timestamp() * 1000.0
    epoch_window_ms = 24.0 * 60.0 * 60.0 * 1000.0
    epoch_matches: list[float] = []
    for scale in candidate_scales:
        scaled = sample_ts * float(scale)
        if np.isfinite(scaled) and abs(scaled - now_ms) <= epoch_window_ms:
            epoch_matches.append(float(scale))
    if len(epoch_matches) == 1:
        return epoch_matches[0]

    if finite.shape[0] < 2:
        return 1.0

    sorted_ts = np.sort(finite.astype(np.float64, copy=False))
    deltas = np.diff(sorted_ts)
    positive_deltas = deltas[deltas > 0]
    if positive_deltas.shape[0] == 0:
        return 1.0

    median_delta = float(np.median(positive_deltas))
    if median_delta <= 0:
        return 1.0

    expected_delta_ms = 1000.0 / max(float(target_fps), 1e-6)
    best_scale = 1.0
    best_score = float("inf")

    for scale in candidate_scales:
        scaled_delta_ms = median_delta * float(scale)
        if not np.isfinite(scaled_delta_ms) or scaled_delta_ms <= 0:
            continue

        score = abs(np.log(scaled_delta_ms / expected_delta_ms))
        if scaled_delta_ms < 0.1 or scaled_delta_ms > 10000.0:
            score += 5.0

        if score < best_score:
            best_score = float(score)
            best_scale = float(scale)

    return best_scale


def resample_keypoints(
    keypoints: np.ndarray, timestamps: np.ndarray, target_fps: float
) -> tuple[np.ndarray, np.ndarray]:
    if keypoints.shape[0] < 2:
        return keypoints.astype(np.float32, copy=True), timestamps.astype(
            np.float64, copy=True
        )

    unique_keypoints, unique_timestamps = _sorted_unique_timestamps(keypoints, timestamps)
    if unique_keypoints.shape[0] < 2:
        return unique_keypoints.astype(np.float32, copy=True), unique_timestamps.astype(
            np.float64, copy=True
        )

    step_ms = 1000.0 / target_fps
    start_ts = float(unique_timestamps[0])
    end_ts = float(unique_timestamps[-1])
    if end_ts <= start_ts:
        return unique_keypoints.astype(np.float32, copy=True), unique_timestamps.astype(
            np.float64, copy=True
        )

    new_timestamps = np.arange(start_ts, end_ts + 1e-6, step_ms, dtype=np.float64)
    out = np.empty((new_timestamps.shape[0], 33, 4), dtype=np.float32)

    for joint_idx in range(33):
        for channel in range(4):
            out[:, joint_idx, channel] = np.interp(
                new_timestamps,
                unique_timestamps,
                unique_keypoints[:, joint_idx, channel]
            ).astype(np.float32)

    return out, new_timestamps


def exponential_smoothing(keypoints: np.ndarray, alpha: float) -> np.ndarray:
    if keypoints.shape[0] < 2:
        return keypoints.astype(np.float32, copy=True)

    alpha = float(np.clip(alpha, 0.0, 1.0))
    smoothed = keypoints.astype(np.float32, copy=True)

    for t in range(1, smoothed.shape[0]):
        smoothed[t, :, :3] = alpha * smoothed[t, :, :3] + (1.0 - alpha) * smoothed[
            t - 1, :, :3
        ]
        smoothed[t, :, 3] = alpha * smoothed[t, :, 3] + (1.0 - alpha) * smoothed[
            t - 1, :, 3
        ]

    return smoothed


def normalize_skeleton(keypoints: np.ndarray) -> np.ndarray:
    normalized = keypoints.astype(np.float32, copy=True)

    hip_center = (normalized[:, 23, :3] + normalized[:, 24, :3]) * 0.5
    shoulder_center = (normalized[:, 11, :3] + normalized[:, 12, :3]) * 0.5
    torso_length = np.linalg.norm(shoulder_center - hip_center, axis=1)
    torso_length = np.maximum(torso_length, 1e-3)

    normalized[:, :, :3] -= hip_center[:, None, :]
    normalized[:, :, :3] /= torso_length[:, None, None]
    return normalized


def interpolate_missing_keypoints(
    keypoints: np.ndarray, visibility_threshold: float
) -> np.ndarray:
    out = keypoints.astype(np.float32, copy=True)
    frame_axis = np.arange(out.shape[0], dtype=np.float32)

    for joint_idx in range(33):
        visibility = out[:, joint_idx, 3]
        valid_indices = np.where(visibility >= visibility_threshold)[0]

        if valid_indices.size == 0:
            out[:, joint_idx, :3] = 0.0
            out[:, joint_idx, 3] = 0.0
            continue

        if valid_indices.size == 1:
            idx = int(valid_indices[0])
            out[:, joint_idx, :3] = out[idx, joint_idx, :3]
            out[:, joint_idx, 3] = out[idx, joint_idx, 3]
            continue

        x_valid = valid_indices.astype(np.float32)
        for dim in range(3):
            y_valid = out[valid_indices, joint_idx, dim]
            out[:, joint_idx, dim] = np.interp(frame_axis, x_valid, y_valid).astype(
                np.float32
            )

        vis_valid = out[valid_indices, joint_idx, 3]
        out[:, joint_idx, 3] = np.interp(frame_axis, x_valid, vis_valid).astype(np.float32)

    return out


def preprocess_pose_capture(
    keypoints: np.ndarray,
    timestamps: np.ndarray,
    config: PipelineConfig
) -> PipelineResult:
    keypoints_np = np.asarray(keypoints, dtype=np.float32)
    timestamps_np = np.asarray(timestamps, dtype=np.float64)
    timestamp_scale_to_ms = infer_timestamp_scale_to_ms(timestamps_np, config.target_fps)
    timestamps_ms = timestamps_np * timestamp_scale_to_ms

    resampled_keypoints, resampled_timestamps = resample_keypoints(
        keypoints_np, timestamps_ms, config.target_fps
    )
    smoothed_keypoints = exponential_smoothing(resampled_keypoints, config.smoothing_alpha)
    normalized_keypoints = normalize_skeleton(smoothed_keypoints)
    filled_keypoints = interpolate_missing_keypoints(
        normalized_keypoints, config.visibility_threshold
    )

    processing_meta: dict[str, float | int] = {
        "frames_in": int(keypoints_np.shape[0]),
        "frames_out": int(filled_keypoints.shape[0]),
        "target_fps": float(config.target_fps),
        "smoothing_alpha": float(config.smoothing_alpha),
        "visibility_threshold": float(config.visibility_threshold),
        "timestamp_scale_to_ms": float(timestamp_scale_to_ms),
    }

    return PipelineResult(
        keypoints=filled_keypoints,
        timestamps=resampled_timestamps,
        processing_meta=processing_meta
    )

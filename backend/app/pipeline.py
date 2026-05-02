from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from scipy.signal import savgol_filter


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


class SpatialProcessor:
    """
    Implementation of the Screening App's SpatialSkeletonProcessor.
    Standardizes 33-landmark skeletons to be orientation-invariant and scale-normalized.
    """
    def __init__(self, confidence_threshold=0.5, smooth_window=5, poly_order=2):
        self.confidence_threshold = confidence_threshold
        self.smooth_window = smooth_window
        self.poly_order = poly_order
        
        # Keypoint Indices
        self.L_HIP = 23
        self.R_HIP = 24
        self.L_SHOULDER = 11
        self.R_SHOULDER = 12

    def process_sequence(self, landmarks, vis_mask):
        """Full pipeline: from raw landmarks to canonical 3D skeleton sequence."""
        # 1. Missing Joints Handling (Interpolation)
        landmarks = self.handle_missing_joints(landmarks, vis_mask)
        
        # 2. Root Centering
        landmarks = self.center_root(landmarks)
        
        # 3. Orientation Alignment and Scale Normalization
        landmarks = self.align_orientation_and_scale(landmarks)
        
        # 4. Temporal Smoothing
        landmarks = self.smooth_trajectory(landmarks)
        
        return landmarks

    def handle_missing_joints(self, landmarks, vis_mask):
        """Mask out low confidence joints and interpolate missing values."""
        landmarks = landmarks.copy()
        bad_joints = vis_mask < self.confidence_threshold
        landmarks[bad_joints] = np.nan
        
        T, num_joints, dims = landmarks.shape
        flattened = landmarks.reshape(T, -1)
        df = pd.DataFrame(flattened)
        df = df.interpolate(method='linear', limit_direction='both')
        df = df.fillna(0)
        return df.values.reshape(T, num_joints, dims)

    def center_root(self, landmarks):
        """Center the skeleton at the pelvis for every frame."""
        L_hip = landmarks[:, self.L_HIP, :]
        R_hip = landmarks[:, self.R_HIP, :]
        root = (L_hip + R_hip) / 2.0
        return landmarks - root[:, np.newaxis, :]

    def align_orientation_and_scale(self, landmarks):
        """Standardize orientation (XY rotation) and scale (torso length)."""
        T = landmarks.shape[0]
        if T == 0: return landmarks

        # 1. 2D VERTICAL ALIGNMENT (XY PLANE)
        L_hip = landmarks[:, self.L_HIP, :2]
        R_hip = landmarks[:, self.R_HIP, :2]
        root_2d = (L_hip + R_hip) / 2.0
        
        L_shoulder = landmarks[:, self.L_SHOULDER, :2]
        R_shoulder = landmarks[:, self.R_SHOULDER, :2]
        shoulder_center_2d = (L_shoulder + R_shoulder) / 2.0
        
        torso_vec_2d = np.mean(shoulder_center_2d - root_2d, axis=0)
        current_angle = np.arctan2(torso_vec_2d[1], torso_vec_2d[0])
        target_angle = -np.pi / 2.0 # -90 degrees is up
        d_theta = target_angle - current_angle
        
        cos_tr, sin_tr = np.cos(d_theta), np.sin(d_theta)
        R_xy = np.array([[cos_tr, -sin_tr], [sin_tr, cos_tr]])
        landmarks[:, :, :2] = np.matmul(landmarks[:, :, :2], R_xy.T)
        
        # 2. SCALE NORMALIZATION (3D)
        L_hip_3d = landmarks[:, self.L_HIP, :]
        R_hip_3d = landmarks[:, self.R_HIP, :]
        root_3d = (L_hip_3d + R_hip_3d) / 2.0
        
        L_shoulder_3d = landmarks[:, self.L_SHOULDER, :]
        R_shoulder_3d = landmarks[:, self.R_SHOULDER, :]
        shoulder_center_3d = (L_shoulder_3d + R_shoulder_3d) / 2.0
        
        torso_lengths = np.linalg.norm(shoulder_center_3d - root_3d, axis=1)
        torso_length = np.median(torso_lengths)
        
        if torso_length > 1e-5:
            landmarks = landmarks / torso_length
            
        return landmarks

    def smooth_trajectory(self, landmarks):
        """Apply Savitzky-Golay filter to smooth joint trajectories."""
        T = landmarks.shape[0]
        if T > self.smooth_window:
            window = self.smooth_window if self.smooth_window % 2 == 1 else self.smooth_window + 1
            if window > T: window = T if T % 2 == 1 else T - 1
            if window > self.poly_order:
                landmarks = savgol_filter(landmarks, window, self.poly_order, axis=0)
        return landmarks


def preprocess_pose_capture(
    keypoints: np.ndarray,
    timestamps: np.ndarray,
    config: PipelineConfig
) -> PipelineResult:
    keypoints_np = np.asarray(keypoints, dtype=np.float32)
    timestamps_np = np.asarray(timestamps, dtype=np.float64)
    timestamp_scale_to_ms = infer_timestamp_scale_to_ms(timestamps_np, config.target_fps)
    timestamps_ms = timestamps_np * timestamp_scale_to_ms

    # 1. Resample to target FPS
    resampled_keypoints, resampled_timestamps = resample_keypoints(
        keypoints_np, timestamps_ms, config.target_fps
    )
    
    # 2. Apply Screening-Compatible Spatial Processing (33 landmarks)
    # Extract [T, 33, 3] and visibility [T, 33]
    coords = resampled_keypoints[:, :, :3]
    visibility = resampled_keypoints[:, :, 3]
    
    processor = SpatialProcessor(visibility_threshold=config.visibility_threshold)
    processed_33 = processor.process_sequence(coords, visibility)

    processing_meta: dict[str, float | int] = {
        "frames_in": int(keypoints_np.shape[0]),
        "frames_out": int(processed_33.shape[0]),
        "target_fps": float(config.target_fps),
        "visibility_threshold": float(config.visibility_threshold),
        "timestamp_scale_to_ms": float(timestamp_scale_to_ms),
        "processor": "SpatialProcessor_33_v1"
    }

    return PipelineResult(
        keypoints=processed_33,
        timestamps=resampled_timestamps,
        processing_meta=processing_meta
    )

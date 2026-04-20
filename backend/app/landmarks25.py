from __future__ import annotations

import numpy as np

AXES_3D: tuple[str, str, str] = ("x", "y", "z")

# Custom 25-landmark layout used by downstream ASD feature extraction.
# Matches the mapping provided by the user (including "Midspain" spelling).
CUSTOM_25_LANDMARK_SPECS: tuple[tuple[str, tuple[int, ...]], ...] = (
    ("Midspain", (23, 24)),
    ("AnkleLeft", (27,)),
    ("AnkleRight", (28,)),
    ("ElbowLeft", (13,)),
    ("ElbowRight", (14,)),
    ("FootLeft", (31,)),
    ("FootRight", (32,)),
    ("HandLeft", (15,)),
    ("HandRight", (16,)),
    ("HandTipLeft", (19,)),
    ("HandTipRight", (20,)),
    ("Head", (0,)),
    ("HipLeft", (23,)),
    ("HipRight", (24,)),
    ("KneeLeft", (25,)),
    ("KneeRight", (26,)),
    ("Neck", (11, 12)),
    ("ShoulderLeft", (11,)),
    ("ShoulderRight", (12,)),
    ("SpineBase", (23, 24)),
    ("SpineShoulder", (11, 12)),
    ("ThumbLeft", (21,)),
    ("ThumbRight", (22,)),
    ("WristLeft", (15,)),
    ("WristRight", (16,)),
)

CUSTOM_25_CSV_COLUMNS: list[str] = [
    f"{joint_name}-{axis}"
    for joint_name, _ in CUSTOM_25_LANDMARK_SPECS
    for axis in AXES_3D
]

CUSTOM_25_MAPPING_METADATA: list[dict[str, object]] = [
    {
        "target_joint": joint_name,
        "source_landmark_indices": list(source_indices),
        "source_type": "direct" if len(source_indices) == 1 else "midpoint",
    }
    for joint_name, source_indices in CUSTOM_25_LANDMARK_SPECS
]


def convert_33_to_custom_25(
    keypoints: np.ndarray,
    invert_xy: bool = True
) -> np.ndarray:
    keypoints_np = np.asarray(keypoints, dtype=np.float32)
    if keypoints_np.ndim != 3 or keypoints_np.shape[1:] != (33, 4):
        raise ValueError("Expected keypoints with shape [T, 33, 4].")

    frame_count = keypoints_np.shape[0]
    converted = np.empty(
        (frame_count, len(CUSTOM_25_LANDMARK_SPECS), 3),
        dtype=np.float32
    )

    for joint_idx, (_, source_indices) in enumerate(CUSTOM_25_LANDMARK_SPECS):
        if len(source_indices) == 1:
            converted[:, joint_idx, :] = keypoints_np[:, source_indices[0], :3]
            continue

        source_stack = keypoints_np[:, source_indices, :3]
        converted[:, joint_idx, :] = np.mean(source_stack, axis=1).astype(np.float32)

    if invert_xy:
        converted[:, :, 0] *= -1.0
        converted[:, :, 1] *= -1.0

    return converted


def flatten_custom_25_for_csv(landmarks_25: np.ndarray) -> np.ndarray:
    landmarks_np = np.asarray(landmarks_25, dtype=np.float32)
    expected_shape = (len(CUSTOM_25_LANDMARK_SPECS), 3)
    if landmarks_np.ndim != 3 or landmarks_np.shape[1:] != expected_shape:
        raise ValueError(
            f"Expected landmarks with shape [T, {expected_shape[0]}, {expected_shape[1]}]."
        )

    return landmarks_np.reshape(landmarks_np.shape[0], -1)

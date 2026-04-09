import type { PoseKeypoint } from "../types/pose";

export interface CaptureCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface CaptureReadiness {
  ready: boolean;
  checks: CaptureCheck[];
  summary: string;
}

function distance2D(a: PoseKeypoint, b: PoseKeypoint): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function inFrame(point: PoseKeypoint, margin = 0.04): boolean {
  return (
    point[0] >= margin &&
    point[0] <= 1 - margin &&
    point[1] >= margin &&
    point[1] <= 1 - margin
  );
}

export function evaluateCaptureReadiness(
  keypoints: PoseKeypoint[] | null,
  nativeDetectorReady: boolean
): CaptureReadiness {
  const checks: CaptureCheck[] = [];

  checks.push({
    id: "detector",
    label: "Native detector",
    ok: nativeDetectorReady,
    detail: nativeDetectorReady
      ? "Ready"
      : "Missing native pose plugin"
  });

  if (!keypoints || keypoints.length !== 33) {
    checks.push({
      id: "person",
      label: "Person detected",
      ok: false,
      detail: "Stand fully in camera view"
    });

    return {
      ready: false,
      checks,
      summary:
        "Waiting for a full-body person pose. Increase light, step back, and face the camera."
    };
  }

  const visibilityMean =
    keypoints.reduce((sum, kp) => sum + Math.max(0, Math.min(1, kp[3])), 0) /
    keypoints.length;
  const coreJointIndices = [0, 11, 12, 23, 24, 15, 16, 27, 28];
  const coreVisibilityValues = coreJointIndices.map((idx) =>
    Math.max(0, Math.min(1, keypoints[idx][3]))
  );
  const coreVisibilityMean =
    coreVisibilityValues.reduce((sum, value) => sum + value, 0) /
    coreVisibilityValues.length;
  const coreReliableCount = coreVisibilityValues.filter((value) => value >= 0.35).length;
  const lightingOk = coreVisibilityMean >= 0.42 || coreReliableCount >= 6;
  checks.push({
    id: "lighting",
    label: "Lighting/visibility",
    ok: lightingOk,
    detail: lightingOk
      ? `Good (core ${coreVisibilityMean.toFixed(2)}, overall ${visibilityMean.toFixed(2)})`
      : `Low confidence (core ${coreVisibilityMean.toFixed(2)}, tracked joints ${coreReliableCount}/9)`
  });

  const leftShoulder = keypoints[11];
  const rightShoulder = keypoints[12];
  const leftHip = keypoints[23];
  const rightHip = keypoints[24];
  const shoulderTilt = Math.abs(leftShoulder[1] - rightShoulder[1]);
  const hipTilt = Math.abs(leftHip[1] - rightHip[1]);
  const angleOk = shoulderTilt < 0.1 && hipTilt < 0.1;
  checks.push({
    id: "angle",
    label: "Camera angle",
    ok: angleOk,
    detail: angleOk
      ? "Body is upright"
      : "Keep phone level and face camera"
  });

  const required = [0, 11, 12, 23, 24, 15, 16, 27, 28];
  const framingOk = required.every((idx) => inFrame(keypoints[idx], 0.05));
  checks.push({
    id: "framing",
    label: "Framing",
    ok: framingOk,
    detail: framingOk ? "Full body in frame" : "Move so head, wrists, and ankles stay visible"
  });

  const shoulderCenterX = (leftShoulder[0] + rightShoulder[0]) * 0.5;
  const hipCenterX = (leftHip[0] + rightHip[0]) * 0.5;
  const centeredOk =
    shoulderCenterX >= 0.3 &&
    shoulderCenterX <= 0.7 &&
    hipCenterX >= 0.3 &&
    hipCenterX <= 0.7;
  checks.push({
    id: "centering",
    label: "Centering",
    ok: centeredOk,
    detail: centeredOk ? "Subject centered" : "Center yourself in the preview"
  });

  const shoulderMid: PoseKeypoint = [
    (leftShoulder[0] + rightShoulder[0]) * 0.5,
    (leftShoulder[1] + rightShoulder[1]) * 0.5,
    0,
    1
  ];
  const hipMid: PoseKeypoint = [
    (leftHip[0] + rightHip[0]) * 0.5,
    (leftHip[1] + rightHip[1]) * 0.5,
    0,
    1
  ];
  const torsoSize = distance2D(shoulderMid, hipMid);
  const distanceOk = torsoSize >= 0.14 && torsoSize <= 0.42;
  checks.push({
    id: "distance",
    label: "Distance",
    ok: distanceOk,
    detail: distanceOk ? "Distance is good" : "Move closer/farther until full body is stable"
  });

  const ready = checks.every((item) => item.ok);
  return {
    ready,
    checks,
    summary: ready
      ? "Ready to record."
      : "Adjust the failing check(s) before recording for better pose quality."
  };
}

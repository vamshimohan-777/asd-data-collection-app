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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function inFrame(point: PoseKeypoint, margin = 0.04): boolean {
  return (
    point[0] >= margin &&
    point[0] <= 1 - margin &&
    point[1] >= margin &&
    point[1] <= 1 - margin
  );
}

interface PersonPoseHeuristics {
  torsoVisibilityMean: number;
  torsoReliableCount: number;
  trackedVisibilityMean: number;
  trackedReliableCount: number;
  poseWidth: number;
  poseHeight: number;
  poseAspect: number;
  torsoSize: number;
  shoulderWidth: number;
  hipWidth: number;
  personDetectedOk: boolean;
}

function computePersonPoseHeuristics(
  keypoints: PoseKeypoint[]
): PersonPoseHeuristics {
  const torsoJointIndices = [0, 11, 12, 23, 24];
  const torsoVisibilityValues = torsoJointIndices.map((idx) =>
    clamp01(keypoints[idx][3])
  );
  const torsoVisibilityMean =
    torsoVisibilityValues.reduce((sum, value) => sum + value, 0) /
    torsoVisibilityValues.length;
  const torsoReliableCount = torsoVisibilityValues.filter((value) => value >= 0.3).length;

  const trackedJointIndices = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
  const trackedVisibilityValues = trackedJointIndices.map((idx) =>
    clamp01(keypoints[idx][3])
  );
  const trackedVisibilityMean =
    trackedVisibilityValues.reduce((sum, value) => sum + value, 0) /
    trackedVisibilityValues.length;
  const trackedReliableCount = trackedVisibilityValues.filter((value) => value >= 0.3).length;

  const leftShoulder = keypoints[11];
  const rightShoulder = keypoints[12];
  const leftHip = keypoints[23];
  const rightHip = keypoints[24];

  const visibleStructuralPoints = trackedJointIndices
    .map((idx) => keypoints[idx])
    .filter((point) => clamp01(point[3]) >= 0.25);
  const xValues = visibleStructuralPoints.map((point) => point[0]);
  const yValues = visibleStructuralPoints.map((point) => point[1]);
  const poseWidth =
    xValues.length >= 4 ? Math.max(...xValues) - Math.min(...xValues) : 0;
  const poseHeight =
    yValues.length >= 4 ? Math.max(...yValues) - Math.min(...yValues) : 0;
  const poseAspect = poseHeight > 1e-6 ? poseWidth / poseHeight : 999;

  const shoulderWidth = distance2D(leftShoulder, rightShoulder);
  const hipWidth = distance2D(leftHip, rightHip);
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
  const shoulderToTorso = shoulderWidth / Math.max(torsoSize, 1e-6);
  const hipToTorso = hipWidth / Math.max(torsoSize, 1e-6);

  // Action-agnostic person checks: avoid "walking/upright only" bias while still rejecting objects.
  const personCoverageOk =
    poseWidth >= 0.12 &&
    poseHeight >= 0.2 &&
    poseAspect >= 0.2 &&
    poseAspect <= 1.8;
  const bodyShapeOk =
    torsoSize >= 0.06 &&
    shoulderWidth >= 0.05 &&
    hipWidth >= 0.03 &&
    shoulderToTorso >= 0.35 &&
    shoulderToTorso <= 3.2 &&
    hipToTorso >= 0.15 &&
    hipToTorso <= 2.4;
  const personDetectedOk =
    torsoReliableCount >= 4 && trackedReliableCount >= 6 && personCoverageOk && bodyShapeOk;

  return {
    torsoVisibilityMean,
    torsoReliableCount,
    trackedVisibilityMean,
    trackedReliableCount,
    poseWidth,
    poseHeight,
    poseAspect,
    torsoSize,
    shoulderWidth,
    hipWidth,
    personDetectedOk
  };
}

export function isLikelyHumanPose(keypoints: PoseKeypoint[] | null): boolean {
  if (!keypoints || keypoints.length !== 33) {
    return false;
  }
  const heuristics = computePersonPoseHeuristics(keypoints);
  const strictCoverageOk =
    heuristics.poseWidth >= 0.2 &&
    heuristics.poseHeight >= 0.22 &&
    heuristics.poseAspect >= 0.22 &&
    heuristics.poseAspect <= 1.65;
  const strictStructureOk =
    heuristics.torsoSize >= 0.1 &&
    heuristics.shoulderWidth >= 0.08 &&
    heuristics.hipWidth >= 0.04;
  return (
    heuristics.personDetectedOk &&
    heuristics.torsoReliableCount >= 5 &&
    heuristics.trackedReliableCount >= 8 &&
    strictCoverageOk &&
    strictStructureOk
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
    keypoints.reduce((sum, kp) => sum + clamp01(kp[3]), 0) / keypoints.length;
  const {
    torsoVisibilityMean,
    torsoReliableCount,
    trackedVisibilityMean,
    trackedReliableCount,
    poseWidth,
    poseHeight,
    poseAspect,
    torsoSize,
    shoulderWidth,
    hipWidth,
    personDetectedOk
  } = computePersonPoseHeuristics(keypoints);

  const leftShoulder = keypoints[11];
  const rightShoulder = keypoints[12];
  const leftHip = keypoints[23];
  const rightHip = keypoints[24];

  checks.push({
    id: "person",
    label: "Person detected",
    ok: personDetectedOk,
    detail: personDetectedOk
      ? "Person pose detected"
      : `Need clearer person pose (width ${poseWidth.toFixed(2)}, height ${poseHeight.toFixed(2)}, aspect ${poseAspect.toFixed(2)})`
  });

  const lightingOk = torsoVisibilityMean >= 0.35 || trackedReliableCount >= 6;
  checks.push({
    id: "lighting",
    label: "Lighting/visibility",
    ok: lightingOk,
    detail: lightingOk
      ? `Good (torso ${torsoVisibilityMean.toFixed(2)}, tracked ${trackedVisibilityMean.toFixed(2)}, overall ${visibilityMean.toFixed(2)})`
      : `Low confidence (torso ${torsoVisibilityMean.toFixed(2)}, tracked joints ${trackedReliableCount}/13)`
  });

  const structureOk = torsoSize >= 0.06 && shoulderWidth >= 0.05 && hipWidth >= 0.03;
  checks.push({
    id: "angle",
    label: "Pose structure",
    ok: structureOk,
    detail: structureOk
      ? "Pose structure is stable"
      : "Move a bit closer and keep torso visible"
  });

  const torsoRequired = [0, 11, 12, 23, 24];
  const limbOptional = [15, 16, 27, 28];
  const torsoFramingOk = torsoRequired.every((idx) => inFrame(keypoints[idx], 0.03));
  const limbVisibleCount = limbOptional.filter((idx) => inFrame(keypoints[idx], 0.01)).length;
  const framingOk = torsoFramingOk && limbVisibleCount >= 1;
  checks.push({
    id: "framing",
    label: "Framing",
    ok: framingOk,
    detail: framingOk
      ? "Torso and at least one limb are visible"
      : "Keep head/torso visible and at least one limb inside frame"
  });

  const shoulderCenterX = (leftShoulder[0] + rightShoulder[0]) * 0.5;
  const hipCenterX = (leftHip[0] + rightHip[0]) * 0.5;
  const centeredOk =
    shoulderCenterX >= 0.18 &&
    shoulderCenterX <= 0.82 &&
    hipCenterX >= 0.18 &&
    hipCenterX <= 0.82;
  checks.push({
    id: "centering",
    label: "Centering",
    ok: centeredOk,
    detail: centeredOk ? "Subject centered" : "Center yourself in the preview"
  });

  const distanceOk = torsoSize >= 0.08 && torsoSize <= 0.5;
  checks.push({
    id: "distance",
    label: "Distance",
    ok: distanceOk,
    detail: distanceOk
      ? "Distance is good"
      : `Move closer/farther until torso size is stable (${torsoSize.toFixed(2)})`
  });

  const ready = checks.every((item) => item.ok);
  return {
    ready,
    checks,
    summary: ready
      ? "Ready to record."
      : "Adjust the failing check(s). This workflow supports multiple actions, not only walking."
  };
}

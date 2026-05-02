import { PoseLandmarkerResult } from '@mediapipe/tasks-vision';

export interface ReadinessCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface ReadinessResult {
  ready: boolean;
  summary: string;
  checks: ReadinessCheck[];
}

export function evaluateCaptureReadiness(
  results: PoseLandmarkerResult | null,
  detectorReady: boolean
): ReadinessResult {
  const checks: ReadinessCheck[] = [
    {
      id: 'detector',
      label: 'Detector',
      ok: detectorReady,
      detail: detectorReady ? 'Loaded' : 'Initializing...'
    }
  ];

  if (!detectorReady || !results || !results.landmarks || results.landmarks.length === 0) {
    checks.push({
      id: 'visibility',
      label: 'Body Visible',
      ok: false,
      detail: 'No person detected'
    });
    return {
      ready: false,
      summary: detectorReady ? 'Please stand in front of the camera' : 'Initializing AI...',
      checks
    };
  }

  const landmarks = results.landmarks[0];
  
  // Basic visibility check for critical joints (ankles, knees, hips, shoulders)
  // Indices: 27,28 (ankles), 25,26 (knees), 23,24 (hips), 11,12 (shoulders)
  const criticalIndices = [11, 12, 23, 24, 25, 26, 27, 28];
  const visibleCount = criticalIndices.filter(i => (landmarks[i]?.visibility ?? 0) > 0.5).length;
  const bodyVisible = visibleCount >= 6;

  checks.push({
    id: 'visibility',
    label: 'Body Visible',
    ok: bodyVisible,
    detail: bodyVisible ? 'Good' : 'Full body must be visible'
  });

  const ready = detectorReady && bodyVisible;

  return {
    ready,
    summary: ready ? 'Ready to record' : 'Adjust your position',
    checks
  };
}

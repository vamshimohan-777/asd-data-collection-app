import {
  VisionCameraProxy,
  type Frame,
  type FrameProcessorPlugin
} from "react-native-vision-camera";

import type { PoseKeypoint } from "../types/pose";

// Keep this false for production/data collection. Turn on only for UI pipeline smoke tests.
const ENABLE_MOCK_FALLBACK = false;

type NativeLandmark = {
  x: number;
  y: number;
  z: number;
  visibility?: number;
};

type NativePoseResult =
  | null
  | number[][]
  | {
      keypoints?: number[][];
      landmarks?: NativeLandmark[];
      poses?: Array<{
        keypoints?: number[][];
        landmarks?: NativeLandmark[];
      }>;
    };

export interface PoseDetectionResult {
  keypoints: PoseKeypoint[];
  sourceWidth?: number;
  sourceHeight?: number;
  isMirrored?: boolean;
}

declare global {
  var __blazePoseGhum3DDetect:
    | ((frame: Frame) => NativePoseResult)
    | undefined;
}

type PosePluginCandidate = {
  name: string;
  initOptions?: Record<string, unknown>;
  callOptions?: Record<string, unknown>;
};

const POSE_PLUGIN_CANDIDATES: PosePluginCandidate[] = [
  {
    name: "PoseDetection",
    initOptions: { mode: "stream", performanceMode: "fast" },
    callOptions: { mode: "stream", performanceMode: "fast" }
  },
  {
    name: "poseDetection",
    initOptions: { mode: "stream", performanceMode: "fast" },
    callOptions: { mode: "stream", performanceMode: "fast" }
  },
  { name: "poseDetector", initOptions: {}, callOptions: {} },
  { name: "detectPose", initOptions: {}, callOptions: {} },
  { name: "detectPoses", initOptions: {}, callOptions: {} },
  { name: "scanPose", initOptions: {}, callOptions: {} },
  { name: "scanPoses", initOptions: {}, callOptions: {} },
  { name: "mlkitPoseDetection", initOptions: {}, callOptions: {} }
];

let nativePosePlugin: FrameProcessorPlugin | undefined;
let nativePosePluginCallOptions: Record<string, unknown> | undefined;
let nativePosePluginName: string | undefined;

for (const candidate of POSE_PLUGIN_CANDIDATES) {
  try {
    const plugin = VisionCameraProxy.initFrameProcessorPlugin(
      candidate.name,
      (candidate.initOptions ?? {}) as Record<string, string | number | boolean>
    );
    if (plugin) {
      nativePosePlugin = plugin;
      nativePosePluginCallOptions = candidate.callOptions;
      nativePosePluginName = candidate.name;
      break;
    }
  } catch {
    // Try next candidate name.
  }
}

const BASE_MOCK_KEYPOINTS: PoseKeypoint[] = [
  [0.50, 0.19, -0.10, 0.99],
  [0.48, 0.17, -0.09, 0.98],
  [0.47, 0.17, -0.09, 0.98],
  [0.46, 0.17, -0.09, 0.97],
  [0.52, 0.17, -0.09, 0.98],
  [0.53, 0.17, -0.09, 0.98],
  [0.54, 0.17, -0.09, 0.97],
  [0.43, 0.19, -0.08, 0.96],
  [0.57, 0.19, -0.08, 0.96],
  [0.48, 0.22, -0.08, 0.96],
  [0.52, 0.22, -0.08, 0.96],
  [0.44, 0.30, -0.05, 0.97],
  [0.56, 0.30, -0.05, 0.97],
  [0.39, 0.40, -0.02, 0.95],
  [0.61, 0.40, -0.02, 0.95],
  [0.36, 0.50, 0.01, 0.93],
  [0.64, 0.50, 0.01, 0.93],
  [0.35, 0.52, 0.02, 0.90],
  [0.65, 0.52, 0.02, 0.90],
  [0.34, 0.51, 0.02, 0.90],
  [0.66, 0.51, 0.02, 0.90],
  [0.35, 0.49, 0.01, 0.90],
  [0.65, 0.49, 0.01, 0.90],
  [0.46, 0.54, 0.00, 0.98],
  [0.54, 0.54, 0.00, 0.98],
  [0.45, 0.70, 0.05, 0.96],
  [0.55, 0.70, 0.05, 0.96],
  [0.45, 0.86, 0.09, 0.94],
  [0.55, 0.86, 0.09, 0.94],
  [0.44, 0.89, 0.10, 0.92],
  [0.56, 0.89, 0.10, 0.92],
  [0.46, 0.92, 0.12, 0.91],
  [0.54, 0.92, 0.12, 0.91]
];

function clamp(value: number, minValue: number, maxValue: number): number {
  "worklet";
  return Math.max(minValue, Math.min(maxValue, value));
}

function sanitizeTuple(
  x: number,
  y: number,
  z: number,
  visibility: number
): PoseKeypoint {
  "worklet";
  return [
    clamp(Number.isFinite(x) ? x : 0, 0, 1),
    clamp(Number.isFinite(y) ? y : 0, 0, 1),
    Number.isFinite(z) ? z : 0,
    clamp(Number.isFinite(visibility) ? visibility : 0, 0, 1)
  ];
}

function tryParseArray(result: number[][]): PoseKeypoint[] | null {
  "worklet";
  if (result.length !== 33) {
    return null;
  }

  const parsed: PoseKeypoint[] = [];
  for (let i = 0; i < 33; i += 1) {
    const item = result[i];
    if (!item || item.length < 4) {
      return null;
    }
    parsed.push(sanitizeTuple(item[0], item[1], item[2], item[3]));
  }
  return parsed;
}

function tryParseLandmarks(result: NativeLandmark[]): PoseKeypoint[] | null {
  "worklet";
  if (result.length !== 33) {
    return null;
  }

  const out: PoseKeypoint[] = [];
  for (let i = 0; i < result.length; i += 1) {
    const item = result[i];
    out.push(sanitizeTuple(item.x, item.y, item.z, item.visibility ?? 1));
  }
  return out;
}

function withOptionalSourceSize(
  keypoints: PoseKeypoint[],
  result: unknown
): PoseDetectionResult {
  "worklet";
  const out: PoseDetectionResult = { keypoints };
  if (result && typeof result === "object") {
    const maybeSource = result as {
      sourceWidth?: number;
      sourceHeight?: number;
      isMirrored?: boolean;
    };
    if (
      Number.isFinite(maybeSource.sourceWidth) &&
      Number.isFinite(maybeSource.sourceHeight)
    ) {
      out.sourceWidth = Number(maybeSource.sourceWidth);
      out.sourceHeight = Number(maybeSource.sourceHeight);
    }
    if (typeof maybeSource.isMirrored === "boolean") {
      out.isMirrored = maybeSource.isMirrored;
    }
  }
  return out;
}

function tryParsePluginPoseResult(result: unknown): PoseDetectionResult | null {
  "worklet";
  if (!result) {
    return null;
  }

  if (Array.isArray(result)) {
    if (result.length === 33 && Array.isArray(result[0])) {
      const parsed = tryParseArray(result as number[][]);
      return parsed ? { keypoints: parsed } : null;
    }
    if (result.length > 0) {
      const first = result[0] as unknown;
      if (Array.isArray(first) && first.length === 33 && Array.isArray(first[0])) {
        const parsed = tryParseArray(first as number[][]);
        return parsed ? { keypoints: parsed } : null;
      }
      if (first && typeof first === "object") {
        const maybeFirst = first as {
          keypoints?: number[][];
          landmarks?: NativeLandmark[];
        };
        if (maybeFirst.keypoints) {
          const parsed = tryParseArray(maybeFirst.keypoints);
          return parsed ? withOptionalSourceSize(parsed, maybeFirst) : null;
        }
        if (maybeFirst.landmarks) {
          const parsed = tryParseLandmarks(maybeFirst.landmarks);
          return parsed ? withOptionalSourceSize(parsed, maybeFirst) : null;
        }
      }
    }
  }

  if (typeof result === "object") {
    const typed = result as {
      keypoints?: number[][];
      landmarks?: NativeLandmark[];
      poses?: Array<{
        keypoints?: number[][];
        landmarks?: NativeLandmark[];
      }>;
    };
    if (typed && Array.isArray(typed.keypoints)) {
      const parsed = tryParseArray(typed.keypoints);
      return parsed ? withOptionalSourceSize(parsed, typed) : null;
    }
    if (typed && Array.isArray(typed.landmarks)) {
      const parsed = tryParseLandmarks(typed.landmarks);
      return parsed ? withOptionalSourceSize(parsed, typed) : null;
    }
    if (typed && Array.isArray(typed.poses) && typed.poses.length > 0) {
      const firstPose = typed.poses[0];
      if (firstPose.keypoints) {
        const parsed = tryParseArray(firstPose.keypoints);
        return parsed ? withOptionalSourceSize(parsed, firstPose) : null;
      }
      if (firstPose.landmarks) {
        const parsed = tryParseLandmarks(firstPose.landmarks);
        return parsed ? withOptionalSourceSize(parsed, firstPose) : null;
      }
    }
  }

  return null;
}

function createMockPose(timestampRaw: number): PoseKeypoint[] {
  "worklet";
  const timestamp = Number.isFinite(timestampRaw) ? timestampRaw : 0;
  const sway = Math.sin(timestamp * 0.002) * 0.018;
  const breathe = Math.sin(timestamp * 0.0013) * 0.01;

  const out: PoseKeypoint[] = [];
  for (let i = 0; i < BASE_MOCK_KEYPOINTS.length; i += 1) {
    const base = BASE_MOCK_KEYPOINTS[i];
    const side = i % 2 === 0 ? 1 : -1;
    const yOffset = i >= 25 ? breathe : breathe * 0.5;
    out.push(
      sanitizeTuple(base[0] + side * sway, base[1] + yOffset, base[2], base[3])
    );
  }
  return out;
}

export function isNativePoseDetectorConfigured(): boolean {
  return (
    typeof global.__blazePoseGhum3DDetect === "function" ||
    nativePosePlugin != null
  );
}

export function getNativePoseDetectorName(): string {
  if (typeof global.__blazePoseGhum3DDetect === "function") {
    return "__blazePoseGhum3DDetect";
  }
  if (nativePosePluginName) {
    return nativePosePluginName;
  }
  return "none";
}

export function detectPoseResult(frame: Frame): PoseDetectionResult | null {
  "worklet";

  // TODO(MediaPipe integration):
  // 1) Install/build a native VisionCamera frame-processor plugin that runs
  //    BlazePose GHUM 3D on-device.
  // 2) Register a global JSI callable:
  //      global.__blazePoseGhum3DDetect(frame) -> 33 keypoints
  // 3) Keep this function unchanged; it will automatically use native output.
  const detector = global.__blazePoseGhum3DDetect;
  if (typeof detector === "function") {
    const nativeResult = detector(frame);
    if (Array.isArray(nativeResult)) {
      const parsed = tryParseArray(nativeResult);
      return parsed ? { keypoints: parsed } : null;
    }

    if (nativeResult && Array.isArray(nativeResult.keypoints)) {
      const parsed = tryParseArray(nativeResult.keypoints);
      return parsed ? withOptionalSourceSize(parsed, nativeResult) : null;
    }

    if (nativeResult && Array.isArray(nativeResult.landmarks)) {
      if (nativeResult.landmarks.length === 33) {
        const landmarksOut: PoseKeypoint[] = [];
        for (let i = 0; i < nativeResult.landmarks.length; i += 1) {
          const lm = nativeResult.landmarks[i];
          landmarksOut.push(
            sanitizeTuple(lm.x, lm.y, lm.z, lm.visibility ?? 1)
          );
        }
        return withOptionalSourceSize(landmarksOut, nativeResult);
      }
    }
  }

  if (nativePosePlugin) {
    try {
      const pluginResult = nativePosePlugin.call(
        frame,
        (nativePosePluginCallOptions ?? {}) as Record<string, string | number | boolean>
      );
      const parsed = tryParsePluginPoseResult(pluginResult);
      if (parsed && parsed.keypoints.length === 33) {
        return parsed;
      }
    } catch {
      // Ignore plugin call errors and continue to fallback path.
    }
  }

  if (ENABLE_MOCK_FALLBACK) {
    return {
      keypoints: createMockPose(Number(frame.timestamp ?? 0))
    };
  }

  return null;
}

export function detectPoseKeypoints(frame: Frame): PoseKeypoint[] | null {
  "worklet";
  const result = detectPoseResult(frame);
  return result ? result.keypoints : null;
}

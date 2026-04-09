import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrameProcessor } from "react-native-vision-camera";
import { Worklets } from "react-native-worklets-core";

import { detectPoseResult } from "../pose/blazePoseWorklet";
import type {
  LocalCapturePaths,
  PoseCaptureMeta,
  PoseFrameSample,
  PoseKeypoint,
  PoseUploadPayload,
  PoseUploadResponse
} from "../types/pose";
import { uploadCapture } from "../utils/api";
import {
  countPendingCaptures,
  listPendingCaptureIds,
  loadPendingCapturePayload,
  removePendingCapture,
  saveCaptureForPendingUpload,
  saveCaptureToLocalArchive
} from "../utils/storage";

interface RecorderConfig {
  backendUrl: string;
  fpsNominal: number;
  resolution: [number, number];
  cameraFacing: "front" | "back";
  deviceName: string;
  sessionId?: string;
  participantAge?: number;
  participantGender?: PoseCaptureMeta["gender"];
}

interface RecorderStats {
  framesCaptured: number;
  droppedFrames: number;
  actualFps: number;
  durationMs: number;
}

interface StopRecordingOptions {
  uploadToBackend?: boolean;
}

interface StopForReviewResult {
  payload: PoseUploadPayload;
  framesCaptured: number;
  durationMs: number;
}

interface StopRecordingResult {
  payload: PoseUploadPayload;
  localCapture: LocalCapturePaths;
  upload?: PoseUploadResponse;
  keptLocal: boolean;
  pendingUploads: number;
}

interface SyncPendingResult {
  uploaded: number;
  failed: number;
  remaining: number;
}

const EMPTY_STATS: RecorderStats = {
  framesCaptured: 0,
  droppedFrames: 0,
  actualFps: 0,
  durationMs: 0
};

function normalizeTimestampMs(rawValue: number, fallbackMs: number): number {
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return fallbackMs;
  }
  if (rawValue > 1e14) {
    return rawValue / 1e6;
  }
  if (rawValue > 1e11) {
    return rawValue / 1e3;
  }
  if (rawValue > 1e6) {
    return rawValue;
  }
  return rawValue * 1000;
}

function normalizeResolution(
  widthRaw: number,
  heightRaw: number
): [number, number] | null {
  const width = Math.round(Number(widthRaw));
  const height = Math.round(Number(heightRaw));
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width < 1 || height < 1) {
    return null;
  }
  return [width, height];
}

export function usePoseRecorder(config: RecorderConfig): {
  frameProcessor: ReturnType<typeof useFrameProcessor>;
  isRecording: boolean;
  isUploading: boolean;
  hasStoppedRecording: boolean;
  stoppedRecordingFrames: number;
  stats: RecorderStats;
  latestKeypoints: PoseKeypoint[] | null;
  latestFrameResolution: [number, number] | null;
  latestFrameMirrored: boolean;
  recordingResolution: [number, number] | null;
  lastJsonPath: string | null;
  lastUpload: PoseUploadResponse | null;
  lastError: string | null;
  pendingUploadsCount: number;
  startRecording: () => void;
  stopRecordingForReview: () => Promise<StopForReviewResult>;
  commitStoppedRecording: (
    options?: StopRecordingOptions
  ) => Promise<StopRecordingResult>;
  discardStoppedRecording: () => void;
  stopRecording: (options?: StopRecordingOptions) => Promise<StopRecordingResult>;
  syncPendingUploads: () => Promise<SyncPendingResult>;
} {
  const configRef = useRef(config);
  const recordingRef = useRef(false);
  const samplesRef = useRef<PoseFrameSample[]>([]);
  const startTimestampRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number | null>(null);
  const emaDeltaRef = useRef<number | null>(null);
  const droppedFrameRef = useRef(0);
  const stoppedPayloadRef = useRef<PoseUploadPayload | null>(null);
  const previewFrameCounterRef = useRef(0);
  const lastPoseSeenAtRef = useRef(0);
  const latestFrameResolutionRef = useRef<[number, number] | null>(null);
  const latestFrameMirroredRef = useRef(false);
  const recordingResolutionRef = useRef<[number, number] | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [hasStoppedRecording, setHasStoppedRecording] = useState(false);
  const [stoppedRecordingFrames, setStoppedRecordingFrames] = useState(0);
  const [stats, setStats] = useState<RecorderStats>(EMPTY_STATS);
  const [latestKeypoints, setLatestKeypoints] = useState<PoseKeypoint[] | null>(
    null
  );
  const [latestFrameResolution, setLatestFrameResolution] = useState<[
    number,
    number
  ] | null>(null);
  const [latestFrameMirrored, setLatestFrameMirrored] = useState(false);
  const [recordingResolution, setRecordingResolution] = useState<[
    number,
    number
  ] | null>(null);
  const [lastJsonPath, setLastJsonPath] = useState<string | null>(null);
  const [lastUpload, setLastUpload] = useState<PoseUploadResponse | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [pendingUploadsCount, setPendingUploadsCount] = useState(0);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const refreshPendingCount = useCallback(async (): Promise<number> => {
    const count = await countPendingCaptures();
    setPendingUploadsCount(count);
    return count;
  }, []);

  useEffect(() => {
    refreshPendingCount().catch(() => {
      // Non-fatal. The queue count will refresh on next save/upload.
    });
  }, [refreshPendingCount]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (latestKeypoints && Date.now() - lastPoseSeenAtRef.current > 1200) {
        setLatestKeypoints(null);
      }
    }, 800);

    return () => clearInterval(interval);
  }, [latestKeypoints]);

  const syncStatsToState = useCallback(() => {
    const framesCaptured = samplesRef.current.length;
    const startTs = startTimestampRef.current;
    const endTs = lastTimestampRef.current;
    const durationMs =
      startTs !== null && endTs !== null && endTs >= startTs ? endTs - startTs : 0;
    const actualFps =
      emaDeltaRef.current && emaDeltaRef.current > 0
        ? 1000 / emaDeltaRef.current
        : 0;

    setStats({
      framesCaptured,
      droppedFrames: droppedFrameRef.current,
      actualFps,
      durationMs
    });
  }, []);

  const onPoseFrame = useCallback(
    (
      timestampRaw: number,
      keypoints: PoseKeypoint[],
      frameWidthRaw: number,
      frameHeightRaw: number,
      frameIsMirroredRaw: boolean
    ) => {
      const nowMs = Date.now();
      lastPoseSeenAtRef.current = nowMs;
      const frameResolution = normalizeResolution(frameWidthRaw, frameHeightRaw);

      if (frameResolution) {
        const previousResolution = latestFrameResolutionRef.current;
        if (
          !previousResolution ||
          previousResolution[0] !== frameResolution[0] ||
          previousResolution[1] !== frameResolution[1]
        ) {
          latestFrameResolutionRef.current = frameResolution;
          setLatestFrameResolution(frameResolution);
        }
      }
      const frameIsMirrored = Boolean(frameIsMirroredRaw);
      if (latestFrameMirroredRef.current !== frameIsMirrored) {
        latestFrameMirroredRef.current = frameIsMirrored;
        setLatestFrameMirrored(frameIsMirrored);
      }

      previewFrameCounterRef.current += 1;
      if (previewFrameCounterRef.current % 3 === 0) {
        setLatestKeypoints(keypoints);
      }

      if (!recordingRef.current) {
        return;
      }

      const timestampMs = normalizeTimestampMs(timestampRaw, nowMs);

      if (startTimestampRef.current === null) {
        startTimestampRef.current = timestampMs;
      }
      if (!recordingResolutionRef.current && frameResolution) {
        recordingResolutionRef.current = frameResolution;
        setRecordingResolution(frameResolution);
      }

      const previousTs = lastTimestampRef.current;
      if (previousTs !== null) {
        const delta = timestampMs - previousTs;
        if (delta > 0) {
          const expectedDelta = 1000 / configRef.current.fpsNominal;
          const ema = emaDeltaRef.current;
          emaDeltaRef.current = ema === null ? delta : ema * 0.9 + delta * 0.1;

          if (delta > expectedDelta * 1.5) {
            const dropped = Math.max(0, Math.round(delta / expectedDelta) - 1);
            droppedFrameRef.current += dropped;
          }
        }
      }

      lastTimestampRef.current = timestampMs;
      samplesRef.current.push({
        keypoints,
        timestamp: timestampMs
      });

      const frameCount = samplesRef.current.length;
      if (frameCount % 6 === 0) {
        syncStatsToState();
      }
    },
    [syncStatsToState]
  );

  const emitPoseToJs = useMemo(() => Worklets.createRunOnJS(onPoseFrame), [
    onPoseFrame
  ]);

  const frameProcessor = useFrameProcessor(
    (frame) => {
      "worklet";
      const detection = detectPoseResult(frame);
      if (!detection || detection.keypoints.length !== 33) {
        return;
      }
      const sourceWidth = Number(detection.sourceWidth ?? frame.width ?? 0);
      const sourceHeight = Number(detection.sourceHeight ?? frame.height ?? 0);
      const isMirrored = Boolean(detection.isMirrored ?? frame.isMirrored ?? false);
      emitPoseToJs(
        Number(frame.timestamp ?? 0),
        detection.keypoints,
        sourceWidth,
        sourceHeight,
        isMirrored
      );
    },
    [emitPoseToJs]
  );

  const buildPayloadFromCurrentSamples = useCallback((): PoseUploadPayload => {
    const samples = samplesRef.current.slice();
    if (samples.length === 0) {
      throw new Error("No pose frames were captured.");
    }

    const resolvedResolution =
      recordingResolutionRef.current ??
      latestFrameResolutionRef.current ??
      configRef.current.resolution;

    const meta: PoseCaptureMeta = {
      fps_nominal: configRef.current.fpsNominal,
      resolution: resolvedResolution,
      device: configRef.current.deviceName,
      camera_facing: configRef.current.cameraFacing,
      session_id: configRef.current.sessionId,
      age: configRef.current.participantAge,
      gender: configRef.current.participantGender
    };

    return {
      keypoints: samples.map((sample) => sample.keypoints),
      timestamps: samples.map((sample) => sample.timestamp),
      meta
    };
  }, []);

  const startRecording = useCallback(() => {
    samplesRef.current = [];
    startTimestampRef.current = null;
    lastTimestampRef.current = null;
    emaDeltaRef.current = null;
    droppedFrameRef.current = 0;
    stoppedPayloadRef.current = null;
    recordingResolutionRef.current = null;

    setLastError(null);
    setLastUpload(null);
    setLastJsonPath(null);
    setHasStoppedRecording(false);
    setStoppedRecordingFrames(0);
    setRecordingResolution(null);
    setStats(EMPTY_STATS);
    setIsRecording(true);
    recordingRef.current = true;
  }, []);

  const stopRecordingForReview = useCallback(
    async (): Promise<StopForReviewResult> => {
      recordingRef.current = false;
      setIsRecording(false);
      syncStatsToState();

      const payload = buildPayloadFromCurrentSamples();
      stoppedPayloadRef.current = payload;
      setHasStoppedRecording(true);
      setStoppedRecordingFrames(payload.timestamps.length);

      const startTs = payload.timestamps[0] ?? 0;
      const endTs = payload.timestamps[payload.timestamps.length - 1] ?? startTs;
      const durationMs = Math.max(0, endTs - startTs);

      return {
        payload,
        framesCaptured: payload.timestamps.length,
        durationMs
      };
    },
    [buildPayloadFromCurrentSamples, syncStatsToState]
  );

  const commitStoppedRecording = useCallback(
    async (options?: StopRecordingOptions): Promise<StopRecordingResult> => {
      const shouldUpload = options?.uploadToBackend ?? true;
      const payload = stoppedPayloadRef.current ?? buildPayloadFromCurrentSamples();
      stoppedPayloadRef.current = payload;

      const localCapture = await saveCaptureToLocalArchive(payload);
      setLastJsonPath(localCapture.json_path);

      let uploadResult: PoseUploadResponse | undefined;

      if (shouldUpload) {
        setIsUploading(true);
        try {
          uploadResult = await uploadCapture(payload, configRef.current.backendUrl);
          setLastUpload(uploadResult);
          setLastError(null);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setLastError(message);
          await saveCaptureForPendingUpload(payload);
        } finally {
          setIsUploading(false);
        }
      } else {
        await saveCaptureForPendingUpload(payload);
      }

      const pendingUploads = await refreshPendingCount();
      stoppedPayloadRef.current = null;
      setHasStoppedRecording(false);
      setStoppedRecordingFrames(0);
      return {
        payload,
        localCapture,
        upload: uploadResult,
        keptLocal: true,
        pendingUploads
      };
    },
    [buildPayloadFromCurrentSamples, refreshPendingCount]
  );

  const discardStoppedRecording = useCallback(() => {
    recordingRef.current = false;
    stoppedPayloadRef.current = null;
    samplesRef.current = [];
    startTimestampRef.current = null;
    lastTimestampRef.current = null;
    emaDeltaRef.current = null;
    droppedFrameRef.current = 0;
    recordingResolutionRef.current = null;

    setIsRecording(false);
    setHasStoppedRecording(false);
    setStoppedRecordingFrames(0);
    setRecordingResolution(null);
    setStats(EMPTY_STATS);
  }, []);

  const stopRecording = useCallback(
    async (options?: StopRecordingOptions): Promise<StopRecordingResult> => {
      await stopRecordingForReview();
      return commitStoppedRecording(options);
    },
    [commitStoppedRecording, stopRecordingForReview]
  );

  const syncPendingUploads = useCallback(async (): Promise<SyncPendingResult> => {
    const ids = await listPendingCaptureIds();
    if (ids.length === 0) {
      return {
        uploaded: 0,
        failed: 0,
        remaining: 0
      };
    }

    let uploaded = 0;
    let failed = 0;
    let lastUploadResult: PoseUploadResponse | null = null;
    let lastSyncError: string | null = null;

    setIsUploading(true);
    try {
      for (const captureId of ids) {
        try {
          const payload = await loadPendingCapturePayload(captureId);
          const result = await uploadCapture(payload, configRef.current.backendUrl);
          await removePendingCapture(captureId);
          lastUploadResult = result;
          uploaded += 1;
        } catch (error) {
          failed += 1;
          lastSyncError = error instanceof Error ? error.message : String(error);
        }
      }
    } finally {
      setIsUploading(false);
    }

    if (lastUploadResult) {
      setLastUpload(lastUploadResult);
    }
    if (lastSyncError) {
      setLastError(lastSyncError);
    } else if (uploaded > 0) {
      setLastError(null);
    }

    const remaining = await refreshPendingCount();
    return {
      uploaded,
      failed,
      remaining
    };
  }, [refreshPendingCount]);

  return {
    frameProcessor,
    isRecording,
    isUploading,
    hasStoppedRecording,
    stoppedRecordingFrames,
    stats,
    latestKeypoints,
    latestFrameResolution,
    latestFrameMirrored,
    recordingResolution,
    lastJsonPath,
    lastUpload,
    lastError,
    pendingUploadsCount,
    startRecording,
    stopRecordingForReview,
    commitStoppedRecording,
    discardStoppedRecording,
    stopRecording,
    syncPendingUploads
  };
}

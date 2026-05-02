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
  PoseUploadResponse,
  PoseCaptureMetadata
} from "../types/pose";
import {
  countPendingCaptures,
  listPendingCaptureIds,
  loadPendingCapturePayload,
  removePendingCapture,
  saveCaptureForPendingUpload,
  saveCaptureToLocalArchive
} from "../utils/storage";
import { supabase } from "../utils/supabase";

interface RecorderConfig {
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
  metaOverride?: {
    session_id?: string;
    age?: number;
    gender?: PoseCaptureMeta["gender"];
  };
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

const MIN_VALID_POSE_STREAK = 6;
const MAX_INVALID_POSE_STREAK = 1;
const PREVIEW_EMIT_EVERY_N_VALID_FRAMES = 2;
const STALE_POSE_CLEAR_MS = 300;
const STALE_CHECK_INTERVAL_MS = 120;

async function uploadToSupabaseDirect(
  payload: PoseUploadPayload,
  captureId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const fileName = `${captureId}/raw_capture.json`;
    const jsonStr = JSON.stringify(payload);

    const binaryData = new Uint8Array(unescape(encodeURIComponent(jsonStr)).split('').map(c => c.charCodeAt(0)));

    const { error: storageError } = await supabase.storage
      .from("pose-captures")
      .upload(fileName, binaryData, {
        contentType: "application/json",
        upsert: true,
        cacheControl: '3600'
      });

    if (storageError) {
      return { success: false, error: `Storage: ${storageError.message}` };
    }

    const { error: dbError } = await supabase.from("captures").insert({
      capture_id: captureId,
      meta: payload.meta,
      storage_paths: {
        raw_json: fileName
      }
    });

    if (dbError) {
      return { success: false, error: `DB: ${dbError.message}` };
    }

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

function normalizeTimestampMs(rawValue: number, fallbackMs: number): number {
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return fallbackMs;
  }

  const candidates = [
    rawValue,
    rawValue / 1e3,
    rawValue / 1e6,
    rawValue * 1e3
  ];

  let best = fallbackMs;
  let bestOffset = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (!Number.isFinite(candidate) || candidate <= 0) {
      continue;
    }
    const offset = Math.abs(candidate - fallbackMs);
    if (offset < bestOffset) {
      best = candidate;
      bestOffset = offset;
    }
  }

  const oneDayMs = 24 * 60 * 60 * 1000;
  return bestOffset <= oneDayMs ? best : fallbackMs;
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
  hasStoppedRecording: boolean;
  stoppedRecordingFrames: number;
  stats: RecorderStats;
  latestKeypoints: PoseKeypoint[] | null;
  latestFrameResolution: [number, number] | null;
  latestFrameMirrored: boolean;
  recordingResolution: [number, number] | null;
  lastJsonPath: string | null;
  lastError: string | null;
  pendingUploadsCount: number;
  startRecording: () => void;
  stopRecordingForReview: () => Promise<StopForReviewResult>;
  commitStoppedRecording: (
    metaOverride?: Partial<PoseCaptureMetadata>
  ) => Promise<StopRecordingResult>;
  discardStoppedRecording: () => void;
  stopRecording: (metaOverride?: Partial<PoseCaptureMetadata>) => Promise<StopRecordingResult>;
  syncPendingUploads: () => Promise<SyncPendingResult>;
  isSyncingToSupabase: boolean;
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
  const validPoseStreakRef = useRef(0);
  const invalidPoseStreakRef = useRef(0);
  const lastPoseSeenAtRef = useRef(0);
  const latestFrameResolutionRef = useRef<[number, number] | null>(null);
  const latestFrameMirroredRef = useRef(false);
  const recordingResolutionRef = useRef<[number, number] | null>(null);

  const [isRecording, setIsRecording] = useState(false);
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
  const [lastError, setLastError] = useState<string | null>(null);
  const [pendingUploadsCount, setPendingUploadsCount] = useState(0);
  const [isSyncingToSupabase, setIsSyncingToSupabase] = useState(false);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const refreshPendingCount = useCallback(async (): Promise<number> => {
    const count = await countPendingCaptures();
    setPendingUploadsCount(count);
    return count;
  }, []);

  useEffect(() => {
    refreshPendingCount().catch(() => {});
  }, [refreshPendingCount]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (latestKeypoints && Date.now() - lastPoseSeenAtRef.current > STALE_POSE_CLEAR_MS) {
        setLatestKeypoints(null);
      }
    }, STALE_CHECK_INTERVAL_MS);

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

      validPoseStreakRef.current += 1;
      invalidPoseStreakRef.current = 0;
      if (validPoseStreakRef.current < MIN_VALID_POSE_STREAK) {
        return;
      }

      lastPoseSeenAtRef.current = nowMs;
      previewFrameCounterRef.current += 1;
      if (previewFrameCounterRef.current % PREVIEW_EMIT_EVERY_N_VALID_FRAMES === 0) {
        setLatestKeypoints(keypoints);
      }

      if (!recordingRef.current) {
        return;
      }

      let timestampMs = normalizeTimestampMs(timestampRaw, nowMs);
      const previousTs = lastTimestampRef.current;
      if (previousTs !== null && timestampMs <= previousTs) {
        timestampMs = Math.max(nowMs, previousTs + 1);
      }

      if (startTimestampRef.current === null) {
        startTimestampRef.current = timestampMs;
      }
      if (!recordingResolutionRef.current && frameResolution) {
        recordingResolutionRef.current = frameResolution;
        setRecordingResolution(frameResolution);
      }

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
    validPoseStreakRef.current = 0;
    invalidPoseStreakRef.current = 0;

    setLastError(null);
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
    async (
      metaOverride?: Partial<PoseCaptureMetadata>
    ): Promise<StopRecordingResult> => {
      if (!stoppedPayloadRef.current) {
        throw new Error("No stopped recording to commit.");
      }

      const payload = {
        ...stoppedPayloadRef.current,
        meta: {
          ...stoppedPayloadRef.current.meta,
          ...metaOverride
        }
      };

      stoppedPayloadRef.current = null;
      setHasStoppedRecording(false);
      setStoppedRecordingFrames(0);

      const localCapture = await saveCaptureToLocalArchive(payload);
      setLastJsonPath(localCapture.json_path);
      
      setIsSyncingToSupabase(true);
      const captureId = `mobile_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      
      try {
        const res = await uploadToSupabaseDirect(payload, captureId);
        if (res.success) {
          setLastError(null);
          const pendingCount = await refreshPendingCount();
          return {
            payload,
            localCapture,
            pendingUploads: pendingCount,
            upload: { status: "ok", capture_id: captureId } as any
          };
        } else {
          setLastError(`Supabase Error: ${res.error}`);
          await saveCaptureForPendingUpload(payload);
          const pendingCount = await refreshPendingCount();
          return {
            payload,
            localCapture,
            pendingUploads: pendingCount
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(`Network Exception: ${msg}`);
        await saveCaptureForPendingUpload(payload);
        const pendingCount = await refreshPendingCount();
        return {
          payload,
          localCapture,
          pendingUploads: pendingCount
        };
      } finally {
        setIsSyncingToSupabase(false);
      }
    },
    [refreshPendingCount]
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
    validPoseStreakRef.current = 0;
    invalidPoseStreakRef.current = 0;
    previewFrameCounterRef.current = 0;
    lastPoseSeenAtRef.current = 0;

    setIsRecording(false);
    setHasStoppedRecording(false);
    setStoppedRecordingFrames(0);
    setRecordingResolution(null);
    setStats(EMPTY_STATS);
  }, []);

  const stopRecording = useCallback(
    async (options?: StopRecordingOptions): Promise<StopRecordingResult> => {
      await stopRecordingForReview();
      return commitStoppedRecording(options?.metaOverride);
    },
    [commitStoppedRecording, stopRecordingForReview]
  );

  const syncPendingUploads = useCallback(async (): Promise<SyncPendingResult> => {
    const ids = await listPendingCaptureIds();
    let uploaded = 0;
    let failed = 0;
    let lastSyncError: string | null = null;

    setIsSyncingToSupabase(true);
    try {
      for (const captureId of ids) {
        let payload;

        try {
          payload = await loadPendingCapturePayload(captureId);
        } catch (err) {
          failed += 1;
          continue;
        }

        try {
          const tempId = `mobile_sync_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
          const res = await uploadToSupabaseDirect(payload, tempId);
          if (res.success) {
            await removePendingCapture(captureId);
            uploaded += 1;
          } else {
            failed += 1;
            lastSyncError = res.error || "Supabase Error";
          }
        } catch (err) {
          failed += 1;
          lastSyncError = err instanceof Error ? err.message : String(err);
        }
      }
    } finally {
      setIsSyncingToSupabase(false);
    }

    if (lastSyncError) {
      setLastError(`Sync failed: ${lastSyncError}`);
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
    hasStoppedRecording,
    stoppedRecordingFrames,
    stats,
    latestKeypoints,
    latestFrameResolution,
    latestFrameMirrored,
    recordingResolution,
    lastJsonPath,
    lastError,
    pendingUploadsCount,
    startRecording,
    stopRecordingForReview,
    commitStoppedRecording,
    discardStoppedRecording,
    stopRecording,
    syncPendingUploads,
    isSyncingToSupabase
  };
}

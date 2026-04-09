import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import Constants from "expo-constants";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming
} from "react-native-reanimated";
import {
  Camera,
  CameraDevice,
  CameraDeviceFormat,
  CameraPosition,
  useCameraDevices,
  useCameraPermission
} from "react-native-vision-camera";

import { PoseOverlay } from "../components/PoseOverlay";
import { DEFAULT_BACKEND_URL, NOMINAL_FPS } from "../config";
import { usePoseRecorder } from "../hooks/usePoseRecorder";
import {
  getNativePoseDetectorName,
  isNativePoseDetectorConfigured
} from "../pose/blazePoseWorklet";
import type { ParticipantGender } from "../types/pose";
import { evaluateCaptureReadiness } from "../utils/quality";

type CaptureFlowStep = "home" | "testing" | "recording" | "confirm";

interface ReviewInfo {
  framesCaptured: number;
  durationMs: number;
}

const GENDER_OPTIONS: Array<{ value: ParticipantGender; label: string }> = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "other", label: "Other" },
  { value: "prefer_not_to_say", label: "Prefer not to say" }
];

function pickBestCameraFormat(
  device: CameraDevice | undefined,
  targetFps: number
): CameraDeviceFormat | undefined {
  if (!device || device.formats.length === 0) {
    return undefined;
  }

  const scoreFps = (format: CameraDeviceFormat): number => {
    if (format.minFps <= targetFps && format.maxFps >= targetFps) {
      return 3;
    }
    if (format.maxFps >= targetFps) {
      return 2;
    }
    if (format.maxFps >= 30) {
      return 1;
    }
    return 0;
  };

  let best = device.formats[0];
  for (const candidate of device.formats) {
    const bestTier = scoreFps(best);
    const candidateTier = scoreFps(candidate);

    if (candidateTier > bestTier) {
      best = candidate;
      continue;
    }
    if (candidateTier < bestTier) {
      continue;
    }

    const bestPixels = best.videoWidth * best.videoHeight;
    const candidatePixels = candidate.videoWidth * candidate.videoHeight;
    if (candidatePixels > bestPixels) {
      best = candidate;
      continue;
    }
    if (candidatePixels < bestPixels) {
      continue;
    }

    if (candidate.maxFps > best.maxFps) {
      best = candidate;
    }
  }

  return best;
}

function formatDurationSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0.0";
  }
  return (ms / 1000).toFixed(1);
}

function summarizeSaveResult(
  uploadNow: boolean,
  uploadSucceeded: boolean,
  pendingCount: number
): string {
  if (!uploadNow) {
    return `Saved locally. Pending uploads: ${pendingCount}.`;
  }
  if (uploadSucceeded) {
    return "Saved and uploaded to backend successfully.";
  }
  return `Saved locally, but backend upload failed. Pending uploads: ${pendingCount}.`;
}

export function CameraScreen(): React.ReactElement {
  const { hasPermission, requestPermission } = useCameraPermission();

  const [flowStep, setFlowStep] = useState<CaptureFlowStep>("home");
  const [cameraFacing, setCameraFacing] = useState<CameraPosition>("back");
  const [backendUrl, setBackendUrl] = useState(DEFAULT_BACKEND_URL);
  const [sessionId, setSessionId] = useState("");
  const [participantAgeInput, setParticipantAgeInput] = useState("");
  const [participantGender, setParticipantGender] =
    useState<ParticipantGender>("prefer_not_to_say");
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [isAppActive, setIsAppActive] = useState(true);
  const [permissionStatus, setPermissionStatus] = useState("not-determined");
  const [manualDevices, setManualDevices] = useState<CameraDevice[]>([]);
  const [deviceScanError, setDeviceScanError] = useState<string | null>(null);
  const [reviewInfo, setReviewInfo] = useState<ReviewInfo | null>(null);
  const [isFinalizing, setIsFinalizing] = useState(false);

  const cameraRef = useRef<Camera>(null);
  const pulse = useSharedValue(1);

  const deviceName = useMemo(() => {
    const constants = Platform.constants as { Model?: string; model?: string } | undefined;
    return constants?.Model ?? constants?.model ?? `${Platform.OS}-device`;
  }, []);

  const nativePoseDetectorReady = useMemo(() => isNativePoseDetectorConfigured(), []);
  const nativePoseDetectorName = useMemo(() => getNativePoseDetectorName(), []);
  const hookDevices = useCameraDevices();

  const devices = useMemo(() => {
    if (manualDevices.length > 0) {
      return manualDevices;
    }
    return hookDevices;
  }, [hookDevices, manualDevices]);

  const refreshCameraState = useCallback(() => {
    try {
      setPermissionStatus(Camera.getCameraPermissionStatus());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPermissionStatus(`unknown (${message})`);
    }

    try {
      const latestDevices = Camera.getAvailableCameraDevices();
      setManualDevices(latestDevices);
      setDeviceScanError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setManualDevices([]);
      setDeviceScanError(message);
    }
  }, []);

  const device = useMemo(() => {
    if (devices.length === 0) {
      return undefined;
    }
    return (
      devices.find((item) => item.position === cameraFacing) ??
      devices.find((item) => item.position === "back") ??
      devices.find((item) => item.position === "front") ??
      devices[0]
    );
  }, [cameraFacing, devices]);

  const availableCameraPositions = useMemo(() => {
    if (devices.length === 0) {
      return "none";
    }
    return Array.from(new Set(devices.map((item) => item.position))).join(", ");
  }, [devices]);

  const isLikelyExpoGo = useMemo(() => {
    const constants = Constants as unknown as {
      appOwnership?: string;
      executionEnvironment?: string;
    };
    return (
      constants.appOwnership === "expo" ||
      constants.executionEnvironment === "storeClient"
    );
  }, []);

  const format = useMemo(
    () => pickBestCameraFormat(device, NOMINAL_FPS),
    [device]
  );

  const selectedFps = useMemo(() => {
    if (!format) {
      return NOMINAL_FPS;
    }
    return Math.max(format.minFps, Math.min(NOMINAL_FPS, format.maxFps));
  }, [format]);

  const selectedFormatResolution = useMemo<[number, number]>(() => {
    if (!format) {
      return [0, 0];
    }
    return [format.videoWidth, format.videoHeight];
  }, [format]);

  const participantAge = useMemo(() => {
    const parsed = Number.parseInt(participantAgeInput.trim(), 10);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    if (parsed < 1 || parsed > 120) {
      return undefined;
    }
    return parsed;
  }, [participantAgeInput]);

  const recorder = usePoseRecorder({
    backendUrl,
    fpsNominal: selectedFps,
    resolution:
      selectedFormatResolution[0] > 0 && selectedFormatResolution[1] > 0
        ? selectedFormatResolution
        : [previewSize.width || 1, previewSize.height || 1],
    cameraFacing: cameraFacing === "front" ? "front" : "back",
    deviceName,
    sessionId: sessionId.trim() || undefined,
    participantAge,
    participantGender
  });

  const sourceResolutionForOverlay = useMemo<[number, number]>(() => {
    if (recorder.latestFrameResolution) {
      return recorder.latestFrameResolution;
    }
    return selectedFormatResolution;
  }, [recorder.latestFrameResolution, selectedFormatResolution]);

  const previewIsMirrored = cameraFacing === "front";
  const overlayMirrorX = previewIsMirrored !== recorder.latestFrameMirrored;

  const captureResolutionForSummary = useMemo<[number, number]>(() => {
    if (recorder.recordingResolution) {
      return recorder.recordingResolution;
    }
    if (recorder.latestFrameResolution) {
      return recorder.latestFrameResolution;
    }
    return selectedFormatResolution;
  }, [
    recorder.latestFrameResolution,
    recorder.recordingResolution,
    selectedFormatResolution
  ]);

  const readiness = useMemo(
    () => evaluateCaptureReadiness(recorder.latestKeypoints, nativePoseDetectorReady),
    [nativePoseDetectorReady, recorder.latestKeypoints]
  );

  const requiresCamera = flowStep === "testing" || flowStep === "recording";
  const cameraIsActive = isAppActive && requiresCamera;

  useEffect(() => {
    requestPermission().catch(() => {
      // surfaced in UI
    });
  }, [requestPermission]);

  useEffect(() => {
    refreshCameraState();
  }, [refreshCameraState]);

  useEffect(() => {
    const subscription = Camera.addCameraDevicesChangedListener((nextDevices) => {
      setManualDevices(nextDevices);
      setDeviceScanError(null);
    });
    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (hasPermission) {
      refreshCameraState();
    }
  }, [hasPermission, refreshCameraState]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setIsAppActive(state === "active");
    });
    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (isAppActive) {
      refreshCameraState();
    }
  }, [isAppActive, refreshCameraState]);

  useEffect(() => {
    if (recorder.isRecording) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(1.1, { duration: 350 }),
          withTiming(1, { duration: 350 })
        ),
        -1,
        false
      );
    } else {
      cancelAnimation(pulse);
      pulse.value = withTiming(1, { duration: 140 });
    }
  }, [recorder.isRecording, pulse]);

  const stopButtonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }]
  }));

  const onBeginCaptureFlow = (): void => {
    if (participantAge === undefined) {
      Alert.alert(
        "Participant Metadata Required",
        "Enter a valid age (1-120) before starting capture."
      );
      return;
    }
    setFlowStep("testing");
  };

  const onStartRecording = (): void => {
    setReviewInfo(null);
    if (recorder.hasStoppedRecording) {
      recorder.discardStoppedRecording();
    }
    recorder.startRecording();
    setFlowStep("recording");
  };

  const onStopRecording = async (): Promise<void> => {
    try {
      const result = await recorder.stopRecordingForReview();
      setReviewInfo({
        framesCaptured: result.framesCaptured,
        durationMs: result.durationMs
      });
      setFlowStep("confirm");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Alert.alert("Stop Recording Failed", message);
    }
  };

  const finalizeStoppedRecording = useCallback(
    async (uploadToBackend: boolean): Promise<void> => {
      setIsFinalizing(true);
      try {
        const result = await recorder.commitStoppedRecording({ uploadToBackend });
        const uploadSucceeded = Boolean(result.upload);
        const summary = summarizeSaveResult(
          uploadToBackend,
          uploadSucceeded,
          result.pendingUploads
        );
        Alert.alert(
          "Capture Saved",
          `Frames: ${result.payload.timestamps.length}\nJSON: ${result.localCapture.json_path}\nNPY: ${result.localCapture.keypoints_npy_path}\n${summary}`
        );
        setReviewInfo(null);
        setFlowStep("home");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Alert.alert("Save Failed", message);
      } finally {
        setIsFinalizing(false);
      }
    },
    [recorder]
  );

  const onDiscardCapture = (): void => {
    recorder.discardStoppedRecording();
    setReviewInfo(null);
    setFlowStep("home");
  };

  const onSyncPending = async (): Promise<void> => {
    try {
      const sync = await recorder.syncPendingUploads();
      Alert.alert(
        "Pending Sync",
        `Uploaded: ${sync.uploaded}\nFailed: ${sync.failed}\nRemaining: ${sync.remaining}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Alert.alert("Sync Failed", message);
    }
  };

  const renderCameraContent = (): React.ReactElement => (
    <View
      style={styles.previewWrapper}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setPreviewSize({ width, height });
      }}
    >
      {device ? (
        <Camera
          ref={cameraRef}
          style={styles.camera}
          device={device}
          isActive={cameraIsActive}
          isMirrored={previewIsMirrored}
          format={format}
          fps={selectedFps}
          frameProcessor={recorder.frameProcessor}
          photo={false}
          video={false}
          audio={false}
          pixelFormat="yuv"
        />
      ) : null}
      <PoseOverlay
        width={previewSize.width}
        height={previewSize.height}
        keypoints={recorder.latestKeypoints}
        sourceWidth={sourceResolutionForOverlay[0]}
        sourceHeight={sourceResolutionForOverlay[1]}
        mirrorX={overlayMirrorX}
        resizeMode="cover"
      />
    </View>
  );

  const renderPermissionGate = (): React.ReactElement => (
    <View style={[styles.screen, styles.center]}>
      <Text style={styles.title}>Camera permission is required.</Text>
      <Text style={styles.subtleCentered}>Permission status: {permissionStatus}</Text>
      <Pressable style={styles.primaryButton} onPress={() => requestPermission()}>
        <Text style={styles.primaryButtonText}>Grant Camera Access</Text>
      </Pressable>
      <Pressable
        style={[styles.secondaryButton, styles.spaceTop]}
        onPress={() => setFlowStep("home")}
      >
        <Text style={styles.secondaryButtonText}>Back to Home</Text>
      </Pressable>
    </View>
  );

  const renderNoDeviceGate = (): React.ReactElement => (
    <View style={[styles.screen, styles.center]}>
      <Text style={styles.title}>No camera device found.</Text>
      <Text style={styles.subtleCentered}>
        Available devices: {devices.length} ({availableCameraPositions})
      </Text>
      <Text style={styles.subtleCentered}>
        Device probes: hook={hookDevices.length}, manual={manualDevices.length}
      </Text>
      <Text style={styles.subtleCentered}>Permission status: {permissionStatus}</Text>
      <Text style={styles.subtleCentered}>
        Runtime: {isLikelyExpoGo ? "Expo Go (unsupported)" : "Dev Client"}
      </Text>
      {isLikelyExpoGo ? (
        <Text style={styles.errorTextCentered}>
          This app needs a development build, not Expo Go.
        </Text>
      ) : null}
      {deviceScanError ? (
        <Text style={styles.errorTextCentered}>
          Native camera scan failed: {deviceScanError}
        </Text>
      ) : null}
      <Pressable
        style={[styles.secondaryButton, styles.spaceTop]}
        onPress={() => {
          requestPermission()
            .catch(() => {
              // surfaced in UI
            })
            .finally(refreshCameraState);
        }}
      >
        <Text style={styles.secondaryButtonText}>Retry Camera Check</Text>
      </Pressable>
      <Pressable
        style={[styles.secondaryButton, styles.spaceTop]}
        onPress={() => {
          Linking.openSettings().catch(() => {
            // ignore
          });
        }}
      >
        <Text style={styles.secondaryButtonText}>Open App Settings</Text>
      </Pressable>
      <Pressable
        style={[styles.secondaryButton, styles.spaceTop]}
        onPress={() => setFlowStep("home")}
      >
        <Text style={styles.secondaryButtonText}>Back to Home</Text>
      </Pressable>
    </View>
  );

  const renderHomeStep = (): React.ReactElement => (
    <ScrollView contentContainerStyle={styles.homeContainer}>
      <Text style={styles.homeTitle}>Pose Capture Workflow</Text>
      <Text style={styles.homeSubtitle}>
        This flow guides you through: rules, pre-check, recording, then confirmation.
      </Text>

      <View style={styles.rulesCard}>
        <Text style={styles.cardTitle}>Capture Rules</Text>
        <Text style={styles.ruleLine}>1. Keep full body visible in frame.</Text>
        <Text style={styles.ruleLine}>2. Stand in good lighting and face the camera.</Text>
        <Text style={styles.ruleLine}>3. Keep phone level and avoid rapid movement.</Text>
        <Text style={styles.ruleLine}>4. Start only when all pre-checks pass.</Text>
      </View>

      <View style={styles.configCard}>
        <Text style={styles.cardTitle}>Session Setup</Text>
        <TextInput
          value={backendUrl}
          onChangeText={setBackendUrl}
          placeholder="http://192.168.x.x:8000"
          placeholderTextColor="#6A7380"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <TextInput
          value={sessionId}
          onChangeText={setSessionId}
          placeholder="Optional session id"
          placeholderTextColor="#6A7380"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <TextInput
          value={participantAgeInput}
          onChangeText={setParticipantAgeInput}
          placeholder="Participant age (required)"
          placeholderTextColor="#6A7380"
          keyboardType="number-pad"
          maxLength={3}
          style={styles.input}
        />

        <Text style={[styles.subtle, styles.genderLabel]}>Gender</Text>
        <View style={styles.genderGrid}>
          {GENDER_OPTIONS.map((option) => {
            const isSelected = participantGender === option.value;
            return (
              <Pressable
                key={option.value}
                style={[styles.genderChip, isSelected && styles.genderChipSelected]}
                onPress={() => setParticipantGender(option.value)}
              >
                <Text
                  style={[
                    styles.genderChipText,
                    isSelected && styles.genderChipTextSelected
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {participantAge === undefined ? (
          <Text style={styles.errorText}>Age must be a number between 1 and 120.</Text>
        ) : null}

        <View style={styles.inlineRow}>
          <Text style={styles.subtle}>Camera: {cameraFacing}</Text>
          <Pressable
            style={[styles.secondaryButton, !devices.length && styles.disabledButton]}
            onPress={() =>
              setCameraFacing((prev) => (prev === "back" ? "front" : "back"))
            }
            disabled={devices.length === 0}
          >
            <Text style={styles.secondaryButtonText}>Flip Camera</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.statusCard}>
        <Text style={styles.cardTitle}>Status</Text>
        <Text style={styles.subtle}>
          Detector: {nativePoseDetectorReady ? nativePoseDetectorName : "not loaded"}
        </Text>
        <Text style={styles.subtle}>
          Camera stream:{" "}
          {selectedFormatResolution[0] > 0
            ? `${selectedFormatResolution[0]}x${selectedFormatResolution[1]}`
            : "detecting..."}
        </Text>
        <Text style={styles.subtle}>
          Live frame:{" "}
          {recorder.latestFrameResolution
            ? `${recorder.latestFrameResolution[0]}x${recorder.latestFrameResolution[1]}`
            : "waiting for camera preview"}
        </Text>
        <Text style={styles.subtle}>
          Frame mirrored: {recorder.latestFrameMirrored ? "yes" : "no"}
        </Text>
        <Text style={styles.subtle}>
          Overlay mirror correction: {overlayMirrorX ? "enabled" : "disabled"}
        </Text>
        <Text style={styles.subtle}>
          Pending local uploads: {recorder.pendingUploadsCount}
        </Text>
        {recorder.lastError ? <Text style={styles.errorText}>{recorder.lastError}</Text> : null}
      </View>

      <Pressable
        style={[styles.primaryButton, participantAge === undefined && styles.disabledButton]}
        onPress={onBeginCaptureFlow}
        disabled={participantAge === undefined}
      >
        <Text style={styles.primaryButtonText}>Start Capture</Text>
      </Pressable>

      <Pressable
        style={[
          styles.secondaryButton,
          (recorder.pendingUploadsCount < 1 || recorder.isUploading) && styles.disabledButton,
          styles.spaceTop
        ]}
        onPress={onSyncPending}
        disabled={recorder.pendingUploadsCount < 1 || recorder.isUploading}
      >
        <Text style={styles.secondaryButtonText}>
          Sync Pending ({recorder.pendingUploadsCount})
        </Text>
      </Pressable>
    </ScrollView>
  );

  const renderTestingStep = (): React.ReactElement => (
    <View style={styles.screen}>
      {renderCameraContent()}
      <View style={styles.testingPanel}>
        <Text style={styles.panelHeading}>Pre-Capture Check</Text>
        {readiness.checks.map((check) => (
          <Text
            key={check.id}
            style={[styles.checkItem, check.ok ? styles.checkOk : styles.checkFail]}
          >
            {check.ok ? "OK" : "Fix"} {check.label}: {check.detail}
          </Text>
        ))}
        <Text style={[styles.checkSummary, readiness.ready ? styles.checkOk : styles.checkFail]}>
          {readiness.summary}
        </Text>
        <View style={styles.inlineRow}>
          <Pressable style={styles.secondaryButton} onPress={() => setFlowStep("home")}>
            <Text style={styles.secondaryButtonText}>Back</Text>
          </Pressable>
          <Pressable
            style={[styles.primaryButton, !readiness.ready && styles.disabledButton]}
            onPress={onStartRecording}
            disabled={!readiness.ready}
          >
            <Text style={styles.primaryButtonText}>Start Recording</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );

  const renderRecordingStep = (): React.ReactElement => (
    <View style={styles.screen}>
      {renderCameraContent()}
      <View style={styles.recordingTopBar}>
        <Text style={styles.recordingTopText}>
          REC {formatDurationSeconds(recorder.stats.durationMs)}s | Frames {recorder.stats.framesCaptured}
        </Text>
      </View>
      <Animated.View style={[styles.stopButtonWrapper, stopButtonAnimatedStyle]}>
        <Pressable style={styles.stopButton} onPress={onStopRecording}>
          <Text style={styles.stopButtonText}>Stop Recording</Text>
        </Pressable>
      </Animated.View>
    </View>
  );

  const renderConfirmStep = (): React.ReactElement => (
    <View style={[styles.screen, styles.confirmContainer]}>
      <Text style={styles.homeTitle}>Confirm Capture</Text>
      <View style={styles.rulesCard}>
        <Text style={styles.cardTitle}>Recording Summary</Text>
        <Text style={styles.subtle}>
          Frames captured: {reviewInfo?.framesCaptured ?? recorder.stoppedRecordingFrames}
        </Text>
        <Text style={styles.subtle}>
          Duration: {formatDurationSeconds(reviewInfo?.durationMs ?? recorder.stats.durationMs)}s
        </Text>
        <Text style={styles.subtle}>
          Resolution: {captureResolutionForSummary[0]}x{captureResolutionForSummary[1]} | Nominal FPS {selectedFps}
        </Text>
      </View>

      {!recorder.hasStoppedRecording ? (
        <Text style={styles.errorText}>No stopped recording is available. Please capture again.</Text>
      ) : null}

      <Pressable
        style={[styles.primaryButton, (!recorder.hasStoppedRecording || isFinalizing) && styles.disabledButton]}
        onPress={() => finalizeStoppedRecording(true)}
        disabled={!recorder.hasStoppedRecording || isFinalizing}
      >
        <Text style={styles.primaryButtonText}>Save and Send to Backend</Text>
      </Pressable>

      <Pressable
        style={[styles.secondaryButton, (!recorder.hasStoppedRecording || isFinalizing) && styles.disabledButton, styles.spaceTop]}
        onPress={() => finalizeStoppedRecording(false)}
        disabled={!recorder.hasStoppedRecording || isFinalizing}
      >
        <Text style={styles.secondaryButtonText}>Save Locally Only</Text>
      </Pressable>

      <Pressable
        style={[styles.secondaryButton, styles.spaceTop]}
        onPress={onDiscardCapture}
        disabled={isFinalizing}
      >
        <Text style={styles.secondaryButtonText}>Discard Capture</Text>
      </Pressable>
    </View>
  );

  if (flowStep === "home") {
    return renderHomeStep();
  }

  if (flowStep === "confirm") {
    return renderConfirmStep();
  }

  if (!hasPermission) {
    return renderPermissionGate();
  }

  if (!device) {
    return renderNoDeviceGate();
  }

  if (flowStep === "testing") {
    return renderTestingStep();
  }

  return renderRecordingStep();
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#EEF3F7"
  },
  center: {
    justifyContent: "center",
    alignItems: "center",
    padding: 24
  },
  homeContainer: {
    paddingHorizontal: 16,
    paddingVertical: 20
  },
  confirmContainer: {
    paddingHorizontal: 16,
    paddingVertical: 20
  },
  homeTitle: {
    color: "#123149",
    fontSize: 24,
    fontWeight: "700"
  },
  homeSubtitle: {
    color: "#4E6478",
    fontSize: 13,
    marginTop: 6
  },
  title: {
    color: "#123149",
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 10,
    textAlign: "center"
  },
  rulesCard: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#C9D6E2",
    borderRadius: 14,
    padding: 12,
    marginTop: 14
  },
  configCard: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#C9D6E2",
    borderRadius: 14,
    padding: 12,
    marginTop: 12
  },
  statusCard: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#C9D6E2",
    borderRadius: 14,
    padding: 12,
    marginTop: 12,
    marginBottom: 14
  },
  cardTitle: {
    color: "#1D3F5A",
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 6
  },
  ruleLine: {
    color: "#2F4E63",
    fontSize: 13,
    marginBottom: 4
  },
  subtle: {
    color: "#4E6478",
    fontSize: 13,
    marginBottom: 4
  },
  genderLabel: {
    marginTop: 10,
    marginBottom: 6
  },
  genderGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  genderChip: {
    borderWidth: 1,
    borderColor: "#AFC1CF",
    backgroundColor: "#FFFFFF",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  genderChipSelected: {
    backgroundColor: "#DDEEFF",
    borderColor: "#0E6AA8"
  },
  genderChipText: {
    color: "#35536A",
    fontSize: 12,
    fontWeight: "600"
  },
  genderChipTextSelected: {
    color: "#0E4D79"
  },
  subtleCentered: {
    color: "#4E6478",
    fontSize: 13,
    textAlign: "center",
    marginBottom: 4
  },
  errorText: {
    color: "#B74961",
    fontSize: 13,
    marginTop: 8
  },
  errorTextCentered: {
    color: "#B74961",
    fontSize: 13,
    textAlign: "center",
    marginTop: 6
  },
  input: {
    borderWidth: 1,
    borderColor: "#BFD0DE",
    borderRadius: 10,
    color: "#173349",
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 8,
    backgroundColor: "#FFFFFF"
  },
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 10
  },
  primaryButton: {
    backgroundColor: "#0E6AA8",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center"
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontWeight: "700"
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: "#8DA8BF",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF"
  },
  secondaryButtonText: {
    color: "#24516F",
    fontWeight: "600"
  },
  disabledButton: {
    opacity: 0.5
  },
  spaceTop: {
    marginTop: 10
  },
  previewWrapper: {
    flex: 1
  },
  camera: {
    ...StyleSheet.absoluteFillObject
  },
  testingPanel: {
    backgroundColor: "rgba(248,251,253,0.94)",
    borderTopWidth: 1,
    borderTopColor: "#C9D6E2",
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  panelHeading: {
    color: "#123149",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 6
  },
  checkItem: {
    fontSize: 12,
    marginBottom: 2
  },
  checkSummary: {
    fontSize: 12,
    marginTop: 4,
    fontWeight: "600"
  },
  checkOk: {
    color: "#1F8A6D"
  },
  checkFail: {
    color: "#B74E63"
  },
  recordingTopBar: {
    position: "absolute",
    top: 22,
    left: 16,
    right: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "rgba(5, 27, 44, 0.55)"
  },
  recordingTopText: {
    color: "#F5FBFF",
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center"
  },
  stopButtonWrapper: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 26
  },
  stopButton: {
    backgroundColor: "#B24255",
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16
  },
  stopButtonText: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "700"
  }
});

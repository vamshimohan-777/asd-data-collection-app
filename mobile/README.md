# Mobile App (React Native + Expo Dev Client)

This app captures camera frames with `react-native-vision-camera`, runs a frame processor for pose extraction, buffers pose tensors in memory, writes JSON locally, and uploads to the backend.

## Run

```bash
npm install
npx expo prebuild
npx expo run:android --all-arch   # or npx expo run:ios
npm run start
```

## Key Files

- `src/screens/CameraScreen.tsx`: camera UI, controls, metrics
- `src/hooks/usePoseRecorder.ts`: frame buffer, start/stop capture, local queue + upload/sync
- `src/pose/blazePoseWorklet.ts`: MediaPipe frame-processor bridge + mock fallback
- `src/components/PoseOverlay.tsx`: live skeleton/depth overlay
- `src/utils/storage.ts`: local `payload.json` + `keypoints.npy` + `timestamps.npy` persistence
- `src/utils/quality.ts`: pre-capture readiness check-in (lighting/framing/angle)

## Native Pose Detector

The app now attempts native pose detection from:

1. `global.__blazePoseGhum3DDetect(frame)` (custom BlazePose plugin)
2. VisionCamera frame-processor plugin candidates (`poseDetection`, `poseDetector`, `detectPose`, `mlkitPoseDetection`)

Dependency included:

- `react-native-vision-camera-mlkit`

After dependency changes, rebuild the development app (`npx expo run:android --all-arch` / `npx expo run:ios`).

## MediaPipe Native TODO

`src/pose/blazePoseWorklet.ts` expects a global JSI function:

```ts
global.__blazePoseGhum3DDetect(frame)
```

If present, native BlazePose GHUM 3D output is used automatically.  
If absent, the app uses a deterministic mock pose stream for pipeline testing.

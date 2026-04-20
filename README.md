# Mobile Pose Data Collection Prototype

This repository contains a working prototype for collecting human pose tensors on mobile and exporting them to a Python backend that stores `.pth` files and renders skeleton videos.

## Structure

- `mobile/`: React Native (Expo Dev Client + Vision Camera) app for real-time keypoint capture.
- `backend/`: FastAPI service for upload, `.pth` conversion, preprocessing, and skeleton rendering.

## Quick Start

### One-Command (Windows)

```powershell
.\run_app.ps1
```

Or from Command Prompt:

```bat
run_app.bat
```

Useful options:

```powershell
.\run_app.ps1 -Platform android
.\run_app.ps1 -Platform none     # only backend + Metro
.\run_app.ps1 -SkipInstall       # skip npm/pip install on repeated runs
.\run_app.ps1 -CleanInstall      # wipe venv/node_modules/native build + reinstall
```

Full reinstall from Command Prompt:

```bat
reinstall_and_run.bat
```

### 1) Backend

```bash
cd backend
python -m venv .venv
. .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 2) Mobile

```bash
cd mobile
npm install
npx expo prebuild
npx expo run:android --all-arch   # or: npx expo run:ios
npm run start
```

Set the backend URL inside the app (defaults to `http://10.0.2.2:8000` for Android emulator).

## Notes

- Raw video is not stored.
- Each frame contributes only pose keypoints + timestamp.
- Captures are always serialized locally first (`payload.json`, `keypoints.npy`, `timestamps.npy`), then uploaded.
- If backend upload fails or is skipped, files stay queued locally until manual sync from the app.
- Pre-capture check-in panel validates native detector status, lighting proxy (visibility), framing, angle, centering, and distance.
- Launcher auto-checks and installs missing backend packages and required mobile plugin packages.
- MediaPipe native worklet integration has a clear TODO path in:
  - `mobile/src/pose/blazePoseWorklet.ts`

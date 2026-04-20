# Backend Service

FastAPI service for:

1. Accepting mobile pose payloads (`POST /upload`)
2. Saving raw tensors as `.pth`
3. Running preprocessing pipeline
4. Saving processed `.pth`
5. Rendering skeleton video (`.mp4`) with OpenCV

## Run

```bash
python -m venv .venv
. .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Health check:

```bash
curl http://localhost:8000/health
```

## Upload Payload Schema

```json
{
  "keypoints": [[[0.1, 0.2, -0.03, 0.99], "... 33 joints ..."], "... T frames ..."],
  "timestamps": [1712000000000.0, 1712000000016.0],
  "meta": {
    "fps_nominal": 60,
    "resolution": [1280, 720],
    "device": "Pixel 7",
    "camera_facing": "front",
    "session_id": "optional-run-id"
  }
}
```

## Outputs

Saved under `backend/data/`:

- `raw_json/*.json`
- `raw_pth/*.pth`
- `processed_pth/*.pth`
- `renders/*.mp4`
- `processed_25_csv/*.csv` (custom 25-landmark flattened XYZ columns from raw mobile upload)
- `processed_25_npy/*.npy` (shape `[T, 25, 3]` from raw mobile upload)
- `processed_25_meta/*.json` (raw-source conversion + capture metadata)

## Render Existing `.pth`

```bash
python -m app.render --pth data/processed_pth/<capture-id>.pth --output data/renders/manual.mp4 --fps 60
```

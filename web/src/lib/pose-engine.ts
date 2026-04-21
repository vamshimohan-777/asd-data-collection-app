import { PoseLandmarker, FilesetResolver, PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import { drawConnectors, drawLandmarks } from '@mediapipe/drawing_utils';

export type PoseCallback = (results: PoseLandmarkerResult) => void;

export class PoseEngine {
  private landmarker: PoseLandmarker | null = null;
  private videoElement: HTMLVideoElement;
  private canvasElement: HTMLCanvasElement;
  private canvasCtx: CanvasRenderingContext2D;
  private onResultsCallbacks: PoseCallback[] = [];
  private isLoaded = false;

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
    this.videoElement = video;
    this.canvasElement = canvas;
    this.canvasCtx = canvas.getContext('2d')!;
    this.init();
  }

  private async init() {
    try {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );
      
      this.landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
          delegate: "CPU"
        },
        runningMode: "VIDEO",
        numPoses: 1
      });

      this.isLoaded = true;
      console.log("Pose Landmarker initialized");
    } catch (err) {
      console.error("Failed to initialize Pose Landmarker:", err);
    }
  }

  public onResults(cb: PoseCallback) {
    this.onResultsCallbacks.push(cb);
  }

  public async send(video: HTMLVideoElement) {
    if (!this.landmarker || !this.isLoaded) return;

    const startTimeMs = performance.now();
    const result = this.landmarker.detectForVideo(video, startTimeMs);
    
    this.handleResults(result);
  }

  private handleResults(results: PoseLandmarkerResult) {
    // Clear canvas
    this.canvasCtx.save();
    this.canvasCtx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);

    // Draw landmarks if they exist (Results format: landmarks[pose_idx][landmark_idx])
    if (results.landmarks && results.landmarks.length > 0) {
      const poseLandmarks = results.landmarks[0];
      
      // DrawingUtils often expects the older format, but we can draw manually or try to adapt
      // The PoseLandmarker constants are different. We will use standard connections.
      
      // Note: PoseLandmarker connection constants are slightly different, 
      // but drawing_utils might still work with the array.
      if (typeof drawConnectors === 'function') {
          // PoseLandmarker.POSE_CONNECTIONS is what we want
          drawConnectors(this.canvasCtx, poseLandmarks, PoseLandmarker.POSE_CONNECTIONS, {
            color: '#00A3FF',
            lineWidth: 4
          });
          drawLandmarks(this.canvasCtx, poseLandmarks, {
            color: '#FFFFFF',
            lineWidth: 2,
            radius: 4
          });
      }
    }
    this.canvasCtx.restore();

    // Notify listeners
    this.onResultsCallbacks.forEach(cb => cb(results));
  }

  public close() {
    this.landmarker?.close();
  }
}

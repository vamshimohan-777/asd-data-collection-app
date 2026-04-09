export type PoseKeypoint = [number, number, number, number];
export type ParticipantGender =
  | "male"
  | "female"
  | "other"
  | "prefer_not_to_say";

export interface PoseFrameSample {
  keypoints: PoseKeypoint[];
  timestamp: number;
}

export interface PoseCaptureMeta {
  fps_nominal: number;
  resolution: [number, number];
  device: string;
  camera_facing: "front" | "back";
  session_id?: string;
  age?: number;
  gender?: ParticipantGender;
}

export interface PoseUploadPayload {
  keypoints: PoseKeypoint[][];
  timestamps: number[];
  meta: PoseCaptureMeta;
}

export interface PoseUploadResponse {
  status: "ok";
  capture_id: string;
  raw_json_path: string;
  raw_pth_path: string;
  processed_pth_path: string;
  render_path: string;
  frames_in: number;
  frames_out: number;
}

export interface LocalCapturePaths {
  capture_id: string;
  created_at: string;
  directory_path: string;
  json_path: string;
  keypoints_npy_path: string;
  timestamps_npy_path: string;
  meta_json_path: string;
}

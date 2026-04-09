import * as FileSystem from "expo-file-system";

import type { LocalCapturePaths, PoseUploadPayload } from "../types/pose";

const CAPTURE_SUBDIR = "pose-captures";
const PENDING_SUBDIR = "pending";
const SAVED_SUBDIR = "saved";
const PAYLOAD_FILENAME = "payload.json";
const META_FILENAME = "meta.json";
const MANIFEST_FILENAME = "manifest.json";
const KEYPOINTS_NPY_FILENAME = "keypoints.npy";
const TIMESTAMPS_NPY_FILENAME = "timestamps.npy";

interface CaptureManifest {
  capture_id: string;
  created_at: string;
  frames: number;
  resolution: [number, number];
  session_id?: string;
  age?: number;
  gender?: PoseUploadPayload["meta"]["gender"];
}

function getWritableBaseDir(): string {
  const baseDir = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
  if (!baseDir) {
    throw new Error("No writable local directory is available on this device.");
  }
  return baseDir;
}

function joinPath(base: string, child: string): string {
  const baseClean = base.replace(/\/+$/, "");
  const childClean = child.replace(/^\/+/, "");
  return `${baseClean}/${childClean}`;
}

function sanitizeIdPart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-");
  return sanitized.replace(/^-+|-+$/g, "");
}

function createCaptureId(sessionId?: string): string {
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const random = Math.random().toString(36).slice(2, 10);
  const prefix = sanitizeIdPart(sessionId ?? "") || "capture";
  return `${prefix}-${now}-${random}`;
}

function toAsciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0x7f;
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    const value = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += chars[(value >> 18) & 63];
    out += chars[(value >> 12) & 63];
    out += chars[(value >> 6) & 63];
    out += chars[value & 63];
  }

  if (i < bytes.length) {
    const hasSecond = i + 1 < bytes.length;
    const value = (bytes[i] << 16) | (hasSecond ? bytes[i + 1] << 8 : 0);
    out += chars[(value >> 18) & 63];
    out += chars[(value >> 12) & 63];
    out += hasSecond ? chars[(value >> 6) & 63] : "=";
    out += "=";
  }

  return out;
}

function createNpyHeader(descr: "<f4" | "<f8", shape: number[]): Uint8Array {
  const shapeText =
    shape.length === 1 ? `(${shape[0]},)` : `(${shape.map((v) => String(v)).join(", ")})`;
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${shapeText}, }`;

  const preambleLength = 10;
  const headerPlusNewlineLength = header.length + 1;
  const padding =
    (16 - ((preambleLength + headerPlusNewlineLength) % 16)) % 16;
  header += `${" ".repeat(padding)}\n`;

  const headerBytes = toAsciiBytes(header);
  if (headerBytes.length > 65535) {
    throw new Error("NPY header is too large for v1 format.");
  }

  const out = new Uint8Array(10 + headerBytes.length);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0x01, 0x00], 0);
  out[8] = headerBytes.length & 0xff;
  out[9] = (headerBytes.length >> 8) & 0xff;
  out.set(headerBytes, 10);
  return out;
}

function composeNpy(
  descr: "<f4" | "<f8",
  shape: number[],
  data: Float32Array | Float64Array
): Uint8Array {
  const header = createNpyHeader(descr, shape);
  const rawData = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint8Array(header.length + rawData.length);
  out.set(header, 0);
  out.set(rawData, header.length);
  return out;
}

function flattenKeypoints(payload: PoseUploadPayload): Float32Array {
  const frameCount = payload.keypoints.length;
  const flat = new Float32Array(frameCount * 33 * 4);
  let index = 0;

  for (let t = 0; t < frameCount; t += 1) {
    const frame = payload.keypoints[t];
    if (!Array.isArray(frame) || frame.length !== 33) {
      throw new Error(`Invalid keypoint frame at index ${t}. Expected 33 landmarks.`);
    }

    for (let k = 0; k < 33; k += 1) {
      const kp = frame[k];
      if (!Array.isArray(kp) || kp.length < 4) {
        throw new Error(`Invalid keypoint tuple at frame ${t}, landmark ${k}.`);
      }
      flat[index] = Number(kp[0]) || 0;
      flat[index + 1] = Number(kp[1]) || 0;
      flat[index + 2] = Number(kp[2]) || 0;
      flat[index + 3] = Number(kp[3]) || 0;
      index += 4;
    }
  }

  return flat;
}

function flattenTimestamps(payload: PoseUploadPayload): Float64Array {
  const frameCount = payload.keypoints.length;
  if (payload.timestamps.length !== frameCount) {
    throw new Error(
      `Timestamp count mismatch. Expected ${frameCount}, got ${payload.timestamps.length}.`
    );
  }

  const out = new Float64Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    const value = Number(payload.timestamps[i]);
    out[i] = Number.isFinite(value) ? value : 0;
  }
  return out;
}

function getCaptureRootDir(): string {
  return joinPath(getWritableBaseDir(), CAPTURE_SUBDIR);
}

function getPendingRootDir(): string {
  return joinPath(getCaptureRootDir(), PENDING_SUBDIR);
}

function getSavedRootDir(): string {
  return joinPath(getCaptureRootDir(), SAVED_SUBDIR);
}

function getCaptureDir(rootDir: string, captureId: string): string {
  return joinPath(rootDir, captureId);
}

async function ensureCaptureDir(rootDir: string): Promise<void> {
  await FileSystem.makeDirectoryAsync(rootDir, { intermediates: true });
}

function getCapturePaths(
  captureId: string,
  createdAt: string,
  directoryPath: string
): LocalCapturePaths {
  return {
    capture_id: captureId,
    created_at: createdAt,
    directory_path: directoryPath,
    json_path: joinPath(directoryPath, PAYLOAD_FILENAME),
    keypoints_npy_path: joinPath(directoryPath, KEYPOINTS_NPY_FILENAME),
    timestamps_npy_path: joinPath(directoryPath, TIMESTAMPS_NPY_FILENAME),
    meta_json_path: joinPath(directoryPath, META_FILENAME)
  };
}

async function writeNpyFile(
  path: string,
  descr: "<f4" | "<f8",
  shape: number[],
  data: Float32Array | Float64Array
): Promise<void> {
  const npyBytes = composeNpy(descr, shape, data);
  const base64 = bytesToBase64(npyBytes);
  await FileSystem.writeAsStringAsync(path, base64, {
    encoding: FileSystem.EncodingType.Base64
  });
}

async function writeCapturePayload(
  payload: PoseUploadPayload,
  paths: LocalCapturePaths
): Promise<void> {
  const keypointTensor = flattenKeypoints(payload);
  const timestampTensor = flattenTimestamps(payload);
  const frameCount = payload.keypoints.length;

  await FileSystem.writeAsStringAsync(paths.json_path, JSON.stringify(payload), {
    encoding: FileSystem.EncodingType.UTF8
  });
  await FileSystem.writeAsStringAsync(paths.meta_json_path, JSON.stringify(payload.meta), {
    encoding: FileSystem.EncodingType.UTF8
  });

  const manifest: CaptureManifest = {
    capture_id: paths.capture_id,
    created_at: paths.created_at,
    frames: frameCount,
    resolution: payload.meta.resolution,
    session_id: payload.meta.session_id,
    age: payload.meta.age,
    gender: payload.meta.gender
  };
  await FileSystem.writeAsStringAsync(
    joinPath(paths.directory_path, MANIFEST_FILENAME),
    JSON.stringify(manifest),
    {
      encoding: FileSystem.EncodingType.UTF8
    }
  );

  await writeNpyFile(paths.keypoints_npy_path, "<f4", [frameCount, 33, 4], keypointTensor);
  await writeNpyFile(paths.timestamps_npy_path, "<f8", [frameCount], timestampTensor);
}

async function saveCaptureToSubdir(
  payload: PoseUploadPayload,
  rootDir: string
): Promise<LocalCapturePaths> {
  await ensureCaptureDir(rootDir);

  const createdAt = new Date().toISOString();
  const captureId = createCaptureId(payload.meta.session_id);
  const directoryPath = getCaptureDir(rootDir, captureId);
  const paths = getCapturePaths(captureId, createdAt, directoryPath);

  await FileSystem.makeDirectoryAsync(paths.directory_path, { intermediates: true });
  await writeCapturePayload(payload, paths);

  return paths;
}

export async function saveCaptureForPendingUpload(
  payload: PoseUploadPayload
): Promise<LocalCapturePaths> {
  return saveCaptureToSubdir(payload, getPendingRootDir());
}

export async function saveCaptureToLocalArchive(
  payload: PoseUploadPayload
): Promise<LocalCapturePaths> {
  return saveCaptureToSubdir(payload, getSavedRootDir());
}

export async function saveCaptureToJson(
  payload: PoseUploadPayload
): Promise<string> {
  const paths = await saveCaptureToLocalArchive(payload);
  return paths.json_path;
}

export async function listPendingCaptureIds(): Promise<string[]> {
  const pendingRoot = getPendingRootDir();
  const exists = await FileSystem.getInfoAsync(pendingRoot);
  if (!exists.exists || !exists.isDirectory) {
    return [];
  }

  const entries = await FileSystem.readDirectoryAsync(pendingRoot);
  const ids: string[] = [];
  for (const entry of entries) {
    const info = await FileSystem.getInfoAsync(joinPath(pendingRoot, entry));
    if (info.exists && info.isDirectory) {
      ids.push(entry);
    }
  }

  ids.sort();
  return ids;
}

export async function countPendingCaptures(): Promise<number> {
  const ids = await listPendingCaptureIds();
  return ids.length;
}

export async function loadPendingCapturePayload(
  captureId: string
): Promise<PoseUploadPayload> {
  const directoryPath = getCaptureDir(getPendingRootDir(), captureId);
  const payloadPath = joinPath(directoryPath, PAYLOAD_FILENAME);
  const payloadText = await FileSystem.readAsStringAsync(payloadPath, {
    encoding: FileSystem.EncodingType.UTF8
  });

  return JSON.parse(payloadText) as PoseUploadPayload;
}

export async function removePendingCapture(captureId: string): Promise<void> {
  const directoryPath = getCaptureDir(getPendingRootDir(), captureId);
  await FileSystem.deleteAsync(directoryPath, { idempotent: true });
}

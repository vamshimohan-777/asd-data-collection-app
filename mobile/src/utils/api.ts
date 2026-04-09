import type { PoseUploadPayload, PoseUploadResponse } from "../types/pose";

export async function uploadCapture(
  payload: PoseUploadPayload,
  backendBaseUrl: string
): Promise<PoseUploadResponse> {
  const base = backendBaseUrl.trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error("Backend URL is empty. Set a valid URL before upload.");
  }

  const response = await fetch(`${base}/upload`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const reason = await response.text();
    throw new Error(`Upload failed (${response.status}): ${reason}`);
  }

  return (await response.json()) as PoseUploadResponse;
}

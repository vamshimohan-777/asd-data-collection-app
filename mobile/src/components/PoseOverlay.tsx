import React, { memo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Line } from "react-native-svg";

import { SKELETON_EDGES } from "../constants/skeleton";
import type { PoseKeypoint } from "../types/pose";

interface PoseOverlayProps {
  width: number;
  height: number;
  keypoints: PoseKeypoint[] | null;
  sourceWidth?: number;
  sourceHeight?: number;
  mirrorX?: boolean;
  resizeMode?: "cover" | "contain";
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function zToColor(z: number): string {
  const t = clamp((z + 0.45) / 0.9, 0, 1);
  const red = Math.round(255 * (1 - t));
  const blue = Math.round(255 * t);
  return `rgb(${red},180,${blue})`;
}

function resolveSourceSize(
  sourceWidth: number | undefined,
  sourceHeight: number | undefined,
  width: number,
  height: number
): { sourceW: number; sourceH: number } {
  const sw = Number(sourceWidth ?? 0);
  const sh = Number(sourceHeight ?? 0);
  if (!(sw > 0) || !(sh > 0)) {
    return { sourceW: width, sourceH: height };
  }

  const previewAspect = width / height;
  const aspectDirect = sw / sh;
  const aspectRotated = sh / sw;

  const directDelta = Math.abs(Math.log(aspectDirect / previewAspect));
  const rotatedDelta = Math.abs(Math.log(aspectRotated / previewAspect));

  if (rotatedDelta < directDelta) {
    return { sourceW: sh, sourceH: sw };
  }

  return { sourceW: sw, sourceH: sh };
}

function toPoint(
  keypoint: PoseKeypoint,
  width: number,
  height: number,
  sourceWidth: number | undefined,
  sourceHeight: number | undefined,
  mirrorX: boolean,
  resizeMode: "cover" | "contain"
): { x: number; y: number; vis: number; z: number } {
  const { sourceW, sourceH } = resolveSourceSize(sourceWidth, sourceHeight, width, height);
  const scale =
    resizeMode === "cover"
      ? Math.max(width / sourceW, height / sourceH)
      : Math.min(width / sourceW, height / sourceH);

  const renderedW = sourceW * scale;
  const renderedH = sourceH * scale;
  const offsetX = (width - renderedW) * 0.5;
  const offsetY = (height - renderedH) * 0.5;

  const normalizedX = mirrorX ? 1 - clamp(keypoint[0], 0, 1) : clamp(keypoint[0], 0, 1);
  const normalizedY = clamp(keypoint[1], 0, 1);

  const x = normalizedX * renderedW + offsetX;
  const y = normalizedY * renderedH + offsetY;
  return { x, y, vis: keypoint[3], z: keypoint[2] };
}

function PoseOverlayComponent({
  width,
  height,
  keypoints,
  sourceWidth,
  sourceHeight,
  mirrorX = false,
  resizeMode = "cover"
}: PoseOverlayProps): React.ReactElement | null {
  if (!keypoints || keypoints.length !== 33 || width < 1 || height < 1) {
    return null;
  }

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width={width} height={height}>
        {SKELETON_EDGES.map(([from, to], edgeIndex) => {
          const p1 = toPoint(
            keypoints[from],
            width,
            height,
            sourceWidth,
            sourceHeight,
            mirrorX,
            resizeMode
          );
          const p2 = toPoint(
            keypoints[to],
            width,
            height,
            sourceWidth,
            sourceHeight,
            mirrorX,
            resizeMode
          );
          const alpha = clamp((p1.vis + p2.vis) * 0.5, 0.15, 1);

          return (
            <Line
              key={`edge-${edgeIndex}`}
              x1={p1.x}
              y1={p1.y}
              x2={p2.x}
              y2={p2.y}
              stroke={`rgba(120,220,255,${alpha})`}
              strokeWidth={2}
            />
          );
        })}

        {keypoints.map((keypoint, idx) => {
          const point = toPoint(
            keypoint,
            width,
            height,
            sourceWidth,
            sourceHeight,
            mirrorX,
            resizeMode
          );
          const radius = 1.8 + clamp(point.vis, 0, 1) * 2;
          return (
            <Circle
              key={`joint-${idx}`}
              cx={point.x}
              cy={point.y}
              r={radius}
              fill={zToColor(point.z)}
            />
          );
        })}
      </Svg>
    </View>
  );
}

export const PoseOverlay = memo(PoseOverlayComponent);

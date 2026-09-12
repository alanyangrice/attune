import type { FaceSample } from "../vitals/provider.js";

export type AttentionDirection = "left" | "center" | "right" | "unknown";
export type HeadState = "center" | "away" | "down" | "unknown";

export interface AttentionSample {
  ts: number;
  present: boolean;
  stable: boolean;
  gaze: AttentionDirection;
  head: HeadState;
  blinking: boolean;
  talking: boolean;
}

function point(
  landmarks: FaceSample["landmarks"],
  index: number,
): { x: number; y: number } | undefined {
  return landmarks?.[index];
}

function midpoint(
  first: { x: number; y: number },
  second: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function direction(value: number | undefined): AttentionDirection {
  if (value === undefined) {
    return "unknown";
  }
  if (value < 0.35) {
    return "left";
  }
  if (value > 0.65) {
    return "right";
  }
  return "center";
}

export function attentionFromFace(sample: FaceSample): AttentionSample {
  const landmarks = sample.landmarks;
  const present = Boolean(landmarks && landmarks.length > 0);
  if (!present || !landmarks) {
    return {
      ts: sample.ts,
      present: false,
      stable: false,
      gaze: "unknown",
      head: "unknown",
      blinking: sample.blinking,
      talking: sample.talking,
    };
  }

  const nose = point(landmarks, 1);
  const leftCheek = point(landmarks, 234);
  const rightCheek = point(landmarks, 454);
  const chin = point(landmarks, 152);
  const leftEyeOuter = point(landmarks, 33);
  const rightEyeOuter = point(landmarks, 263);
  const leftIris = landmarks.slice(468, 473);
  const rightIris = landmarks.slice(473, 478);

  let yaw: number | undefined;
  if (nose && leftCheek && rightCheek && rightCheek.x !== leftCheek.x) {
    yaw =
      (nose.x - leftCheek.x) / (rightCheek.x - leftCheek.x) - 0.5;
  }

  let pitch: number | undefined;
  if (nose && chin && leftEyeOuter && rightEyeOuter) {
    const eyeLine = midpoint(leftEyeOuter, rightEyeOuter);
    const denominator = chin.y - eyeLine.y;
    if (denominator !== 0) {
      pitch = (nose.y - eyeLine.y) / denominator;
    }
  }

  const irisCenter = (iris: Array<{ x: number; y: number }>) =>
    iris.length === 0
      ? undefined
      : iris.reduce(
          (sum, current) => ({ x: sum.x + current.x, y: sum.y + current.y }),
          { x: 0, y: 0 },
        );

  const leftIrisCenter = irisCenter(leftIris);
  const rightIrisCenter = irisCenter(rightIris);
  const leftEye = point(landmarks, 133);
  const rightEye = point(landmarks, 362);
  const leftGaze =
    leftIrisCenter && leftEyeOuter && leftEye
      ? (leftIrisCenter.x / 5 - leftEye.x) /
        (leftEyeOuter.x - leftEye.x)
      : undefined;
  const rightGaze =
    rightIrisCenter && rightEyeOuter && rightEye
      ? (rightIrisCenter.x / 5 - rightEye.x) /
        (rightEyeOuter.x - rightEye.x)
      : undefined;
  const gaze =
    leftGaze !== undefined && rightGaze !== undefined
      ? direction((leftGaze + rightGaze) / 2)
      : "unknown";

  return {
    ts: sample.ts,
    present: true,
    stable: sample.stable,
    gaze,
    head:
      pitch !== undefined && pitch > 0.65
        ? "down"
        : yaw !== undefined && Math.abs(yaw) > 0.2
          ? "away"
          : yaw !== undefined && pitch !== undefined
            ? "center"
            : "unknown",
    blinking: sample.blinking,
    talking: sample.talking,
  };
}

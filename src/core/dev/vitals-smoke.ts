// Camera smoke test: run the real SmartSpectra provider for a while and print
// what it emits, through the same VitalsProvider port the loop uses.
//
//   npm run vitals:smoke                       # 60 s, breathing + cardio + face
//   npm run vitals:smoke -- --seconds=20 --metrics=cardio --camera=1

import { breathingMetrics, cardioMetrics, faceMetrics } from "@smartspectra/node-sdk";
import { CONFIG } from "../config.js";
import { createVitals } from "../sensors/index.js";
import { classify, faceFeatures } from "../sensors/attention/face.js";
import { errMsg } from "../util.js";
import { argOf } from "./args.js";

const seconds = Number(argOf("seconds") ?? 60);
const metricsArg = argOf("metrics") ?? "all";
const METRICS: Record<string, readonly number[]> = {
  cardio: cardioMetrics,
  face: [...cardioMetrics, ...faceMetrics],
  all: [...breathingMetrics, ...cardioMetrics, ...faceMetrics],
};
const requestedMetrics = METRICS[metricsArg] ?? METRICS.all;
const camera = argOf("camera");

const t0 = Date.now();
const log = (line: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${line}`);

let samples = 0;
let faces = 0;
const vitals = createVitals("real", { requestedMetrics, deviceIndex: camera ? Number(camera) : undefined });
vitals.on("status", (s) => log(`status: ${s}`));
vitals.on("warning", (msg) => log(`hint: ${msg}`));
vitals.on("error", (err) => log(`error: ${err.message}`));
vitals.on("sample", (s) => {
  samples += 1;
  log(`vitals #${samples}: HR ${s.hr.toFixed(0)} · BR ${s.br.toFixed(1)} · HRV ${s.hrv?.toFixed(0) ?? "n/a"} · conf ${s.confidence.toFixed(2)}`);
});
vitals.on("face", (f) => {
  faces += 1;
  if (faces % CONFIG.attention.faceHz !== 0) return; // print once a second
  const feat = faceFeatures(f);
  const c = classify(feat);
  log(
    `face #${faces}: present=${feat.present} stable=${feat.stable} gaze=${c.gaze} head=${c.head}` +
      (feat.yaw !== undefined ? ` yaw=${feat.yaw.toFixed(2)} pitch=${feat.pitch?.toFixed(2)} gazeX=${feat.gazeX?.toFixed(2)}` : "") +
      ` blink=${feat.blinking} talk=${feat.talking}`,
  );
});

let stopping = false;
async function finish(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await vitals.stop();
  log(`done: ${samples} vitals samples, ${faces} face samples`);
  if (faces && !samples) log("face tracking worked but no HR/BR arrived — check lighting/stillness or whether the key's plan includes cardio");
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void finish());
setTimeout(() => void finish(), seconds * 1000);
setTimeout(() => process.exit(0), seconds * 1000 + 8000).unref(); // never hang on a stuck native drain

try {
  log(`starting SmartSpectra for ${seconds}s · metrics=${metricsArg} · camera=${camera ?? "default"}`);
  await vitals.start();
} catch (err) {
  log(`startup failed: ${errMsg(err)}`);
  process.exit(1);
}

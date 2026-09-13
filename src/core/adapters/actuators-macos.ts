// macOS actuators (design.md §5 mechanics, WORKPLAN lane 6). Same port as
// the console stub, real effects on the laptop:
//   duckVolume   osascript `set volume output volume N`, restored after N s
//   setDnd       `shortcuts run "Attune DND On|Off"` (two user-made Shortcuts
//                that toggle the Do Not Disturb Focus; no private APIs)
//   say          ElevenLabs TTS when ELEVENLABS_API_KEY is set, else macOS `say`; never overlapping
//   suggestBreak native notification — the break card itself is the renderer's
//   startPacer   notification + music ducked to 40 % for the duration — the
//                visual pacer window is Electron's
// Every process is spawned with execFile/spawn and an argv array; nothing is
// ever interpolated into a shell string.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { CONFIG } from "../config.js";
import type { ActuatorPort } from "../ports.js";
import { ElevenLabsSpeaker, speakOrFallback } from "./tts-elevenlabs.js";
import { errMsg } from "../util.js";
import type { ActuatorHooks } from "./actuators-console.js";

export interface MacActuatorOptions extends ActuatorHooks {
  /** something the user must fix (missing Shortcut, osascript failure) — one line */
  warn?: (msg: string) => void;
  /** what the actuator did, for the feed */
  log?: (msg: string) => void;
  /** override the Shortcut names (defaults: "Attune DND On" / "Attune DND Off") */
  dndShortcuts?: { on: string; off: string };
}

const PACER_DUCK_PCT = 40; // music under the pacer (§5)
const SAY_VOICE = "Samantha";
const CMD_TIMEOUT_MS = 15_000;

export const DND_SETUP_HINT =
  'DND unavailable: create two Shortcuts named "Attune DND On" and "Attune DND Off" (Shortcuts app → + → action "Set Focus" → Do Not Disturb On / Off), then retry.';

/** execFile with argv (no shell), stdin closed, stdout as a trimmed string. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: CMD_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(String(stdout).trim());
    });
    child.stdin?.end();
  });
}

/** AppleScript string literal: only backslash and double quote need escaping. */
const asString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export class MacActuators implements ActuatorPort {
  private readonly warn: (msg: string) => void;
  private readonly log: (msg: string) => void;
  private readonly hooks: ActuatorHooks;
  private readonly dndNames: { on: string; off: string };

  // volume duck: the level to go back to (null = not ducked) + the pending restore
  private originalVolume: number | null = null;
  private restoreTimer: NodeJS.Timeout | null = null;
  private volumeChain: Promise<void> = Promise.resolve(); // serialises read/set/restore

  private speaking: ChildProcess | null = null;

  private readonly elevenlabs: ElevenLabsSpeaker | null = CONFIG.elevenlabs.apiKey

    ? new ElevenLabsSpeaker({ ...CONFIG.elevenlabs, log: (m) => this.log(m), warn: (m) => this.warn(m) })

    : null;
  private voice: Promise<string | null> | null = null;
  private dndHinted = false;

  constructor(opts: MacActuatorOptions = {}) {
    this.warn = opts.warn ?? ((m) => console.warn(`[actuators] ${m}`));
    this.log = opts.log ?? (() => {});
    this.hooks = opts;
    this.dndNames = opts.dndShortcuts ?? { on: "Attune DND On", off: "Attune DND Off" };
  }

  // ── pacer ────────────────────────────────────────────────────────────────

  startPacer(seconds: number, bpm: number): void {
    this.notify("Breathing pacer", `${bpm} breaths/min for ${Math.round(seconds)} s — follow the circle`);
    this.duckVolume(PACER_DUCK_PCT, seconds);
    this.log(`◐ pacer ${bpm} breaths/min for ${seconds}s (notification + music ducked to ${PACER_DUCK_PCT}%)`);
    this.hooks.onPacer?.(seconds, bpm);
  }

  // ── break card (headless fallback) ───────────────────────────────────────

  suggestBreak(kind: string, minutes: number, reason: string): void {
    this.notify("Attune", reason, `Break: ${kind} · ${minutes} min`);
    this.log(`☕ break card — ${kind}, ${minutes} min: "${reason}" (notification)`);
    this.hooks.onBreak?.(kind, minutes);
  }

  // ── Do Not Disturb via Shortcuts ─────────────────────────────────────────

  async setDnd(on: boolean): Promise<void> {
    const name = on ? this.dndNames.on : this.dndNames.off;
    try {
      await run("shortcuts", ["run", name]);
      this.log(`◙ macOS Focus ${on ? "ON" : "OFF"} (shortcuts run "${name}")`);
      this.hooks.onDnd?.(on);
    } catch (err) {
      const msg = errMsg(err);
      if (/find shortcut|not found|does not exist|doesn.t exist/i.test(msg)) {
        if (!this.dndHinted) this.warn(DND_SETUP_HINT);
        this.dndHinted = true;
      } else {
        this.warn(`DND ${on ? "on" : "off"} failed: ${msg}`);
      }
    }
  }

  // ── volume duck with restore ─────────────────────────────────────────────

  duckVolume(pct: number, seconds: number): void {
    const target = Math.max(0, Math.min(100, Math.round(pct)));
    if (this.restoreTimer) clearTimeout(this.restoreTimer); // extend, don't stack
    this.restoreTimer = null;
    this.enqueue(async () => {
      // remember the ORIGINAL level only when not already ducked
      if (this.originalVolume === null) this.originalVolume = await this.readVolume();
      await this.setVolume(target);
      this.log(`▂ volume ${this.originalVolume}% → ${target}% for ${seconds}s`);
      this.restoreTimer = setTimeout(() => {
        this.restoreTimer = null;
        void this.restoreVolume();
      }, Math.max(0, seconds) * 1000);
    });
  }

  /** put the volume back now (also used on shutdown) */
  restoreVolume(): Promise<void> {
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.restoreTimer = null;
    return this.enqueue(async () => {
      const original = this.originalVolume;
      if (original === null) return;
      this.originalVolume = null;
      await this.setVolume(original);
      this.log(`▂ volume restored to ${original}%`);
    });
  }

  // ── speech ───────────────────────────────────────────────────────────────

  say(text: string): void {
    const line = text.trim();
    if (!line) return;
    if (this.speaking && this.speaking.exitCode === null) this.speaking.kill(); // never overlap
    void speakOrFallback(this.elevenlabs, line, () => this.sayLocal(line), this.warn);
  }

  private sayLocal(line: string): void {
    void this.pickVoice().then((voice) => {
      const args = voice ? ["-v", voice] : [];
      // text goes in on stdin, so a line starting with "-" can't become an option
      const child = spawn("say", args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", (err) => this.warn(`say failed: ${err.message}`));
      child.stdin.on("error", () => {}); // killed before it read stdin — fine
      child.stdin.end(line);
      this.speaking = child;
      this.log(`🗣 say${voice ? ` (${voice})` : ""}: "${line}"`);
    });
  }

  /** stop speech and put the volume back — call when the session ends */
  async dispose(): Promise<void> {
    if (this.speaking && this.speaking.exitCode === null) this.speaking.kill();
    this.speaking = null;
    this.elevenlabs?.stop();
    await this.restoreVolume();
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private notify(title: string, message: string, subtitle?: string): void {
    const script =
      `display notification ${asString(message)} with title ${asString(title)}` +
      (subtitle ? ` subtitle ${asString(subtitle)}` : "");
    run("osascript", ["-e", script]).catch((err) => this.warn(`notification failed: ${errMsg(err)}`));
  }

  private async readVolume(): Promise<number> {
    const out = await run("osascript", ["-e", "output volume of (get volume settings)"]);
    const n = Number(out);
    if (!Number.isFinite(n)) throw new Error(`unexpected volume reading "${out}"`);
    return n;
  }

  private setVolume(pct: number): Promise<string> {
    return run("osascript", ["-e", `set volume output volume ${pct}`]);
  }

  /** one operation on the volume at a time, failures reported not thrown */
  private enqueue(op: () => Promise<void>): Promise<void> {
    this.volumeChain = this.volumeChain.then(op).catch((err) => this.warn(`volume: ${errMsg(err)}`));
    return this.volumeChain;
  }

  private pickVoice(): Promise<string | null> {
    this.voice ??= run("say", ["-v", "?"])
      .then((list) => (new RegExp(`^${SAY_VOICE}\\b`, "m").test(list) ? SAY_VOICE : null))
      .catch(() => null);
    return this.voice;
  }
}

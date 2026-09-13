// Screen channel (design.md §4b): "is it the *right* work?" A periodic
// screenshot + frontmost window title → one Claude call, no tools, structured
// output → { onTask, activity, confidence }. Plain Node, zero Electron: capture
// is macOS `screencapture`, downscale is `sips`, the front app is `osascript`.
//
// Privacy stance (§4b): the thumbnail is the one thing that leaves the laptop.
// It is written to a tmp file, downscaled to ≤ CONFIG.screen.maxWidth px, read,
// deleted, and sent once — never persisted, never logged. pause()/resume() is
// the user's one-click off switch.
//
// Cadence: every `intervalSec`, plus immediately when the frontmost app/window
// changes (polled every `titlePollSec`), plus whatever the fuser asks for via
// checkNow() (e.g. on a face refocus). The Claude call is skipped when the title
// is unchanged AND the capture's byte size moved < 3 % — a cheap stand-in for a
// perceptual hash.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { CONFIG } from "../../config.js";
import type { SessionEventOf } from "../../session/events.js";
import { errMsg } from "../../util.js";

const run = promisify(execFile);

/** What the controller forwards to the fuser and re-emits as `screen:verdict`. */
export type ScreenVerdict = Omit<SessionEventOf<"screen:verdict">, "type"> & { app: string; title: string };

export interface ScreenUsage {
  calls: number; // Claude calls actually made
  skipped: number; // checks short-circuited by the title+size heuristic
  unknown: number; // calls whose output failed to parse (state not flipped)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type ScreenCheckerEvents = { verdict: [ScreenVerdict]; warning: [message: string] };

const Verdict = z.object({
  on_task: z.boolean(),
  activity: z.string(), // "reading a PDF about SN2 reactions", "YouTube", "iMessage"
  confidence: z.enum(["low", "medium", "high"]),
});

// Byte-stable on purpose (prompt cache). Anything volatile — the task, the
// front app — goes in the user turn.
const SCREEN_SYSTEM_PROMPT =
  "You judge whether a student's screen is consistent with their stated study task. " +
  "You see one downscaled screenshot plus the frontmost app and window title. " +
  "Be generous about adjacent tools: a browser tab of lecture notes, a calculator, a terminal, " +
  "a chat with a classmate about the problem set, a music player in the background. " +
  "Be strict about entertainment, social feeds, video, games, shopping, and unrelated work. " +
  "Describe the activity in a short phrase (what they are doing, not what app is open). " +
  "Use low confidence when the screen is ambiguous, blank, or mostly a desktop. " +
  "Reply in the schema only.";

const SCREEN_RECORDING_FIX =
  "Screen capture failed or came back empty. Grant Screen Recording to the app running Attune " +
  "(your terminal, e.g. Terminal/iTerm/VS Code/Cursor) in System Settings → Privacy & Security → Screen Recording, " +
  "then restart that app. Screen checks are paused until then.";

const BLACK_FRAME_BYTES = 2_000; // a real 1024-px JPEG of anything is far bigger than this

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic({ timeout: 30_000, maxRetries: 1 });
  return client;
}

async function frontmost(): Promise<{ app: string; title: string }> {
  // One AppleScript round-trip; the window name needs Accessibility on some
  // setups, so it is wrapped in `try` and may come back empty.
  const script = [
    'tell application "System Events"',
    "set p to first application process whose frontmost is true",
    "set appName to name of p",
    'set winName to ""',
    "try",
    "set winName to name of front window of p",
    "end try",
    "return appName & linefeed & winName",
    "end tell",
  ].join("\n");
  try {
    const { stdout } = await run("osascript", ["-e", script], { timeout: 5_000 });
    const [app = "", ...rest] = stdout.replace(/\n$/, "").split("\n");
    return { app: app.trim(), title: rest.join(" ").trim() };
  } catch {
    return { app: "", title: "" };
  }
}

export class ScreenChecker extends EventEmitter<ScreenCheckerEvents> {
  readonly usage: ScreenUsage = {
    calls: 0,
    skipped: 0,
    unknown: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  private task = "";
  private running = false;
  private paused = false;
  private inFlight = false;
  private pending = false; // a check requested while one was in flight
  private intervalTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastKey = ""; // "app — title" of the last capture we considered
  private lastBytes = 0;
  private captureBroken = false;
  private lastWarning = "";

  get isRunning(): boolean {
    return this.running;
  }
  get isPaused(): boolean {
    return this.paused;
  }

  start(task: string): void {
    if (this.running) {
      this.setTask(task);
      return;
    }
    this.task = task;
    this.running = true;
    this.paused = false;
    this.captureBroken = false;
    this.intervalTimer = setInterval(() => void this.check(false), CONFIG.screen.intervalSec * 1000);
    this.pollTimer = setInterval(() => void this.pollTitle(), CONFIG.screen.titlePollSec * 1000);
    void this.check(true);
  }

  stop(): void {
    this.running = false;
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.intervalTimer = this.pollTimer = null;
    this.lastKey = "";
    this.lastBytes = 0;
  }

  /** The user's one-click off switch (§4b privacy). Timers keep ticking; nothing is captured. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.captureBroken = false; // the user may have granted permission meanwhile — try again
    if (this.running) void this.check(true);
  }

  setTask(task: string): void {
    if (task === this.task) return;
    this.task = task;
    if (this.running && !this.paused) void this.check(true); // the old verdict is about the old task
  }

  /** Force a check now (bypasses the unchanged-screen heuristic). Resolves to the verdict, or null if skipped/unknown. */
  checkNow(): Promise<ScreenVerdict | null> {
    return this.check(true);
  }

  // ── internals ──

  private warn(message: string): void {
    if (message === this.lastWarning) return; // don't nag on every tick
    this.lastWarning = message;
    this.emit("warning", message);
  }

  private async pollTitle(): Promise<void> {
    if (!this.running || this.paused || this.inFlight) return;
    const { app, title } = await frontmost();
    const key = `${app} — ${title}`;
    if (this.lastKey && key !== this.lastKey) void this.check(false);
  }

  private async check(force: boolean): Promise<ScreenVerdict | null> {
    if (!this.running || this.paused || this.captureBroken || !this.task) return null;
    if (this.inFlight) {
      this.pending = true;
      return null;
    }
    this.inFlight = true;
    try {
      return await this.checkOnce(force);
    } catch (err) {
      this.warn(`screen check failed: ${errMsg(err)}`);
      return null;
    } finally {
      this.inFlight = false;
      if (this.pending) {
        this.pending = false;
        void this.check(false);
      }
    }
  }

  private async checkOnce(force: boolean): Promise<ScreenVerdict | null> {
    const { app, title } = await frontmost();
    const key = `${app} — ${title}`;
    const jpeg = await this.capture();
    if (!jpeg) return null;

    const sizeDelta = this.lastBytes ? Math.abs(jpeg.length - this.lastBytes) / this.lastBytes : 1;
    const unchanged = key === this.lastKey && sizeDelta < 0.03;
    this.lastKey = key;
    this.lastBytes = jpeg.length;
    if (unchanged && !force) {
      this.usage.skipped += 1;
      return null;
    }

    const task = this.task;
    const front = app ? `${app}${title ? ` — ${title}` : ""}` : "(unknown)";
    const res = await getClient().messages.parse({
      model: CONFIG.model,
      max_tokens: 256,
      output_config: { effort: "low", format: zodOutputFormat(Verdict) },
      system: SCREEN_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
            { type: "text", text: `TASK: ${task}\nFRONT APP: ${front}\nIs the screen consistent with the task?` },
          ],
        },
      ],
    });
    this.usage.calls += 1;
    this.usage.inputTokens += res.usage.input_tokens;
    this.usage.outputTokens += res.usage.output_tokens;
    this.usage.cacheReadTokens += res.usage.cache_read_input_tokens ?? 0;
    this.usage.cacheCreationTokens += res.usage.cache_creation_input_tokens ?? 0;

    const parsed = res.parsed_output;
    if (!parsed) {
      // refusal / max_tokens / malformed → unknown; never flip state on a guess
      this.usage.unknown += 1;
      return null;
    }
    if (!this.running || task !== this.task) return null; // stale by the time it came back
    const verdict: ScreenVerdict = {
      onTask: parsed.on_task,
      activity: parsed.activity,
      confidence: parsed.confidence,
      ts: Date.now(),
      app,
      title,
    };
    this.emit("verdict", verdict);
    return verdict;
  }

  /** One-shot screenshot → downscaled JPEG bytes. The tmp file never outlives this call. */
  private async capture(): Promise<Buffer | null> {
    const file = join(tmpdir(), `attune-screen-${process.pid}-${Date.now()}.jpg`);
    try {
      await run("screencapture", ["-x", "-t", "jpg", "-C", file], { timeout: 10_000 });
      const { size } = await stat(file);
      if (size < BLACK_FRAME_BYTES) {
        this.captureBroken = true;
        this.warn(SCREEN_RECORDING_FIX);
        return null;
      }
      const { stdout } = await run("sips", ["-g", "pixelWidth", file], { timeout: 10_000 });
      const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1] ?? 0);
      if (width > CONFIG.screen.maxWidth) {
        await run("sips", ["--resampleWidth", String(CONFIG.screen.maxWidth), file], { timeout: 10_000 });
      }
      return await readFile(file);
    } catch (err) {
      this.captureBroken = true;
      this.warn(`${SCREEN_RECORDING_FIX} (${errMsg(err)})`);
      return null;
    } finally {
      await unlink(file).catch(() => {});
    }
  }
}

// ElevenLabs text-to-speech for the say_nudge lever: synthesize to MP3 over
// the REST API, play it with macOS `afplay`, never overlapping. Falls back to
// the caller's alternative (macOS `say`) when there is no key or the request
// fails — a nudge must never crash a deliberation.
//
// POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
//   header xi-api-key · body { text, model_id, voice_settings } · audio/mpeg back

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, unlink, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { errMsg } from "../util.js";

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  modelId: string;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

const REQUEST_TIMEOUT_MS = 10_000;

export class ElevenLabsSpeaker {
  private playing: ChildProcess | null = null;
  private readonly dir = mkdtempSync(path.join(tmpdir(), "attune-tts-"));
  private seq = 0;

  constructor(private readonly opts: ElevenLabsOptions) {}

  /** Synthesize and play. Resolves once playback has STARTED; rejects only if synthesis failed. */
  async speak(text: string): Promise<void> {
    const audio = await this.synthesize(text);
    const file = path.join(this.dir, `nudge-${++this.seq}.mp3`);
    writeFileSync(file, audio);
    this.stop(); // never overlap
    const child = spawn("afplay", [file], { stdio: "ignore" });
    child.on("error", (err) => this.opts.warn?.(`afplay failed: ${err.message}`));
    child.on("exit", () => unlink(file, () => {}));
    this.playing = child;
    this.opts.log?.(`🗣 elevenlabs (${this.opts.voiceId.slice(0, 6)}…): "${text}"`);
  }

  stop(): void {
    if (this.playing && this.playing.exitCode === null) this.playing.kill();
    this.playing = null;
  }

  private async synthesize(text: string): Promise<Buffer> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.opts.voiceId)}?output_format=mp3_44100_128`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.opts.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: this.opts.modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, speed: 1.0 },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ElevenLabs ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Convenience: speak with ElevenLabs, or run `fallback` when unavailable. */
export async function speakOrFallback(
  speaker: ElevenLabsSpeaker | null,
  text: string,
  fallback: () => void,
  warn?: (msg: string) => void,
): Promise<void> {
  if (!speaker) return fallback();
  try {
    await speaker.speak(text);
  } catch (err) {
    warn?.(`ElevenLabs unavailable (${errMsg(err)}) — using macOS say`);
    fallback();
  }
}

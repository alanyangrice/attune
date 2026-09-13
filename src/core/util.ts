// Tiny shared helpers. Keep this file boring.

export const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 125 → "2:05" */
export function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

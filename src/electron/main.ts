// Electron entry (design.md §2: electron/ is a THIN host). This file only
// puts the project's .env into process.env and then loads host.ts.
//
// Why the two-step: src/config.ts reads `.env` relative to its own file, and
// tsc emits it under dist-electron/src/, where `../.env` does not exist. The
// loader in config.ts skips keys that are already set, so seeding
// process.env here (before config.ts is ever imported — ESM imports hoist,
// hence the dynamic import) keeps a single source of truth.

import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

function loadDotenv(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return; // no .env — fine, same as config.ts
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1] || m[1].startsWith("#")) continue;
    const key = m[1].toUpperCase();
    const val = (m[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotenv(path.join(app.getAppPath(), ".env"));

// No top-level await past this point: Electron holds the `ready` event until
// the ESM entry finishes evaluating, so awaiting whenReady() here deadlocks.
void import("./host.js").then((m) => m.startHost());

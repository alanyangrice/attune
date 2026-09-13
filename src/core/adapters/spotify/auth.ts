// Spotify Authorization Code + PKCE (design.md §8).
// Plain Node — opens the system browser (no Electron dependency).
// The refresh token is persisted (gitignored) so the browser login happens
// once, not every run.

import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";

const REDIRECT_URI = "http://127.0.0.1:8888/callback"; // IP literal — Spotify rejects localhost
const SCOPES =
  "user-read-private user-read-playback-state user-modify-playback-state user-read-currently-playing user-top-read playlist-read-private user-library-read";
const EXPIRY_SKEW_MS = 60_000;
const LOGIN_TIMEOUT_MS = 120_000;
const TOKEN_FILE = new URL("../../../../.spotify-tokens.json", import.meta.url);

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

let accessToken = "";
let refreshToken = "";
let expiresAt = 0;
let refreshing: Promise<void> | null = null; // in-flight dedup: the poll and a tool call can both hit expiry

function clientId(): string {
  const id = process.env.SPOTIFY_CLIENT_ID ?? "";
  if (!id) throw new Error("SPOTIFY_CLIENT_ID is not set (copy .env.example → .env)");
  return id;
}

function openBrowser(url: string): void {
  let executable = "xdg-open";
  let args = [url];
  if (process.platform === "win32") {
    executable = "rundll32";
    args = ["url.dll,FileProtocolHandler", url];
  } else if (process.platform === "darwin") {
    executable = "open";
  }
  execFile(executable, args);
}

function loadSavedRefreshToken(): string {
  try {
    return (JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as { refresh_token?: string }).refresh_token ?? "";
  } catch {
    return "";
  }
}

/** POST to the token endpoint with a grant, store the result. */
async function tokenRequest(what: string, grant: Record<string, string>): Promise<void> {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), ...grant }),
  });
  if (!response.ok) throw new Error(`${what} failed: ${response.status} ${response.statusText}`);
  const data = (await response.json()) as TokenResponse;
  accessToken = data.access_token;
  expiresAt = Date.now() + data.expires_in * 1000;
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    refreshToken = data.refresh_token; // PKCE rotates refresh tokens; persist only when it changed
    try {
      writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: refreshToken }), { mode: 0o600 });
    } catch {
      /* not fatal — we just log in again next run */
    }
  }
}

function refreshAccessToken(): Promise<void> {
  if (!refreshToken) return Promise.reject(new Error("No refresh token — call authenticate() first"));
  refreshing ??= tokenRequest("Token refresh", { grant_type: "refresh_token", refresh_token: refreshToken }).finally(
    () => {
      refreshing = null;
    },
  );
  return refreshing;
}

/** Log in. Reuses a saved refresh token when possible; opens the browser only when it must. */
export async function authenticate(): Promise<void> {
  const saved = loadSavedRefreshToken();
  if (saved) {
    refreshToken = saved;
    try {
      await refreshAccessToken();
      return;
    } catch {
      refreshToken = ""; // revoked or expired — fall through to the browser
    }
  }
  await browserLogin();
}

export async function ensureAccessToken(): Promise<string> {
  if (!accessToken) throw new Error("Not authenticated — call authenticate() first");
  if (Date.now() >= expiresAt - EXPIRY_SKEW_MS) await refreshAccessToken();
  return accessToken;
}

async function browserLogin(): Promise<void> {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      err ? reject(err) : resolve();
    };

    const server = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "", `http://${req.headers.host}`);
        if (url.pathname !== "/callback") {
          res.statusCode = 404;
          res.end();
          return;
        }
        const code = url.searchParams.get("code");
        const denied = url.searchParams.get("error");
        if (url.searchParams.get("state") !== state) {
          res.end("Authentication failed (state mismatch).");
          finish(new Error("Spotify login: state mismatch"));
          return;
        }
        if (!code) {
          res.end("Authentication failed.");
          finish(new Error(`Spotify login failed: ${denied ?? "no code returned"}`));
          return;
        }
        res.end("Authentication successful! You can close this window.");
        try {
          await tokenRequest("Token exchange", {
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
          });
          finish();
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      finish(
        new Error(
          err.code === "EADDRINUSE"
            ? "Port 8888 is busy (another Attune login still running?) — free it and retry"
            : `Spotify login server error: ${err.message}`,
        ),
      );
    });
    const timer = setTimeout(
      () => finish(new Error(`Spotify login not completed within ${LOGIN_TIMEOUT_MS / 1000}s`)),
      LOGIN_TIMEOUT_MS,
    ).unref();

    server.listen(8888, "127.0.0.1", () => {
      const authUrl = new URL("https://accounts.spotify.com/authorize");
      authUrl.searchParams.set("client_id", clientId());
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("scope", SCOPES);
      authUrl.searchParams.set("state", state);
      console.log(`[spotify] opening browser for login (or visit): ${authUrl.toString()}`);
      openBrowser(authUrl.toString());
    });
  });
}

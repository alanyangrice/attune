// Spotify Authorization Code + PKCE (design.md §8).
// Plain Node — opens the system browser (no Electron dependency).

import { createHash, randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import http from "node:http";

const REDIRECT_URI = "http://127.0.0.1:8888/callback"; // IP literal — Spotify rejects localhost
const SCOPES =
  "user-read-playback-state user-modify-playback-state user-read-currently-playing user-top-read playlist-read-private user-library-read";
const EXPIRY_SKEW_MS = 60_000;

let accessToken = "";
let refreshToken = "";
let expiresAt = 0;

function clientId(): string {
  const id = process.env.SPOTIFY_CLIENT_ID ?? "";
  if (!id) throw new Error("SPOTIFY_CLIENT_ID is not set (copy .env.example → .env)");
  return id;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? `cmd /c start "" "${url.replace(/"/g, "")}"`
      : process.platform === "darwin"
        ? `open "${url.replace(/"/g, '\\"')}"`
        : `xdg-open "${url.replace(/"/g, '\\"')}"`;
  exec(cmd);
}

function storeTokens(data: {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}): void {
  accessToken = data.access_token;
  if (data.refresh_token) refreshToken = data.refresh_token;
  expiresAt = Date.now() + data.expires_in * 1000;
}

export async function authenticate(): Promise<void> {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  await new Promise<void>((resolve, reject) => {
    const server = http
      .createServer((req, res) => {
        void (async () => {
          const url = new URL(req.url ?? "", `http://${req.headers.host}`);
          if (url.pathname !== "/callback") return;
          const code = url.searchParams.get("code");
          if (!code) {
            res.end("Authentication failed.");
            server.close();
            reject(new Error("No code returned"));
            return;
          }
          res.end("Authentication successful! You can close this window.");
          server.close();
          try {
            await exchangeToken(code, verifier);
            resolve();
          } catch (err) {
            reject(err);
          }
        })();
      })
      .listen(8888, "127.0.0.1");

    const authUrl = new URL("https://accounts.spotify.com/authorize");
    authUrl.searchParams.set("client_id", clientId());
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("scope", SCOPES);
    openBrowser(authUrl.toString());
  });
}

async function exchangeToken(code: string, verifier: string): Promise<void> {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!response.ok) throw new Error(`Token exchange failed: ${response.statusText}`);
  storeTokens((await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  });
}

export async function refreshAccessToken(): Promise<void> {
  if (!refreshToken) throw new Error("No refresh token — call authenticate() first");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) throw new Error(`Token refresh failed: ${response.statusText}`);
  storeTokens((await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  });
}

export async function ensureAccessToken(): Promise<string> {
  if (!accessToken) throw new Error("Not authenticated — call authenticate() first");
  if (Date.now() >= expiresAt - EXPIRY_SKEW_MS) await refreshAccessToken();
  return accessToken;
}

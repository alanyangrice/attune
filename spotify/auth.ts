import crypto from 'crypto';
import http from 'http';
import { shell } from 'electron';

const REDIRECT_URI = 'http://127.0.0.1:8888/callback'; // Must be IP literal, not localhost
const SCOPES =
  'user-read-playback-state user-modify-playback-state user-read-currently-playing user-top-read playlist-read-private user-library-read';

/** Refresh ~60s before expiry so a mid-request token doesn't die. */
const EXPIRY_SKEW_MS = 60_000;

/** Read at call time so dotenv can load before authenticate(). */
function clientId(): string {
  const id = process.env.SPOTIFY_CLIENT_ID || '';
  if (!id) {
    throw new Error('SPOTIFY_CLIENT_ID is not set (copy .env.example → .env)');
  }
  return id;
}

let accessToken = '';
let refreshToken = '';
/** Epoch ms when accessToken becomes invalid. */
let expiresAt = 0;

function generateCodeVerifier() {
  return crypto.randomBytes(64).toString('base64url');
}

function generateCodeChallenge(verifier: string) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function storeTokens(data: {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}) {
  accessToken = data.access_token;
  if (data.refresh_token) refreshToken = data.refresh_token;
  expiresAt = Date.now() + data.expires_in * 1000;
}

export async function authenticate(): Promise<void> {
  return new Promise((resolve, reject) => {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);

    const server = http
      .createServer(async (req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          if (code) {
            res.end('Authentication successful! You can close this window.');
            server.close();
            try {
              await exchangeToken(code, verifier);
              resolve();
            } catch (err) {
              reject(err);
            }
          } else {
            res.end('Authentication failed.');
            reject(new Error('No code returned'));
          }
        }
      })
      .listen(8888, '127.0.0.1');

    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.searchParams.append('client_id', clientId());
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.append('code_challenge_method', 'S256');
    authUrl.searchParams.append('code_challenge', challenge);
    authUrl.searchParams.append('scope', SCOPES);

    shell.openExternal(authUrl.toString());
  });
}

async function exchangeToken(code: string, verifier: string) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.statusText}`);
  }
  storeTokens((await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  });
}

/**
 * Exchange the stored refresh token for a new access token.
 * Spotify may rotate refresh_token; storeTokens keeps whichever it returns.
 */
export async function refreshAccessToken(): Promise<void> {
  if (!refreshToken) {
    throw new Error('No refresh token — call authenticate() first');
  }
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.statusText}`);
  }
  storeTokens((await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  });
}

/** Sync peek — prefer ensureAccessToken() for API calls. */
export function getAccessToken(): string {
  return accessToken;
}

/** Returns a valid access token, refreshing transparently if near expiry. */
export async function ensureAccessToken(): Promise<string> {
  if (!accessToken) {
    throw new Error('Not authenticated — call authenticate() first');
  }
  if (Date.now() >= expiresAt - EXPIRY_SKEW_MS) {
    await refreshAccessToken();
  }
  return accessToken;
}

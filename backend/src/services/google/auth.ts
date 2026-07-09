import { eq } from "drizzle-orm";
import { db } from "../../db";
import { googleAuth } from "../../db/schema";
import { env } from "../../lib/env";
import { emit } from "../events";

// Hand-rolled OAuth2 for a single user: Desktop-app client + loopback (or
// manual code paste), refresh token persisted in its own table — never in
// config, which is dashboard-visible.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/calendar";
export const LOOPBACK_REDIRECT = "http://localhost:8765/callback";

export function authRow() {
  return db.select().from(googleAuth).where(eq(googleAuth.id, "singleton")).get() ?? null;
}

export function isConnected(): boolean {
  return authRow() !== null;
}

export function consentUrl(): string {
  if (!env.GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID not set in .env");
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: LOOPBACK_REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // always mint a refresh token
  });
  return `${AUTH_URL}?${params}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set in .env");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`google token endpoint ${res.status}: ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

// Complete the flow with an authorization code (from the loopback helper
// script or pasted manually into POST /api/calendar/auth/token).
export async function exchangeCode(code: string) {
  const tok = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: LOOPBACK_REDIRECT,
  });
  if (!tok.refresh_token) {
    throw new Error("google did not return a refresh token — re-run consent with prompt=consent");
  }
  const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString();
  db.insert(googleAuth)
    .values({
      id: "singleton",
      refreshToken: tok.refresh_token,
      accessToken: tok.access_token,
      accessTokenExpiresAt: expiresAt,
    })
    .onConflictDoUpdate({
      target: googleAuth.id,
      set: { refreshToken: tok.refresh_token, accessToken: tok.access_token, accessTokenExpiresAt: expiresAt },
    })
    .run();
  emit("google_auth", null, "google_connected", {});
  return { ok: true };
}

export async function getAccessToken(): Promise<string> {
  const row = authRow();
  if (!row) throw new Error("google calendar not connected — run the OAuth flow first");
  if (row.accessToken && row.accessTokenExpiresAt && row.accessTokenExpiresAt > new Date().toISOString()) {
    return row.accessToken;
  }
  const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: row.refreshToken });
  const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString();
  db.update(googleAuth)
    .set({ accessToken: tok.access_token, accessTokenExpiresAt: expiresAt })
    .where(eq(googleAuth.id, "singleton"))
    .run();
  return tok.access_token;
}

export function setDreamCalendarId(id: string) {
  db.update(googleAuth).set({ dreamCalendarId: id }).where(eq(googleAuth.id, "singleton")).run();
}

export function setSyncToken(token: string | null) {
  db.update(googleAuth).set({ syncToken: token }).where(eq(googleAuth.id, "singleton")).run();
}

export function disconnect() {
  db.delete(googleAuth).where(eq(googleAuth.id, "singleton")).run();
  emit("google_auth", null, "google_disconnected", {});
}

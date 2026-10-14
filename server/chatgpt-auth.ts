import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Db } from "./db";
import { config } from "./config";

const AUTHORIZATION_ENDPOINT = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
const DISCOVERY_ENDPOINT = "https://auth.openai.com/.well-known/openid-configuration";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

type CredentialRow = {
  id: string; client_id: string; email: string | null; subject: string; id_token: string;
  access_token: string; refresh_token: string; token_type: string; scopes: string;
  expires_at: string; active: number; refresh_lock_until: string | null; updated_at: string;
};

type TokenResponse = {
  access_token: string; refresh_token?: string; id_token?: string; token_type?: string;
  expires_in?: number; scope?: string;
};

export function getChatGPTStatus(db: Db) {
  const row = activeCredential(db);
  if (!row) return { connected: false, planUsageEnabled: false, textModel: config.openAITextModel };
  return {
    connected: true,
    email: row.email,
    planUsageEnabled: scopes(row).includes("chatgpt.tokens.use.direct"),
    expiresAt: row.expires_at,
    textModel: config.openAITextModel,
    imageGenerationSupported: false
  };
}

export function startChatGPTAuthorization(db: Db) {
  const existing = activeCredential(db);
  const state = randomToken(32); const nonce = randomToken(32); const verifier = randomToken(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = `http://127.0.0.1:${config.apiPort}/api/auth/chatgpt/callback`;
  const clientId = existing?.client_id ?? "dynamic_agent_client";
  const hostId = getOrCreateHostId(db);
  db.prepare("DELETE FROM chatgpt_oauth_attempts WHERE created_at < ?").run(new Date(Date.now() - 15 * 60_000).toISOString());
  db.prepare("INSERT INTO chatgpt_oauth_attempts VALUES(?,?,?,?,?,?)").run(state, verifier, nonce, redirectUri, clientId, new Date().toISOString());
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  if (!existing) url.searchParams.set("agent_name_hint", "Novel to Manga");
  url.searchParams.set("ext_agent_host_id", hostId);
  if (existing?.id_token) url.searchParams.set("id_token_hint", existing.id_token);
  if (existing?.email) url.searchParams.set("login_hint", existing.email);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("resource", RESOURCE);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  return url.href;
}

export async function finishChatGPTAuthorization(db: Db, query: Record<string, unknown>) {
  const state = String(query.state ?? "");
  const attempt = db.prepare("SELECT * FROM chatgpt_oauth_attempts WHERE state=?").get(state) as any;
  if (!attempt || Date.now() - Date.parse(attempt.created_at) > 15 * 60_000) throw new Error("The sign-in attempt expired. Start again from Settings.");
  db.prepare("DELETE FROM chatgpt_oauth_attempts WHERE state=?").run(state);
  if (query.error) throw new Error(`ChatGPT authorization was not completed: ${String(query.error)}`);
  const code = String(query.code ?? "");
  const callbackClientId = query.client_id ? String(query.client_id) : "";
  const isNew = attempt.requested_client_id === "dynamic_agent_client";
  const clientId = isNew ? callbackClientId : attempt.requested_client_id;
  if (!code || !clientId || clientId === "dynamic_agent_client") throw new Error("The authorization callback did not include a usable code and issued client ID.");
  if (!isNew && callbackClientId && callbackClientId !== clientId) throw new Error("The returned ChatGPT client did not match the selected account.");
  const token = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: attempt.code_verifier, redirect_uri: attempt.redirect_uri, resource: RESOURCE });
  if (!token.id_token || !token.refresh_token) throw new Error("OpenAI did not return the renewable credentials required for local plan usage.");
  const identity = await validateIdToken(token.id_token, clientId, attempt.nonce);
  const granted = (token.scope ?? String(query.scope ?? "")).split(/\s+/).filter(Boolean);
  const previous = db.prepare("SELECT * FROM chatgpt_credentials WHERE client_id=?").get(clientId) as CredentialRow | undefined;
  if (previous && previous.subject !== identity.subject) throw new Error("The returned identity did not match the saved ChatGPT registration.");
  const savedAt = new Date(); const expiresAt = new Date(savedAt.getTime() + Number(token.expires_in ?? 3600) * 1000).toISOString();
  db.transaction(() => {
    db.prepare("UPDATE chatgpt_credentials SET active=0").run();
    db.prepare(`INSERT INTO chatgpt_credentials(id,client_id,email,subject,id_token,access_token,refresh_token,token_type,scopes,expires_at,active,refresh_lock_until,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,1,NULL,?) ON CONFLICT(client_id) DO UPDATE SET email=excluded.email,subject=excluded.subject,id_token=excluded.id_token,access_token=excluded.access_token,refresh_token=excluded.refresh_token,token_type=excluded.token_type,scopes=excluded.scopes,expires_at=excluded.expires_at,active=1,refresh_lock_until=NULL,updated_at=excluded.updated_at`)
      .run(previous?.id ?? randomUUID(), clientId, identity.email, identity.subject, token.id_token, token.access_token, token.refresh_token, token.token_type ?? "Bearer", JSON.stringify(granted), expiresAt, savedAt.toISOString());
  })();
  return { email: identity.email, planUsageEnabled: granted.includes("chatgpt.tokens.use.direct") };
}

export async function getChatGPTAccessToken(db: Db) {
  let row = activeCredential(db);
  if (!row || !scopes(row).includes("chatgpt.tokens.use.direct")) throw new Error("Connect an eligible ChatGPT account in Settings before using hybrid text generation.");
  if (Date.parse(row.expires_at) > Date.now() + 60_000) return row.access_token;
  const lockUntil = new Date(Date.now() + 20_000).toISOString();
  const acquired = db.prepare("UPDATE chatgpt_credentials SET refresh_lock_until=? WHERE id=? AND (refresh_lock_until IS NULL OR refresh_lock_until<?)").run(lockUntil, row.id, new Date().toISOString()).changes;
  if (!acquired) {
    for (let i = 0; i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 250)); row = activeCredential(db); if (row && Date.parse(row.expires_at) > Date.now() + 60_000) return row.access_token; }
    throw new Error("ChatGPT credentials are being refreshed by another process. Try again shortly.");
  }
  try {
    const token = await tokenRequest({ grant_type: "refresh_token", client_id: row.client_id, refresh_token: row.refresh_token, resource: RESOURCE });
    const expiresAt = new Date(Date.now() + Number(token.expires_in ?? 3600) * 1000).toISOString();
    db.prepare(`UPDATE chatgpt_credentials SET access_token=?,refresh_token=?,id_token=?,token_type=?,scopes=?,expires_at=?,refresh_lock_until=NULL,updated_at=? WHERE id=?`)
      .run(token.access_token, token.refresh_token ?? row.refresh_token, token.id_token ?? row.id_token, token.token_type ?? row.token_type, JSON.stringify((token.scope?.split(/\s+/).filter(Boolean) ?? scopes(row))), expiresAt, new Date().toISOString(), row.id);
    return token.access_token;
  } catch (error) { db.prepare("UPDATE chatgpt_credentials SET refresh_lock_until=NULL WHERE id=?").run(row.id); throw error; }
}

export async function disconnectChatGPT(db: Db) {
  const row = activeCredential(db);
  if (!row) return { disconnected: true, remoteRevocationConfirmed: true };
  let confirmed = false;
  try {
    const discovery = await fetchDiscovery();
    if (discovery.revocation_endpoint) {
      const response = await fetch(discovery.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: row.refresh_token, token_type_hint: "refresh_token", client_id: row.client_id }) });
      confirmed = response.ok;
    }
  } finally { db.prepare("DELETE FROM chatgpt_credentials WHERE id=?").run(row.id); }
  return { disconnected: true, remoteRevocationConfirmed: confirmed };
}

export async function listChatGPTModels(db: Db) {
  const accessToken = await getChatGPTAccessToken(db);
  const response = await fetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(await response.text());
  const body = await response.json() as any;
  return (body.models ?? body.data ?? []).filter((m: any) => !m.visibility || m.visibility === "list").map((m: any) => ({ id: m.slug ?? m.id, name: m.display_name ?? m.id }));
}

async function tokenRequest(values: Record<string, string>) {
  const response = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(body.error_description ?? body.error ?? `OpenAI token exchange failed (${response.status}).`);
  return body as TokenResponse;
}
async function validateIdToken(idToken: string, clientId: string, nonce: string) {
  const discovery = await fetchDiscovery();
  const { payload } = await jwtVerify(idToken, createRemoteJWKSet(new URL(discovery.jwks_uri)), { issuer: discovery.issuer, audience: clientId });
  if (payload.nonce !== nonce) throw new Error("The ChatGPT identity token nonce did not match this sign-in attempt.");
  if (!payload.sub) throw new Error("The ChatGPT identity token had no subject.");
  return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : null };
}
async function fetchDiscovery() {
  const response = await fetch(DISCOVERY_ENDPOINT);
  if (!response.ok) throw new Error("Unable to load OpenAI identity configuration.");
  return response.json() as Promise<{ issuer: string; jwks_uri: string; revocation_endpoint?: string }>;
}
function activeCredential(db: Db) { return db.prepare("SELECT * FROM chatgpt_credentials WHERE active=1 ORDER BY updated_at DESC LIMIT 1").get() as CredentialRow | undefined; }
function scopes(row: CredentialRow) { try { return JSON.parse(row.scopes) as string[]; } catch { return []; } }
function randomToken(bytes: number) { return randomBytes(bytes).toString("base64url"); }
function getOrCreateHostId(db: Db) {
  const existing = db.prepare("SELECT value FROM app_settings WHERE key='chatgpt_host_id'").get() as { value: string } | undefined;
  if (existing) return existing.value;
  const value = `urn:uuid:${randomUUID()}`;
  db.prepare("INSERT INTO app_settings VALUES('chatgpt_host_id',?,?)").run(value, new Date().toISOString());
  return value;
}

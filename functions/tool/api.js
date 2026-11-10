// ============================================================
// AI営業ロープレ 体験デモ 中継API (Cloudflare Pages Functions)
// ブラウザ -> /tool/api -> Google Gemini API
// APIキーは Cloudflare の環境変数 GEMINI_API_KEY から読むだけ。
// このファイルにも、リポジトリのどこにも、キーは書かないこと。
// ============================================================

const CHAT_MODEL = 'gemini-3.5-flash-lite';
const SCORE_MODEL = 'gemini-3.5-flash-lite'; // 採点も高速モデルに統一（遅さ対策）
const DEMO_SECONDS = 180;               // 商談は3分まで
const MAX_CHAT_PER_SESSION = 60;
const MAX_SCORE_PER_SESSION = 3;
const COOKIE_NAME = 'demo_session';

const json = (code, obj, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
const err = (code, message, extraHeaders = {}) => json(code, { error: { message } }, extraHeaders);

// ---- 署名つきCookieでデモセッション（開始時刻と回数）を管理する ----
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sign(payloadObj, secret) {
  const data = b64url(new TextEncoder().encode(JSON.stringify(payloadObj)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}
async function verify(token, secret) {
  try {
    const [data, sig] = String(token || '').split('.');
    if (!data || !sig) return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sig), new TextEncoder().encode(data));
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(b64urlDecode(data)));
  } catch (e) {
    return null;
  }
}
function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
const sessionCookie = (token) =>
  `${COOKIE_NAME}=${token}; Path=/tool; Max-Age=1800; HttpOnly; Secure; SameSite=Lax`;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';
  const apiKey = env.GEMINI_API_KEY || '';
  const keyReady = apiKey.length >= 20;
  const secret = env.SESSION_SECRET || apiKey || 'demo-secret';

  // 同一ドメインからのリクエストだけを受ける
  const origin = request.headers.get('Origin') || request.headers.get('Referer') || '';
  if (origin) {
    try {
      if (new URL(origin).host !== url.host) return err(403, 'forbidden origin');
    } catch (e) { /* ignore malformed header */ }
  }

  if (action === 'status') {
    return json(200, { ready: keyReady, demoSeconds: DEMO_SECONDS });
  }

  if (action === 'start') {
    if (request.method !== 'POST') return err(405, 'POST only');
    const token = await sign({ s: Math.floor(Date.now() / 1000), c: 0, k: 0 }, secret);
    return json(200, { ok: true, demoSeconds: DEMO_SECONDS }, { 'Set-Cookie': sessionCookie(token) });
  }

  if (action !== 'generate') return err(404, 'not found');
  if (request.method !== 'POST') return err(405, 'POST only');
  if (!keyReady) return err(503, 'デモは準備中です。');

  let raw;
  try { raw = await request.text(); } catch (e) { return err(400, 'bad request'); }
  if (!raw || raw.length > 120 * 1024) return err(413, 'request too large');
  let input;
  try { input = JSON.parse(raw); } catch (e) { return err(400, 'bad request'); }
  if (!input || !Array.isArray(input.contents) || input.contents.length > 60) return err(400, 'bad request');
  const purpose = input.purpose === 'score' ? 'score' : 'chat';

  // ---- セッション制限（3分＋回数） ----
  let session = await verify(readCookie(request, COOKIE_NAME), secret);
  if (!session || typeof session.s !== 'number') {
    session = { s: Math.floor(Date.now() / 1000), c: 0, k: 0 };
  }
  const elapsed = Math.floor(Date.now() / 1000) - session.s;
  if (purpose === 'score') {
    if (elapsed > DEMO_SECONDS + 600) return err(429, 'デモの制限時間を超えました。ページを再読み込みして、もう一度お試しください。');
    if ((session.k || 0) >= MAX_SCORE_PER_SESSION) return err(429, 'このデモでの採点回数の上限に達しました。');
    session.k = (session.k || 0) + 1;
  } else {
    if (elapsed > DEMO_SECONDS + 30) return err(429, 'デモの3分が終了しました。');
    if ((session.c || 0) >= MAX_CHAT_PER_SESSION) return err(429, 'このデモでの会話回数の上限に達しました。');
    session.c = (session.c || 0) + 1;
  }
  const cookieHeader = { 'Set-Cookie': sessionCookie(await sign(session, secret)) };

  // ---- Gemini へ中継 ----
  const gc = input.generationConfig || {};
  let maxTokens = parseInt(gc.maxOutputTokens, 10) || 1024;
  maxTokens = Math.max(64, Math.min(maxTokens, purpose === 'score' ? 4096 : 1024));
  const googleBody = {
    contents: input.contents,
    generationConfig: {
      temperature: typeof gc.temperature === 'number' ? Math.max(0, Math.min(1, gc.temperature)) : 0.7,
      maxOutputTokens: maxTokens,
    },
  };
  if (input.systemInstruction && typeof input.systemInstruction === 'object') {
    googleBody.systemInstruction = input.systemInstruction;
  }
  if (gc.responseMimeType === 'application/json') {
    googleBody.generationConfig.responseMimeType = 'application/json';
  }

  const model = purpose === 'score' ? SCORE_MODEL : CHAT_MODEL;
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(googleBody),
    });
  } catch (e) {
    return err(502, 'AIに接続できませんでした。', cookieHeader);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = 'AI service error';
    try { msg = JSON.parse(text).error?.message || msg; } catch (e) { /* keep default */ }
    return err(res.status >= 400 && res.status < 600 ? res.status : 502, String(msg), cookieHeader);
  }
  // 画面側はストリーミング形式(SSE)で読むので、1イベントとしてそのまま渡す
  return new Response(`data: ${text}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', ...cookieHeader },
  });
}

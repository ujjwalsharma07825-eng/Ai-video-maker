import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const FREE_DAILY_CREDITS = 8;
export const MAX_IMAGES = 6;
export const MAX_BODY_BYTES = 60 * 1024 * 1024;
export const DB_PATH = path.resolve('server/data/credits.json');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT_WITH_SEPARATOR = `${ROOT}${path.sep}`;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

await loadDotEnv();
const PORT = Number(process.env.PORT || 8787);
export let PRO_DAILY_CREDITS = Number(process.env.PRO_DAILY_CREDITS || 100);

async function loadDotEnv() {
  try {
    const envPath = path.join(ROOT, '.env');
    const content = await fs.readFile(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [key, ...valueParts] = trimmed.split('=');
      if (!process.env[key]) process.env[key] = valueParts.join('=').replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // .env is optional; production platforms normally inject environment variables directly.
  }
}

function envEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

async function saveDotEnv(updates) {
  const envPath = path.join(ROOT, '.env');
  let lines = [];
  try {
    lines = (await fs.readFile(envPath, 'utf8')).split(/\r?\n/);
  } catch {
    lines = [];
  }
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return line;
    const [key] = trimmed.split('=');
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) nextLines.push(`${key}=${value}`);
    process.env[key] = value;
    if (key === 'PRO_DAILY_CREDITS') PRO_DAILY_CREDITS = Number(value || 100);
  }
  await fs.writeFile(envPath, `${nextLines.filter(Boolean).join('\n')}\n`);
}

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export const todayKey = (date = new Date()) => date.toISOString().slice(0, 10);
export const nextRefreshUtc = (date = new Date()) => {
  const tomorrow = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return `${new Date(tomorrow).toISOString().slice(0, 10)}T00:00:00.000Z`;
};
export const creditsForPlan = (plan = 'free') => (plan === 'pro' ? PRO_DAILY_CREDITS : FREE_DAILY_CREDITS);

export async function readDb() {
  try {
    return JSON.parse(await fs.readFile(DB_PATH, 'utf8'));
  } catch {
    return { users: {}, jobs: {} };
  }
}

export async function writeDb(db) {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

export function ensureWallet(db, id, date = new Date()) {
  const today = todayKey(date);
  const existing = db.users[id] || { plan: 'free', credits: FREE_DAILY_CREDITS, refreshedAt: today };
  existing.plan ||= 'free';
  if (existing.refreshedAt !== today) {
    existing.credits = creditsForPlan(existing.plan);
    existing.refreshedAt = today;
  }
  db.users[id] = existing;
  return existing;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-client-id',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function clientId(req) {
  return req.headers['x-client-id'] || req.socket.remoteAddress || 'anonymous';
}

async function bodyBuffer(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Upload is too large. Maximum request size is 60 MB.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) return { fields: {}, files: [] };
  const fields = {};
  const files = [];
  const parts = buffer.toString('binary').split(`--${boundary}`).slice(1, -1);
  for (const part of parts) {
    const [rawHeaders, rawBody = ''] = part.replace(/^\r\n/, '').split('\r\n\r\n');
    const name = rawHeaders.match(/name="([^"]+)"/)?.[1];
    if (!name) continue;
    const filename = rawHeaders.match(/filename="([^"]*)"/)?.[1];
    const content = rawBody.replace(/\r\n$/, '');
    if (filename) {
      files.push({
        name,
        filename,
        mimetype: rawHeaders.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || 'application/octet-stream',
        buffer: Buffer.from(content, 'binary'),
      });
    } else {
      fields[name] = Buffer.from(content, 'binary').toString('utf8');
    }
  }
  return { fields, files: files.slice(0, MAX_IMAGES) };
}

function imageToDataUri(file) {
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

function cleanPrediction(prediction) {
  return {
    id: prediction.id,
    status: prediction.status,
    output: prediction.output,
    error: prediction.error,
    urls: prediction.urls,
    created_at: prediction.created_at,
    completed_at: prediction.completed_at,
  };
}

async function replicateCreate(input) {
  if (!process.env.REPLICATE_API_TOKEN) {
    throw Object.assign(new Error('REPLICATE_API_TOKEN is required for real AI video generation.'), { status: 503 });
  }
  const model = process.env.REPLICATE_VIDEO_MODEL || 'kwaivgi/kling-v1.6-standard';
  const response = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
      'content-type': 'application/json',
      prefer: 'wait=0',
    },
    body: JSON.stringify({ model, input }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.error || `Replicate create failed with ${response.status}`);
  return { model, prediction: data };
}

async function replicateGet(id) {
  if (!process.env.REPLICATE_API_TOKEN) throw Object.assign(new Error('REPLICATE_API_TOKEN is required.'), { status: 503 });
  const response = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { authorization: `Token ${process.env.REPLICATE_API_TOKEN}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.error || `Replicate poll failed with ${response.status}`);
  return data;
}

async function handleSettings(req, res) {
  const setupEnabled = envEnabled(process.env.ALLOW_BROWSER_API_SETUP);
  if (req.method === 'GET') {
    return send(res, 200, {
      setupEnabled,
      replicateConfigured: Boolean(process.env.REPLICATE_API_TOKEN),
      replicateTokenPreview: maskSecret(process.env.REPLICATE_API_TOKEN),
      model: process.env.REPLICATE_VIDEO_MODEL || 'kwaivgi/kling-v1.6-standard',
      upgradeConfigured: Boolean(process.env.UPGRADE_ACCESS_CODE),
      proDailyCredits: PRO_DAILY_CREDITS,
    });
  }
  if (!setupEnabled) return send(res, 403, { error: 'Browser API setup is disabled. Start with ALLOW_BROWSER_API_SETUP=true to enable it.' });
  const body = JSON.parse((await bodyBuffer(req)).toString('utf8') || '{}');
  if (process.env.SETUP_ADMIN_PIN && body.adminPin !== process.env.SETUP_ADMIN_PIN) return send(res, 403, { error: 'Invalid admin PIN.' });
  const updates = {};
  if (body.replicateToken) updates.REPLICATE_API_TOKEN = String(body.replicateToken).trim();
  if (body.model) updates.REPLICATE_VIDEO_MODEL = String(body.model).trim();
  if (body.upgradeCode) updates.UPGRADE_ACCESS_CODE = String(body.upgradeCode).trim();
  if (body.proDailyCredits) updates.PRO_DAILY_CREDITS = String(Number(body.proDailyCredits));
  if (!updates.REPLICATE_API_TOKEN && !updates.REPLICATE_VIDEO_MODEL && !updates.UPGRADE_ACCESS_CODE && !updates.PRO_DAILY_CREDITS) return send(res, 400, { error: 'No settings were provided.' });
  await saveDotEnv(updates);
  return send(res, 200, { ok: true, replicateConfigured: Boolean(process.env.REPLICATE_API_TOKEN), replicateTokenPreview: maskSecret(process.env.REPLICATE_API_TOKEN), model: process.env.REPLICATE_VIDEO_MODEL, upgradeConfigured: Boolean(process.env.UPGRADE_ACCESS_CODE), proDailyCredits: Number(process.env.PRO_DAILY_CREDITS || PRO_DAILY_CREDITS) });
}

async function handleUpgrade(req, res) {
  const body = JSON.parse((await bodyBuffer(req)).toString('utf8') || '{}');
  if (!process.env.UPGRADE_ACCESS_CODE) {
    return send(res, 501, { error: 'Upgrade is not configured. Set UPGRADE_ACCESS_CODE to enable pro upgrades.' });
  }
  if (body.code !== process.env.UPGRADE_ACCESS_CODE) return send(res, 403, { error: 'Invalid upgrade code.' });
  const db = await readDb();
  const wallet = ensureWallet(db, clientId(req));
  wallet.plan = 'pro';
  wallet.credits = Math.max(wallet.credits, PRO_DAILY_CREDITS);
  await writeDb(db);
  return send(res, 200, { ...wallet, dailyCredits: creditsForPlan(wallet.plan), nextRefreshUtc: nextRefreshUtc() });
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (url.pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      provider: 'replicate',
      configured: Boolean(process.env.REPLICATE_API_TOKEN),
      freeDailyCredits: FREE_DAILY_CREDITS,
      proDailyCredits: PRO_DAILY_CREDITS,
      upgradeConfigured: Boolean(process.env.UPGRADE_ACCESS_CODE),
      browserSetupEnabled: envEnabled(process.env.ALLOW_BROWSER_API_SETUP),
    });
  }
  if (url.pathname === '/api/credits') {
    const db = await readDb();
    const wallet = ensureWallet(db, clientId(req));
    await writeDb(db);
    return send(res, 200, { ...wallet, dailyCredits: creditsForPlan(wallet.plan), nextRefreshUtc: nextRefreshUtc() });
  }
  if (url.pathname === '/api/settings' && (req.method === 'GET' || req.method === 'POST')) return handleSettings(req, res);
  if (url.pathname === '/api/upgrade' && req.method === 'POST') return handleUpgrade(req, res);
  if (url.pathname === '/api/generate-video' && req.method === 'POST') {
    const parsed = parseMultipart(await bodyBuffer(req), req.headers['content-type'] || '');
    const prompt = String(parsed.fields.prompt || '').trim();
    if (prompt.length < 12) return send(res, 400, { error: 'Prompt must be at least 12 characters.' });
    const db = await readDb();
    const wallet = ensureWallet(db, clientId(req));
    if (wallet.credits < 1) return send(res, 402, { error: 'Daily free credits exhausted. Upgrade now or wait until 00:00 UTC for refresh.', wallet });
    wallet.credits -= 1;
    const images = parsed.files.map(imageToDataUri);
    const input = {
      prompt,
      duration: Number(parsed.fields.duration || 5),
      aspect_ratio: parsed.fields.aspectRatio || '16:9',
      negative_prompt: parsed.fields.negativePrompt || 'low quality, blurry, distorted, artifacts',
    };
    if (images[0]) input.image = images[0];
    if (images.length > 1) input.reference_images = images;
    try {
      const { model, prediction } = await replicateCreate(input);
      const localId = crypto.randomUUID();
      db.jobs[localId] = { providerId: prediction.id, model, mode: parsed.fields.mode === 'image' ? 'image' : 'text', prompt, createdAt: new Date().toISOString(), clientId: clientId(req) };
      await writeDb(db);
      return send(res, 200, { jobId: localId, prediction: cleanPrediction(prediction), wallet });
    } catch (error) {
      wallet.credits += 1;
      await writeDb(db);
      return send(res, error.status || 502, { error: error.message || 'Video provider failed before job creation.' });
    }
  }
  const match = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (match) {
    const db = await readDb();
    const job = db.jobs[match[1]];
    if (!job) return send(res, 404, { error: 'Job not found.' });
    try {
      return send(res, 200, { job, prediction: cleanPrediction(await replicateGet(job.providerId)) });
    } catch (error) {
      return send(res, error.status || 502, { error: error.message });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

async function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(ROOT, requested));
  if (file !== ROOT && !file.startsWith(ROOT_WITH_SEPARATOR)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const data = await fs.readFile(file);
    send(res, 200, data, MIME_TYPES[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(res, url.pathname);
  } catch (error) {
    send(res, error.status || 500, { error: error.message || 'Internal server error' });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`AI video maker running on http://localhost:${PORT}`));
}

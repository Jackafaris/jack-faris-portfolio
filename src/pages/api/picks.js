// Shared "Jack's Picks" store. Reads are public; writes require the owner code
// (server-side env PICKS_SECRET). Data lives in a public Vercel Blob so every
// visitor sees the same picks and only the owner can change them.
//
// GET  /api/picks          -> { positions: [...] }
// POST /api/picks          -> { code, action, ... }   (401 if code wrong)
//   action 'auth'    : verify code only, no write
//   action 'add'     : { position }
//   action 'remove'  : { id }
//   action 'clear'   : {}
//   action 'replace' : { positions: [...] }  (import)

import { get, put } from '@vercel/blob';

const BLOB_PATH = 'picks.json';
const MAX_POSITIONS = 50;
// Public store: reads need no auth (fetch the CDN URL directly). Writes use the
// SDK put() with BLOB_READ_WRITE_TOKEN injected by Vercel.
const BLOB_STORE_ID = process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN?.split('_')[3] || '';
const BLOB_PUBLIC_BASE = BLOB_STORE_ID
  ? `https://${BLOB_STORE_ID}.public.blob.vercel-storage.com`
  : null;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// Constant-time compare to avoid leaking the code length/char timing.
function codeValid(provided) {
  const expected = process.env.PICKS_SECRET;
  if (!expected || typeof provided !== 'string') return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function sanitizePosition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const symbol = String(raw.symbol || '').trim().toUpperCase();
  const price = Number(raw.price);
  const date = String(raw.date || '').trim();
  const shares = Number(raw.shares);
  if (!/^[A-Z0-9.\-^]{1,12}$/.test(symbol)) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.length <= 40 ? raw.id : makeId(),
    symbol,
    name: String(raw.name || symbol).slice(0, 60),
    price,
    date,
    shares: Number.isFinite(shares) && shares > 0 && shares <= 1000000 ? shares : 1,
    note: String(raw.note || '').slice(0, 140),
  };
}

async function readStore() {
  try {
    // Read via the SDK get() FIRST. The public-CDN URL (even with a
    // ?t= query param) is cached by the Blob CDN — Vercel stores the
    // cached object under its path and ignores the query string, so a
    // cache-bust read can serve the pre-write body for up to 30 days
    // (observed: age ~57000s after a clear at 2026-09-01). get() reads
    // origin storage and is always fresh.
    const blob = await get(BLOB_PATH, { type: 'json' });
    if (blob && Array.isArray(blob.positions)) {
      return { positions: blob.positions.map(sanitizePosition).filter(Boolean), etag: blob.etag || null };
    }
  } catch {
    /* 404 / not created yet / SDK auth issue -> fall through */
  }
  try {
    if (BLOB_PUBLIC_BASE) {
      // Fallback: public CDN URL (used when the SDK lacks read auth).
      // Known to be stale-prone — see note above.
      const res = await fetch(`${BLOB_PUBLIC_BASE}/${BLOB_PATH}?t=${Date.now()}`, {
        cache: 'no-store',
      });
      if (res.status === 404 || !res.ok) return { positions: [], etag: null };
      const blob = await res.json();
      if (blob && Array.isArray(blob.positions)) {
        return { positions: blob.positions.map(sanitizePosition).filter(Boolean), etag: null };
      }
    }
  } catch {
    /* ignore */
  }
  return { positions: [], etag: null };
}

async function writeStore(positions) {
  await put(BLOB_PATH, JSON.stringify({ positions, updated: new Date().toISOString() }, null, 2), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
    // Public blobs are CDN-cached for 30 days by default — that would make
    // updates invisible to visitors. Force no-cache so writes show up live.
    cacheControl: { maxAge: 0 },
  });
}

export async function GET() {
  const { positions } = await readStore();
  return json({ positions });
}

export async function POST({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const { code, action } = body || {};
  if (!codeValid(code)) return json({ error: 'Unauthorized' }, 401);

  if (action === 'auth') return json({ ok: true });

  const store = await readStore();

  switch (action) {
    case 'add': {
      const pos = sanitizePosition(body.position);
      if (!pos) return json({ error: 'Invalid position' }, 400);
      if (store.positions.length >= MAX_POSITIONS) return json({ error: 'Too many positions' }, 400);
      store.positions.push(pos);
      await writeStore(store.positions);
      return json({ positions: store.positions });
    }
    case 'remove': {
      const id = String(body.id || '');
      store.positions = store.positions.filter((p) => p.id !== id);
      await writeStore(store.positions);
      return json({ positions: store.positions });
    }
    case 'clear': {
      store.positions = [];
      await writeStore(store.positions);
      return json({ positions: store.positions });
    }
    case 'replace': {
      const arr = Array.isArray(body.positions) ? body.positions : [];
      store.positions = arr.map(sanitizePosition).filter(Boolean).slice(0, MAX_POSITIONS);
      await writeStore(store.positions);
      return json({ positions: store.positions });
    }
    default:
      return json({ error: 'Unknown action' }, 400);
  }
}

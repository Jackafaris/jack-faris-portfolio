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
//
// NOTE on the SDK: @vercel/blob >= 2.5 changed its API. get() no longer accepts
// { type: 'json' } (it is silently ignored) and put() takes
// cacheControlMaxAge (a number, min 60s), not cacheControl. Origin reads are
// done with get({ access: 'public', useCache: false }).

import { get, put, type BlobAccessType } from '@vercel/blob';

export interface Position {
  id: string;
  symbol: string;
  name: string;
  price: number;
  date: string;
  shares: number;
  note: string;
}

export interface PickStore {
  positions: Position[];
  updated?: string;
}

interface WriteBody {
  code?: string;
  action?: string;
  id?: string;
  position?: unknown;
  positions?: unknown[];
}

const BLOB_PATH = 'picks.json';
const MAX_POSITIONS = 50;
const BLOB_ACCESS = 'public' as BlobAccessType;
// Public store: reads need no auth. Writes use the SDK put() with the
// BLOB_READ_WRITE_TOKEN injected by Vercel.
const BLOB_STORE_ID =
  process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN?.split('_')[3] || '';
const BLOB_PUBLIC_BASE = BLOB_STORE_ID
  ? `https://${BLOB_STORE_ID}.public.blob.vercel-storage.com`
  : null;

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// Constant-time compare to avoid leaking the code length/char timing.
function codeValid(provided: string | undefined): boolean {
  const expected = process.env.PICKS_SECRET;
  if (!expected || typeof provided !== 'string') return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function sanitizePosition(raw: unknown): Position | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const symbol = String(r.symbol ?? '').trim().toUpperCase();
  const price = Number(r.price);
  const date = String(r.date ?? '').trim();
  const shares = Number(r.shares);
  if (!/^[A-Z0-9.\-^]{1,12}$/.test(symbol)) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    id: typeof r.id === 'string' && r.id.length <= 40 ? r.id : makeId(),
    symbol,
    name: String(r.name ?? symbol).slice(0, 60),
    price,
    date,
    shares: Number.isFinite(shares) && shares > 0 && shares <= 1000000 ? shares : 1,
    note: String(r.note ?? '').slice(0, 140),
  };
}

const clean = (positions: unknown): Position[] =>
  Array.isArray(positions)
    ? (positions.map(sanitizePosition).filter(Boolean) as Position[])
    : [];

function parseStore(raw: string): PickStore {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const store = parsed as PickStore;
      return { positions: clean(store.positions), updated: store.updated };
    }
  } catch {
    /* malformed body -> treat as empty */
  }
  return { positions: [] };
}

async function readStore(): Promise<PickStore> {
  try {
    // Origin read via the SDK (bypasses the CDN entirely).
    const result = await get(BLOB_PATH, { access: BLOB_ACCESS, useCache: false });
    if (result && result.statusCode === 200 && result.stream) {
      const text = await new Response(result.stream).text();
      return parseStore(text);
    }
  } catch {
    /* 404 / not created yet / SDK auth issue -> fall through */
  }
  try {
    if (BLOB_PUBLIC_BASE) {
      // Fallback: public CDN URL (used when the SDK lacks read auth).
      // The Blob CDN caches by path and ignores query strings, so this can
      // serve stale data — the SDK path above is always preferred.
      const res = await fetch(`${BLOB_PUBLIC_BASE}/${BLOB_PATH}?t=${Date.now()}`, {
        cache: 'no-store',
      });
      if (res.status === 404 || !res.ok) return { positions: [] };
      return parseStore(await res.text());
    }
  } catch {
    /* ignore */
  }
  return { positions: [] };
}

async function writeStore(positions: Position[]): Promise<void> {
  await put(
    BLOB_PATH,
    JSON.stringify({ positions, updated: new Date().toISOString() }, null, 2),
    {
      access: BLOB_ACCESS,
      contentType: 'application/json',
      allowOverwrite: true,
      // SDK min is 60s. Keeps the CDN from holding on to stale bodies.
      cacheControlMaxAge: 60,
    },
  );
}

export async function GET(): Promise<Response> {
  const { positions } = await readStore();
  return json({ positions });
}

export async function POST({ request }: { request: Request }): Promise<Response> {
  let body: WriteBody;
  try {
    body = (await request.json()) as WriteBody;
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
      if (store.positions.length >= MAX_POSITIONS) {
        return json({ error: 'Too many positions' }, 400);
      }
      store.positions.push(pos);
      await writeStore(store.positions);
      return json({ positions: store.positions });
    }
    case 'remove': {
      const id = String(body.id ?? '');
      store.positions = store.positions.filter((p) => p.id !== id);
      await writeStore(store.positions);
      return json({ positions: store.positions });
    }
    case 'clear':
      store.positions = [];
      await writeStore(store.positions);
      return json({ positions: store.positions });
    case 'replace': {
      const arr = Array.isArray(body.positions) ? body.positions : [];
      store.positions = clean(arr).slice(0, MAX_POSITIONS);
      await writeStore(store.positions);
      return json({ positions: store.positions });
    }
    default:
      return json({ error: 'Unknown action' }, 400);
  }
}

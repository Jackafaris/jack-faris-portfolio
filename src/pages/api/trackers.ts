// Daily market trackers: two records — the S&P 500 (^GSPC) and Jack's stock.
// A cronjob (4 PM CT weekdays) appends the day's close via action 'update'.
// Values are stored as the series of closes; the API returns the computed
// daily change (% vs previous close) and total change (% vs base point).
//
// GET  /api/trackers            -> { version, tracks: Tracker[] }
// POST /api/trackers            -> { code, action, ... }   (401 if code wrong)
//   action 'add'         : { symbol?, name?, basePrice?, baseDate? }
//                           - symbol '^GSPC' seeds/ensures the S&P track
//                           - otherwise (re)sets Jack's stock track
//   action 'remove'      : { symbol }
//   action 'update'      : {}  (cron: append today's close for all tracks)
//   action 'rebaseline'  : { symbol, date }  (change the "as of" start point)
//
// Storage: same Vercel Blob store as picks.json, in trackers.json.

import { get, put, type BlobAccessType } from '@vercel/blob';
import { getPrice, sanitizeSymbol } from './stock-price';

export interface TrackerPoint {
  date: string; // YYYY-MM-DD
  close: number;
}

export interface Tracker {
  symbol: string;
  name: string;
  base: TrackerPoint; // the "as of" starting point
  history: TrackerPoint[]; // includes base, ascending by date
}

export interface TrackersBody {
  version: 1;
  tracks: Tracker[];
  updatedAt: string;
}

interface WriteBody {
  code?: string;
  action?: string;
  symbol?: string;
  name?: string;
  date?: string;
}

const BLOB_PATH = 'trackers.json';
const BLOB_ACCESS = 'public' as BlobAccessType;
const BLOB_STORE_ID =
  process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN?.split('_')[3] || '';
const BLOB_PUBLIC_BASE = BLOB_STORE_ID
  ? `https://${BLOB_STORE_ID}.public.blob.vercel-storage.com`
  : null;

const EMPTY: TrackersBody = { version: 1, tracks: [], updatedAt: '' };

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

function parseBody(raw: string): TrackersBody {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Partial<TrackersBody>;
      const tracks = Array.isArray(p.tracks)
        ? p.tracks
            .map(normalizeTrack)
            .filter((t): t is Tracker => t !== null)
        : [];
      return { version: 1, tracks, updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '' };
    }
  } catch {
    /* malformed body -> empty */
  }
  return { ...EMPTY };
}

function normalizeTrack(raw: unknown): Tracker | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const symbol = String(r.symbol ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-^]{1,12}$/.test(symbol)) return null;
  const history = Array.isArray(r.history)
    ? (r.history as unknown[])
        .map(normalizePoint)
        .filter((p): p is TrackerPoint => p !== null)
    : [];
  history.sort((a, b) => (a.date < b.date ? -1 : 1));
  const baseIn = normalizePoint(r.base);
  const base = baseIn && history.some((p) => p.date === baseIn.date)
    ? baseIn
    : history[0] ?? null;
  if (!base) return null;
  return { symbol, name: String(r.name ?? symbol), base, history };
}

function normalizePoint(raw: unknown): TrackerPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const date = String(r.date ?? '').trim();
  const close = Number(r.close);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!Number.isFinite(close) || close <= 0) return null;
  return { date, close };
}

async function readStore(): Promise<TrackersBody> {
  try {
    const result = await get(BLOB_PATH, { access: BLOB_ACCESS, useCache: false });
    if (result && result.statusCode === 200 && result.stream) {
      return parseBody(await new Response(result.stream).text());
    }
  } catch {
    /* not created yet / SDK auth issue -> fall through */
  }
  try {
    if (BLOB_PUBLIC_BASE) {
      const res = await fetch(`${BLOB_PUBLIC_BASE}/${BLOB_PATH}?t=${Date.now()}`, {
        cache: 'no-store',
      });
      if (res.status === 404 || !res.ok) return { ...EMPTY };
      return parseBody(await res.text());
    }
  } catch {
    /* ignore */
  }
  return { ...EMPTY };
}

async function writeStore(tracks: Tracker[]): Promise<void> {
  const body: TrackersBody = { version: 1, tracks, updatedAt: new Date().toISOString() };
  await put(BLOB_PATH, JSON.stringify(body, null, 2), {
    access: BLOB_ACCESS,
    contentType: 'application/json',
    allowOverwrite: true,
    cacheControlMaxAge: 60,
  });
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function pointPct(prev: TrackerPoint, cur: TrackerPoint): number {
  return (cur.close / prev.close - 1) * 100;
}

function trackSummary(t: Tracker) {
  const last = t.history[t.history.length - 1];
  const prev = t.history.length > 1 ? t.history[t.history.length - 2] : null;
  return {
    symbol: t.symbol,
    name: t.name,
    base: t.base,
    last,
    dailyPct: prev ? pointPct(prev, last) : 0,
    totalPct: pointPct(t.base, last),
  };
}

async function getTrack(symbol: string, name: string): Promise<Tracker> {
  // Base point = the most recent close (today on trading days; the prior close
  // on weekends/holidays). History grows from here as the daily record lands.
  const from = isoDate(Date.now() - 5 * 86400000);
  const data = await getPrice(symbol, from);
  const last = data.history[data.history.length - 1] ?? { date: from, close: data.price };
  return { symbol, name: data.name || name, base: { ...last }, history: [{ ...last }] };
}

export async function GET(): Promise<Response> {
  const store = await readStore();
  return json({ ...store, summary: store.tracks.map(trackSummary) });
}

export async function POST({ request }: { request: Request }): Promise<Response> {
  let body: WriteBody;
  try {
    body = (await request.json()) as WriteBody;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!codeValid(body?.code)) return json({ error: 'Unauthorized' }, 401);

  const { action } = body;
  if (action === 'auth') return json({ ok: true });

  const store = await readStore();

  if (action === 'add') {
    const sym = sanitizeSymbol(body.symbol);
    if (!sym) return json({ error: 'Invalid symbol' }, 400);
    const name = String(body.name ?? '').slice(0, 60);
    // Re-adding a symbol re-bases it to the latest close.
    store.tracks = store.tracks.filter((t) => t.symbol !== sym);
    const track = await getTrack(sym, name || sym);
    store.tracks.push(track);
    await writeStore(store.tracks);
    return json({ ...store, summary: store.tracks.map(trackSummary) });
  }

  if (action === 'remove') {
    const sym = sanitizeSymbol(body.symbol);
    if (!sym) return json({ error: 'Invalid symbol' }, 400);
    store.tracks = store.tracks.filter((t) => t.symbol !== sym);
    await writeStore(store.tracks);
    return json({ ...store, summary: store.tracks.map(trackSummary) });
  }

  if (action === 'rebaseline') {
    const sym = sanitizeSymbol(body.symbol);
    const date = String(body.date ?? '').trim();
    if (!sym) return json({ error: 'Invalid symbol' }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'Invalid date' }, 400);
    const t = store.tracks.find((x) => x.symbol === sym);
    if (!t) return json({ error: `No tracker for ${sym}` }, 404);
    const idx = t.history.findIndex((p) => p.date >= date);
    if (idx < 0) return json({ error: 'Date is after the last recorded close' }, 400);
    t.base = t.history[idx];
    t.history = t.history.slice(idx);
    await writeStore(store.tracks);
    return json({ ...store, summary: store.tracks.map(trackSummary) });
  }

  if (action === 'update') {
    // Daily record (cron at 4 PM CT, after the 4 PM ET close). Append every
    // close newer than the last recorded point — idempotent per day, and it
    // backfills missed days if the cron was down.
    const today = isoDate(Date.now());
    for (const t of store.tracks) {
      if (!t.history.length) continue;
      const data = await getPrice(t.symbol, t.base.date);
      const lastDate = t.history[t.history.length - 1].date;
      for (const p of data.history) {
        if (p.date > lastDate && p.date <= today) {
          t.history.push({ date: p.date, close: p.close });
        }
      }
      t.history.sort((a, b) => (a.date < b.date ? -1 : 1));
      if (!t.history.some((p) => p.date === t.base.date)) t.base = t.history[0];
    }
    await writeStore(store.tracks);
    return json({ ...store, summary: store.tracks.map(trackSummary) });
  }

  return json({ error: 'Unknown action' }, 400);
}

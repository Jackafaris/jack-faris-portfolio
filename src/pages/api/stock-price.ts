// Serverless proxy for stock prices.
// Yahoo Finance blocks browser CORS, so the /investing page fetches through this
// route. We authenticate to Yahoo the way its own clients do (a cookie + crumb
// session) and retry across multiple hosts with backoff, because Yahoo
// aggressively rate-limits bare datacenter requests.
//
// GET /api/stock-price?symbol=AAPL[&from=YYYY-MM-DD]

export interface PricePoint {
  date: string;
  close: number;
}

export interface StockPriceData {
  symbol: string;
  name: string;
  currency: string;
  price: number;
  dayChangePct: number | null;
  marketTime: number;
  history: PricePoint[];
  /** True when served from cache after an upstream failure */
  stale?: boolean;
}

export interface StockPriceError {
  error: string;
  stale?: boolean;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'] as const;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const STALE_TTL_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MIN_DAYS = 30;
const MAX_DAYS = 1500; // ~4 years
const DEFAULT_DAYS = 180;
const DAY_MS = 86400000;

const jsonHeaders = {
  'content-type': 'application/json',
  'cache-control': 'public, max-age=300, s-maxage=300',
};

function json(body: StockPriceData | StockPriceError, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

// --- per-function-instance cache (survives across invocations on warm instances) ---
const cache = new Map<string, { at: number; data: StockPriceData }>();

// --- Yahoo session (cookie + crumb) ---
const session: { cookies: string[]; crumb: string | null; ts: number } = {
  cookies: [],
  crumb: null,
  ts: 0,
};

function cookieHeader(): string {
  return session.cookies.map((c) => c.split(';')[0]).join('; ');
}

function addCookies(res: Response): void {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const kv = c.split(';')[0];
    if (!kv) continue;
    // replace same-named cookie
    const name = kv.split('=')[0];
    session.cookies = session.cookies.filter((x) => x.split('=')[0] !== name);
    session.cookies.push(kv);
  }
}

function cookieHeaders(): Record<string, string> {
  return cookieHeader() ? { Cookie: cookieHeader() } : {};
}

/** Get a crumb from one host; returns it or null. */
async function crumbFrom(host: string): Promise<string | null> {
  const r = await fetch(`https://${host}/v1/test/getcrumb`, {
    headers: { 'User-Agent': UA, ...cookieHeaders() },
  });
  if (!r.ok) return null;
  const crumb = (await r.text()).trim();
  return crumb.length > 0 && crumb.length < 60 && !crumb.startsWith('<') ? crumb : null;
}

async function freshSession(): Promise<void> {
  const now = Date.now();
  if (session.crumb && now - session.ts < SESSION_TTL_MS && session.cookies.length) return;
  // Ping fc.yahoo.com — it responds 404 but SETS the A3 cookie (that is normal).
  try {
    const warm = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
    });
    addCookies(warm);
    await warm.text();
  } catch {
    /* ignore — fall through to chart; a cookie-less request still sometimes works */
  }
  for (const host of HOSTS) {
    try {
      const crumb = await crumbFrom(host);
      if (crumb) {
        session.crumb = crumb;
        session.ts = now;
        return;
      }
    } catch {
      /* try next host */
    }
  }
  session.ts = now; // avoid re-doing the whole handshake every request
}

interface YahooChartBody {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        regularMarketChangePercent?: number;
        regularMarketTime?: number;
        shortName?: string;
        longName?: string;
        currency?: string;
      };
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: { knownsymbol?: string };
  };
}

async function fetchYahoo(symbol: string, start: number, end: number): Promise<YahooChartBody> {
  const base = {
    'User-Agent': UA,
    Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt === 0 || (attempt === 3 && !session.crumb)) await freshSession();
    const host = HOSTS[attempt % HOSTS.length];
    const crumb = session.crumb ? `&crumb=${encodeURIComponent(session.crumb)}` : '';
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${Math.floor(start / 1000)}&period2=${Math.floor(end / 1000)}&interval=1d${crumb}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { headers: { ...base, ...cookieHeaders() }, signal: ctrl.signal });
      clearTimeout(timer);
      addCookies(res);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Yahoo responded HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 1200 + attempt * 1800));
        continue;
      }
      if (!res.ok) throw new Error(`Yahoo responded HTTP ${res.status}`);
      return (await res.json()) as YahooChartBody;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (/HTTP 4\d\d/.test(lastErr.message) && !lastErr.message.includes('429')) throw lastErr;
      await new Promise((r) => setTimeout(r, 1000 + attempt * 1000));
    }
  }
  throw lastErr ?? new Error('Yahoo rate limited (HTTP 429) — try again in a minute');
}

export function sanitizeSymbol(raw: string | null | undefined): string | null {
  let s = (raw ?? '').trim().toUpperCase();
  if (s.startsWith('IB:')) s = s.slice(3);
  if (!s || s.length > 12) return null;
  if (!/[\w.\-^]/.test(s) || !/^[\w.\-^]+$/.test(s)) return null;
  return s;
}

function parseDateISO(s: string | null): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function rangeFrom(from: Date | null, now: number): { days: number; start: number } {
  let days = DEFAULT_DAYS;
  if (from) days = Math.min(Math.max(Math.round((now - from.getTime()) / DAY_MS), MIN_DAYS), MAX_DAYS);
  return { days, start: now - days * DAY_MS };
}

function historyFrom(body: YahooChartBody, ts: number[]): PricePoint[] {
  const closes = body.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  const history: PricePoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) continue;
    history.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      close: Math.round(c * 10000) / 10000,
    });
  }
  return history;
}

export async function getPrice(symbol: string, from: string | null): Promise<StockPriceData> {
  const now = Date.now();
  const { days, start } = rangeFrom(parseDateISO(from), now);
  const end = now + 20 * DAY_MS; // timezone buffer
  const key = `${symbol}:${days}:${Math.floor(start / 3600000)}`;

  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.data;

  let body: YahooChartBody;
  try {
    body = await fetchYahoo(symbol, start, end);
  } catch (e) {
    // Serve a stale cached value if one exists, even past TTL, on upstream failure.
    const stale = cache.get(symbol);
    if (stale && now - stale.at < STALE_TTL_MS) return { ...stale.data, stale: true };
    throw e;
  }

  const result = body.chart?.result?.[0];
  const meta = result?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!result || !Number.isFinite(price)) {
    const known = body.chart?.error?.knownsymbol;
    throw new Error(
      known
        ? `"${symbol}" was not found. Did you mean ${known}?`
        : `No price data for "${symbol}"`,
    );
  }

  const history = historyFrom(body, result.timestamp ?? []);
  if (!history.length) throw new Error(`No history for "${symbol}"`);

  const data: StockPriceData = {
    symbol,
    name: meta?.shortName || meta?.longName || symbol,
    currency: meta?.currency || 'USD',
    price,
    dayChangePct: Number.isFinite(meta?.regularMarketChangePercent)
      ? (meta?.regularMarketChangePercent as number)
      : null,
    marketTime: Number.isFinite(meta?.regularMarketTime)
      ? (meta?.regularMarketTime as number)
      : Math.floor(now / 1000),
    history,
  };
  cache.set(key, { at: now, data });
  cache.set(symbol, { at: now, data }); // stale-fallback slot
  return data;
}

export async function GET({ url }: { url: URL }): Promise<Response> {
  const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
  if (!symbol) return json({ error: 'Invalid symbol' }, 400);
  try {
    return json(await getPrice(symbol, url.searchParams.get('from')));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes('not found') || msg.includes('No price') || msg.includes('No history') ? 404 : 502;
    return json({ error: status === 502 ? `Could not reach price source: ${msg}` : msg }, status);
  }
}

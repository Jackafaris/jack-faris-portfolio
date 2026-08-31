// Serverless proxy for stock prices.
// Yahoo Finance blocks browser CORS, so the /investing page fetches through this
// route. We authenticate to Yahoo the way its own clients do (a cookie + crumb
// session) and retry across multiple hosts with backoff, because Yahoo
// aggressively rate-limits bare datacenter requests.
//
// GET /api/stock-price?symbol=AAPL[&from=YYYY-MM-DD]

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const MIN_DAYS = 30;
const MAX_DAYS = 1500; // ~4 years
const DEFAULT_DAYS = 180;

const cache = new Map(); // key -> { at, data }
const jsonHeaders = {
  'content-type': 'application/json',
  'cache-control': 'public, max-age=300, s-maxage=300',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: jsonHeaders });
}

function sanitizeSymbol(raw) {
  let s = String(raw || '').trim().toUpperCase();
  if (s.startsWith('IB:')) s = s.slice(3);
  if (!s || s.length > 12) return null;
  if (!/^[\w.\-^]+$/.test(s)) return null;
  return s;
}

function parseDateISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

// --- Yahoo session (cookie + crumb) ---
const session = { cookies: [], crumb: null, ts: 0 };
const SESSION_TTL_MS = 10 * 60 * 1000;

function cookieHeader() {
  return session.cookies.map((c) => c.split(';')[0]).join('; ');
}
function addCookies(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const kv = c.split(';')[0];
    if (!kv) continue;
    // replace same-named cookie
    const name = kv.split('=')[0];
    session.cookies = session.cookies.filter((x) => x.split('=')[0] !== name);
    session.cookies.push(kv);
  }
}

async function freshSession() {
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
  // Get the crumb.
  for (const host of HOSTS) {
    try {
      const r = await fetch(`https://${host}/v1/test/getcrumb`, {
        headers: { 'User-Agent': UA, ...(cookieHeader() ? { Cookie: cookieHeader() } : {}) },
      });
      if (r.ok) {
        session.crumb = (await r.text()).trim();
        if (session.crumb && session.crumb.length < 60 && !session.crumb.startsWith('<')) {
          session.ts = now;
          return;
        }
        session.crumb = null;
      }
    } catch {
      /* try next host */
    }
  }
  session.ts = now; // avoid re-doing the whole handshake every request
}

async function fetchYahoo(symbol, start, end) {
  const p1 = Math.floor(start / 1000);
  const p2 = Math.floor(end / 1000);
  const base = {
    'User-Agent': UA,
    Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt === 0 || (attempt === 3 && !session.crumb)) await freshSession();
    const host = HOSTS[attempt % HOSTS.length];
    const crumb = session.crumb ? `&crumb=${encodeURIComponent(session.crumb)}` : '';
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d${crumb}`;
    const headers = { ...base, ...(cookieHeader() ? { Cookie: cookieHeader() } : {}) };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      addCookies(res);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Yahoo responded HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 1200 + attempt * 1800));
        continue;
      }
      if (!res.ok) throw new Error(`Yahoo responded HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const msg = String(e.message || e);
      if (/HTTP 4\d\d/.test(msg) && !msg.includes('429')) throw lastErr;
      await new Promise((r) => setTimeout(r, 1000 + attempt * 1000));
    }
  }
  throw lastErr || new Error('Yahoo rate limited (HTTP 429) — try again in a minute');
}

export async function GET({ url }) {
  const symbol = sanitizeSymbol(url.searchParams.get('symbol'));
  if (!symbol) return json({ error: 'Invalid symbol' }, 400);

  const now = Date.now();
  const from = parseDateISO(url.searchParams.get('from'));
  let days = DEFAULT_DAYS;
  if (from) {
    days = Math.min(Math.max(Math.round((now - from.getTime()) / 86400000), MIN_DAYS), MAX_DAYS);
  }
  const start = now - days * 86400000;
  const end = now + 20 * 86400000; // timezone buffer
  const key = `${symbol}:${days}:${Math.floor(start / 3600000)}`;

  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return json(hit.data);

  let body;
  try {
    body = await fetchYahoo(symbol, start, end);
  } catch (e) {
    // Serve a stale cached value if one exists, even past TTL, on upstream failure.
    const stale = cache.get(`${symbol}`);
    if (stale && now - stale.at < 60 * 60 * 1000) return json({ ...stale.data, stale: true });
    return json({ error: `Could not reach price source: ${String(e.message || e)}` }, 502);
  }

  const result = body?.chart?.result?.[0];
  const meta = result?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!result || !Number.isFinite(price)) {
    const known = body?.chart?.error?.knownsymbol;
    return json(
      {
        error: known
          ? `"${symbol}" was not found. Did you mean ${known.knownsymbol}?`
          : `No price data for "${symbol}"`,
      },
      404
    );
  }

  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const history = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) continue;
    history.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      close: Math.round(c * 10000) / 10000,
    });
  }
  if (!history.length) return json({ error: `No history for "${symbol}"` }, 404);

  const data = {
    symbol,
    name: meta?.shortName || meta?.longName || symbol,
    currency: meta?.currency || 'USD',
    price,
    dayChangePct: Number.isFinite(meta?.regularMarketChangePercent)
      ? meta.regularMarketChangePercent
      : null,
    marketTime: Number.isFinite(meta?.regularMarketTime)
      ? meta.regularMarketTime
      : Math.floor(now / 1000),
    history,
  };
  cache.set(key, { at: now, data });
  cache.set(symbol, { at: now, data }); // stale-fallback slot
  return json(data);
}

// Pure math for the market trackers (no DOM). Testable.

import type { Tracker, TrackerPoint } from './types';

export function pct(prev: number, cur: number): number {
  return (cur / prev - 1) * 100;
}

/** % change of the last close vs the previous close. 0 for a single-point series. */
export function dailyPct(history: TrackerPoint[]): number {
  if (history.length < 2) return 0;
  return pct(history[history.length - 2].close, history[history.length - 1].close);
}

/** % change of the last close vs the base point. */
export function totalPct(t: Tracker): number {
  const last = t.history[t.history.length - 1];
  if (!last || t.base.close <= 0) return 0;
  return pct(t.base.close, last.close);
}

/** Signed, one-decimal percent string, e.g. "+2.4%" / "-5.0%" / "0.0%". */
export function fmtSignedPct(n: number): string {
  const sign = n > 0 ? '+' : '';
  return sign + n.toFixed(1) + '%';
}

/** Up/down/flat for CSS coloring. */
export function direction(n: number): 'up' | 'down' | 'flat' {
  if (n > 0.05) return 'up';
  if (n < -0.05) return 'down';
  return 'flat';
}

/** US dollar value, 2 decimals. */
export function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Short date label, e.g. "Sep 1, 2026". */
export function fmtDate(iso: string): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Pure math for the board: percentage changes and portfolio summary.

import type { Lines, Position, PricePoint } from './types';

export interface Summary {
  cost: number;
  value: number;
  /** Number of positions with a live price */
  ok: number;
  /** value - cost, or null when no position has a live price */
  gain: number | null;
}

/**
 * % change of a price history from the first point on/after `dateStr`
 * to the last point. Null when the history is empty or starts after the date.
 */
export function pctSince(history: PricePoint[], dateStr: string): number | null {
  if (!history.length || !dateStr) return null;
  const idx = history.findIndex((h) => h.date >= dateStr);
  if (idx < 0) return null;
  const base = history[idx].close;
  const last = history[history.length - 1].close;
  return (last / base - 1) * 100;
}

export function summaryData(positions: Position[], lines: Lines): Summary {
  let cost = 0;
  let value = 0;
  let ok = 0;
  for (const p of positions) {
    const line = lines.get(p.symbol);
    cost += p.price * p.shares;
    const cur = line?.data ? line.data.price : null;
    if (cur !== null && Number.isFinite(cur)) {
      value += cur * p.shares;
      ok++;
    }
  }
  return { cost, value, ok, gain: ok ? value - cost : null };
}

/** Earliest buy date across the board (ISO string), or null when empty. */
export function earliestBuyDate(positions: Position[]): string | null {
  if (!positions.length) return null;
  return [...positions].sort((a, b) => (a.date < b.date ? -1 : 1))[0].date;
}

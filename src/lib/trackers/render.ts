// Pure HTML builders for the tracker cards. No DOM access.

import { direction, fmtDate, fmtSignedPct, fmtUsd, totalPct } from './compute';
import { esc } from '../investing/format';
import type { Tracker } from './types';

const dirClass: Record<'up' | 'down' | 'flat', string> = {
  up: 'up',
  down: 'down',
  flat: 'flat',
};

export function trackerCardHtml(t: Tracker): string {
  const tot = totalPct(t);
  const d = direction(tot);
  const last = t.history[t.history.length - 1];
  const hasData = last !== undefined;
  const delta = hasData ? `<span class="trk-delta ${dirClass[d]}">${fmtSignedPct(tot)}</span>` : '';
  const price = hasData ? fmtUsd(last.close) : '—';
  const since = fmtDate(t.base.date);
  const updated = hasData ? fmtDate(last.date) : '—';
  const empty = t.history.length === 0 || !hasData;
  return `<div class="trk-card ${empty ? 'empty' : ''}" data-tracker="${esc(t.symbol)}">
      <div class="trk-head">
        <span class="trk-name">${esc(t.name)}</span>
        <span class="trk-sym">${esc(t.symbol)}</span>
      </div>
      <div class="trk-main">
        <div class="trk-price">${price}</div>
        <div class="trk-badge">${delta}<span class="trk-since"> since ${since}</span></div>
      </div>
      <canvas class="trk-spark" data-spark="${esc(t.symbol)}"></canvas>
      <div class="trk-foot">
        <span>Base: <b>${esc(fmtDate(t.base.date))}</b> @ ${hasData ? fmtUsd(t.base.close) : '—'}</span>
        <span>Updated: <b>${updated}</b></span>
      </div>
    </div>`;
}

export function emptyTrackCardHtml(kind: 'sp' | 'stock'): string {
  const label = kind === 'sp' ? 'S&amp;P 500' : 'Your stock';
  const sub =
    kind === 'sp'
      ? 'The market benchmark will appear here once recorded.'
      : 'Add a ticker in owner mode to start tracking it.';
  return `<div class="trk-card empty" data-tracker="${kind === 'sp' ? 'none' : 'none'}">
      <div class="trk-head"><span class="trk-name">${label}</span><span class="trk-sym">—</span></div>
      <div class="trk-main"><div class="trk-price muted">No data yet</div></div>
      <canvas class="trk-spark"></canvas>
      <div class="trk-foot"><span>${sub}</span></div>
    </div>`;
}

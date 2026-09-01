// Pure HTML builders for the board's summary chips, legend and table rows.
// No DOM access — everything returns strings the page assigns to innerHTML.

import { esc, fmtDate, fmtPct, usd0, usd2 } from './format';
import { earliestBuyDate, pctSince, summaryData } from './maths';
import type { Lines, Position, PriceData, PricePoint } from './types';

const muted = (t: string): string => `<span class="muted">${t}</span>`;
const chip = (inner: string): string => `<span class="sum-chip">${inner}</span>`;

export interface SummaryArgs {
  positions: Position[];
  lines: Lines;
  bench: PriceData | null;
  benchError: string;
  benchLabel: string;
}

export function summaryHtml({ positions, lines, bench, benchError, benchLabel }: SummaryArgs): string {
  const s = summaryData(positions, lines);
  const chips: string[] = [];
  if (positions.length) {
    chips.push(chip(`Tracked: <b>${s.ok}/${positions.length}</b> priced`));
    if (s.gain !== null) {
      const cls = s.gain >= 0 ? 'pos' : 'neg';
      chips.push(
        chip(
          `P&amp;L: <b class="${cls}">${s.gain >= 0 ? '+' : ''}${usd2(s.gain)}</b> ` +
            `<span class="muted">(${usd0(s.cost)} invested)</span>`,
        ),
      );
    }
    if (bench) {
      const pct = pctSince(bench.history, earliestBuyDate(positions) ?? '');
      if (pct !== null) {
        const cls = pct >= 0 ? 'pos' : 'neg';
        chips.push(chip(`${esc(benchLabel)} since first buy: <b class="${cls}">${fmtPct(pct)}</b>`));
      }
    }
  }
  if (benchError) chips.push(`<span class="sum-chip warn">Benchmark data unavailable — check back shortly</span>`);
  return chips.join('');
}

export interface LegendArgs {
  bench: PriceData | null;
  fallbackLabel: string;
  positions: Position[];
  lines: Lines;
  showLines: boolean;
}

export function legendHtml({ bench, fallbackLabel, positions, lines, showLines }: LegendArgs): string {
  const items: string[] = [];
  if (bench) items.push(`<span class="legend-item"><i class="swatch bench"></i> ${esc(bench.name || fallbackLabel)}</span>`);
  if (showLines) {
    for (const p of positions) {
      const line = lines.get(p.symbol);
      if (!line) continue;
      items.push(
        `<span class="legend-item"><i class="swatch" style="background:${line.color}"></i> ${esc(p.symbol)} (bought ${fmtDate(p.date)})</span>`,
      );
    }
  }
  return items.join('');
}

export interface TableArgs {
  positions: Position[];
  bench: PriceData | null;
  lines: Lines;
  isOwner: boolean;
}

export function tableRowsHtml({ positions, bench, lines, isOwner }: TableArgs): string {
  const benchHist: PricePoint[] = bench ? bench.history : [];
  return positions.map((p) => rowHtml(p, lines.get(p.symbol), benchHist, isOwner)).join('');
}

function pctCell(pct: number | null, fallback: string): string {
  if (pct === null) return muted(fallback);
  return `<b class="${pct >= 0 ? 'pos' : 'neg'}">${fmtPct(pct)}</b>`;
}

function diffCell(pPct: number | null, bPct: number | null): string {
  if (pPct === null || bPct === null) return muted('—');
  const d = pPct - bPct;
  return `<b class="${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? '+' : ''}${d.toFixed(1)}pp</b>`;
}

function pickCell(line: { error: string; data: PriceData | null } | undefined, pPct: number | null): string {
  if (!line) return muted('…');
  if (line.error && !line.data) return `<span class="neg">${esc(line.error)}</span>`;
  return pctCell(pPct, 'n/a');
}

function rowHtml(p: Position, line: { error: string; data: PriceData | null } | undefined, benchHist: PricePoint[], isOwner: boolean): string {
  const hasError = !!line && !!line.error && !line.data;
  const cur = line?.data ? line.data.price : null;
  const hist = line?.data ? line.data.history : [];
  const pPct = !hasError && hist.length ? pctSince(hist, p.date) : null;
  const bPct = pctSince(benchHist, p.date);
  const valueCell = cur === null ? muted('—') : usd0(cur * p.shares);
  const dayChange = line?.data?.dayChangePct;
  const dayNote = dayChange !== null && dayChange !== undefined ? ` (${dayChange >= 0 ? '+' : ''}${dayChange.toFixed(1)}% today)` : '';
  const delCell = isOwner
    ? `<button class="icon-btn del-btn" data-del="${esc(p.id)}" title="Remove ${esc(p.symbol)}" aria-label="Remove ${esc(p.symbol)}">×</button>`
    : '';
  return `<tr>
        <td class="tick"><b>${esc(p.symbol)}</b>${p.name && p.name !== p.symbol ? `<span class="muted"> · ${esc(p.name)}</span>` : ''}${p.note ? `<span class="note" title="${esc(p.note)}">📝</span>` : ''}</td>
        <td>${fmtDate(p.date)}</td>
        <td>${usd2(p.price)}</td>
        <td>${cur === null ? muted('—') : usd2(cur)}${line?.data ? dayNote : ''}</td>
        <td>${p.shares}</td>
        <td>${valueCell}</td>
        <td>${pickCell(line, pPct)}</td>
        <td>${pctCell(bPct, '—')}</td>
        <td>${diffCell(pPct, bPct)}</td>
        <td class="row-actions">${delCell}</td>
      </tr>`;
}

// Board orchestrator: holds the picks state, loads prices, and renders the
// summary / table / legend / chart. DOM references come in via deps so the
// page script stays a thin wiring layer.

import { ApiError, fetchPrice, picksAction, picksGet } from './api';
import { buildSeries, drawChart } from './chart';
import { esc, fmtDate, usd2 } from './format';
import { earliestBuyDate } from './maths';
import { legendHtml, summaryHtml, tableRowsHtml } from './rows';
import type { LineEntry, Lines, PicksBody, Position, PriceData } from './types';

export interface BoardDeps {
  positionsBody: HTMLElement;
  emptyEl: HTMLElement;
  tableEl: HTMLElement;
  summaryEl: HTMLElement;
  canvas: HTMLCanvasElement;
  legendEl: HTMLElement;
  compareSelect: HTMLSelectElement;
  toggleLines: HTMLInputElement;
  priceUpdatedEl: HTMLElement;
  ownerPanel: HTMLElement;
  ownerLock: HTMLElement;
  boardTitle: HTMLElement;
  ownerStatusEl: HTMLElement;
  confirm: (msg: string) => boolean;
}

export const PALETTE = [
  '#00a699', '#2f6fed', '#e8590c', '#9c36b5', '#0ca678',
  '#d6336c', '#1098ad', '#f59f00', '#5f3dc4', '#c2255c',
];

export class Board {
  positions: Position[] = [];
  ownerCode = '';
  bench: PriceData | null = null;
  benchKey = '';
  benchError = '';
  positionLines: Lines = new Map();
  private deps: BoardDeps;

  constructor(deps: BoardDeps) {
    this.deps = deps;
  }

  get isOwner(): boolean {
    return this.ownerCode.length > 0;
  }

  api(action: 'auth' | 'add' | 'remove' | 'clear' | 'replace', extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return picksAction(action, { code: this.ownerCode, ...extra });
  }

  setOwnerStatus(kind: string, msg: string): void {
    this.deps.ownerStatusEl.className = 'invest-status ' + kind;
    this.deps.ownerStatusEl.textContent = msg;
  }

  applyMode(): void {
    const { ownerPanel, ownerLock, boardTitle } = this.deps;
    ownerPanel.classList.toggle('hidden', !this.isOwner);
    ownerLock.classList.toggle('hidden', this.isOwner);
    boardTitle.textContent = this.isOwner ? "Jack's picks (editing)" : "Jack's picks";
    this.renderAll();
  }

  async loadPositions(): Promise<void> {
    const body = await picksGet();
    this.positions = Array.isArray(body.positions) ? body.positions : [];
  }

  async loadBenchmark(): Promise<void> {
    const key = this.deps.compareSelect.value;
    if (key === this.benchKey && this.bench) {
      this.renderAll();
      return;
    }
    this.benchKey = key;
    this.benchError = '';
    this.bench = null;
    this.renderAll();
    try {
      this.bench = await fetchPrice(key, earliestBuyDate(this.positions));
    } catch (e) {
      this.benchError = e instanceof Error ? e.message : String(e);
    }
    this.renderAll();
  }

  async loadPositionLines(): Promise<void> {
    const symbols = [...new Set(this.positions.map((p) => p.symbol))].sort();
    for (const p of this.positions) {
      const color = PALETTE[symbols.indexOf(p.symbol) % PALETTE.length];
      const existing = this.positionLines.get(p.symbol);
      if (existing) {
        existing.color = color;
        continue;
      }
      const entry: LineEntry = { color, data: null, error: '' };
      this.positionLines.set(p.symbol, entry);
      const firstBuy = this.firstBuyFor(p.symbol);
      const from = this.daysAgoIso(firstBuy.date, 45);
      try {
        entry.data = await fetchPrice(p.symbol, from);
      } catch (e) {
        entry.error = e instanceof Error ? e.message : String(e);
      }
      this.renderAll();
    }
    for (const sym of [...this.positionLines.keys()]) {
      if (!symbols.includes(sym)) this.positionLines.delete(sym);
    }
  }

  private firstBuyFor(symbol: string): Position {
    return this.positions
      .filter((p) => p.symbol === symbol)
      .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  }

  private daysAgoIso(iso: string, days: number): string {
    const start = new Date(iso + 'T00:00:00Z');
    start.setUTCDate(start.getUTCDate() - days);
    return start.toISOString().slice(0, 10);
  }

  renderAll(): void {
    const { compareSelect, toggleLines } = this.deps;
    this.deps.summaryEl.innerHTML = summaryHtml({
      positions: this.positions,
      lines: this.positionLines,
      bench: this.bench,
      benchError: this.benchError,
      benchLabel: compareSelect.options[compareSelect.selectedIndex]?.text ?? '',
    });
    this.deps.emptyEl.classList.toggle('hidden', this.positions.length > 0);
    this.deps.tableEl.classList.toggle('hidden', this.positions.length === 0);
    this.deps.positionsBody.innerHTML = tableRowsHtml({
      positions: this.positions,
      bench: this.bench,
      lines: this.positionLines,
      isOwner: this.isOwner,
    });
    this.deps.legendEl.innerHTML = legendHtml({
      bench: this.bench,
      fallbackLabel: this.benchKey,
      positions: this.positions,
      lines: this.positionLines,
      showLines: toggleLines.checked,
    });
    drawChart(this.deps.canvas, buildSeries(this.positions, this.positionLines, this.bench, toggleLines.checked), this.positions.length > 0);
    this.deps.priceUpdatedEl.textContent =
      this.bench && this.bench.marketTime
        ? `Prices from Yahoo Finance · benchmark ${esc(this.bench.name)} as of ${fmtDate(new Date(this.bench.marketTime * 1000).toISOString().slice(0, 10))}`
        : '';
  }

  async refreshAll(): Promise<void> {
    await this.loadPositions();
    await Promise.all([this.loadPositionLines(), this.loadBenchmark()]);
  }

  /** True when the live price deviates by more than 90% from the typed one. */
  priceMismatchesTyped(typed: number, live: number): boolean {
    return live > 0 && Math.abs(live - typed) / live > 0.9;
  }

  async addPick(input: { symbol: string; name: string; price: number; date: string; shares: number; note: string }): Promise<Position | null> {
    let { name } = input;
    let live: number | null = null;
    try {
      const data = await fetchPrice(input.symbol);
      live = data.price;
      if (!name) name = data.name || '';
    } catch (e) {
      throw new Error(`Couldn't verify "${input.symbol}": ${e instanceof Error ? e.message : String(e)}`);
    }
    if (this.priceMismatchesTyped(input.price, live) &&
        !this.deps.confirm(`${input.symbol} last traded at ${usd2(live)}, but you entered ${usd2(input.price)}.\n\nOK = save as typed. Cancel = go back and fix it.`)) {
      return null;
    }
    const body = await this.api('add', { position: { ...input, name } });
    this.positions = body.positions as Position[];
    this.renderAll();
    await Promise.all([this.loadPositionLines(), this.loadBenchmark()]);
    return input as Position;
  }

  async removePick(id: string): Promise<void> {
    const p = this.positions.find((x) => x.id === id);
    if (!p) return;
    if (!this.deps.confirm(`Remove ${p.symbol} (bought ${fmtDate(p.date)} @ ${usd2(p.price)})?`)) return;
    const body = await this.api('remove', { id });
    this.positions = body.positions as Position[];
    this.renderAll();
    await Promise.all([this.loadPositionLines(), this.loadBenchmark()]);
  }

  async replaceBoard(list: Position[]): Promise<void> {
    if (!this.deps.confirm(`Import ${list.length} pick(s) and REPLACE the whole board?`)) return;
    const body = await this.api('replace', { positions: list });
    this.positions = body.positions as Position[];
    await Promise.all([this.loadPositionLines(), this.loadBenchmark()]);
  }

  async clearBoard(): Promise<void> {
    if (!this.positions.length) return;
    if (!this.deps.confirm('Clear ALL picks from the board? (Export first if you want a backup.)')) return;
    const body = await this.api('clear', {});
    this.positions = body.positions as Position[];
    this.positionLines.clear();
    this.renderAll();
    await this.loadBenchmark();
  }

  /** Re-verify a persisted owner code; returns false (and clears it) if stale. */
  async reverifyOwnerCode(): Promise<boolean> {
    if (!this.isOwner) return false;
    try {
      await picksAction('auth', { code: this.ownerCode });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        this.ownerCode = '';
        this.applyMode();
      }
      return false;
    }
  }
}

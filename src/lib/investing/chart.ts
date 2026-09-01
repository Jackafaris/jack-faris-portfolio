// Performance chart: pure data builders + small canvas drawing functions.
// The page passes state in; nothing here touches the DOM except the 2d context.

import { fmtDate } from './format';
import type { Lines, Position, PriceData } from './types';

export const GRID_COLOR = 'rgba(0,0,0,0.06)';
export const LABEL_COLOR = 'rgba(0,0,0,0.45)';
export const ZERO_COLOR = 'rgba(0,0,0,0.25)';
export const BENCH_COLOR = '#00a699';

export interface SeriesPoint {
  date: string;
  val: number;
}

export interface Series {
  name: string;
  color: string;
  width: number;
  points: SeriesPoint[];
}

export interface Scales {
  dates: string[];
  dateIndex: Map<string, number>;
  min: number;
  max: number;
}

/** 0%-indexed series: benchmark + each position (from its buy date). */
export function buildSeries(positions: Position[], lines: Lines, bench: PriceData | null, showLines: boolean): Series[] {
  const series: Series[] = [];
  if (bench && bench.history.length > 1) series.push(indexedSeries('Benchmark', BENCH_COLOR, 2.5, bench.history));
  if (showLines) for (const p of positions) {
    const line = lines.get(p.symbol);
    if (!line?.data || line.data.history.length < 2) continue;
    series.push(indexedSeries(p.symbol, line.color, 1.8, line.data.history, p.date));
  }
  return series;
}

function indexedSeries(name: string, color: string, width: number, history: { date: string; close: number }[], fromDate?: string): Series {
  const idx = history.findIndex((h) => h.date >= (fromDate ?? history[0].date));
  const pts = history.slice(idx < 0 ? 0 : idx);
  const base = pts[0].close;
  return { name, color, width, points: pts.map((pt) => ({ date: pt.date, val: (pt.close / base - 1) * 100 })) };
}

export function computeScales(series: Series[]): Scales {
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) for (const p of s.points) { min = Math.min(min, p.val); max = Math.max(max, p.val); }
  if (min > max) { min = 0; max = 0; }
  const span = Math.max(max - min, 4);
  return { dates, dateIndex, min: min - span * 0.08, max: max + span * 0.08 };
}

export interface DrawOpts {
  x: (d: string) => number;
  y: (v: number) => number;
  padL: number;
  padR: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  gridSteps: number;
  xSteps: number;
}

function drawGrid(ctx: CanvasRenderingContext2D, o: DrawOpts, s: Scales): void {
  ctx.font = '11px DM Sans, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= o.gridSteps; i++) {
    const v = s.min + (i / o.gridSteps) * (s.max - s.min);
    const y = o.y(v);
    ctx.strokeStyle = GRID_COLOR;
    ctx.beginPath();
    ctx.moveTo(o.padL, y);
    ctx.lineTo(o.width - o.padR, y);
    ctx.stroke();
    ctx.fillStyle = LABEL_COLOR;
    ctx.fillText((v > 0 ? '+' : '') + v.toFixed(0) + '%', o.padL - 8, y);
  }
}

function drawZeroLine(ctx: CanvasRenderingContext2D, o: DrawOpts, s: Scales): void {
  if (!(s.min < 0 && s.max > 0)) return;
  const y0 = o.y(0);
  ctx.strokeStyle = ZERO_COLOR;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(o.padL, y0);
  ctx.lineTo(o.width - o.padR, y0);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawXLabels(ctx: CanvasRenderingContext2D, o: DrawOpts, s: Scales): void {
  ctx.fillStyle = LABEL_COLOR;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= o.xSteps; i++) {
    const d = s.dates[Math.round((i / o.xSteps) * (s.dates.length - 1))];
    ctx.fillText(fmtDate(d), o.x(d), o.bottom + 8);
  }
}

function drawLines(ctx: CanvasRenderingContext2D, o: DrawOpts, series: Series[]): void {
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (const p of s.points) {
      const x = o.x(p.date);
      const y = o.y(p.val);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
    const end = s.points[s.points.length - 1];
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(o.x(end.date), o.y(end.val), 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFootnote(ctx: CanvasRenderingContext2D, o: DrawOpts): void {
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '10px DM Sans, sans-serif';
  ctx.fillText('Index: 0% = value on the earliest date shown. Position lines start at their buy date.', o.padL, o.height - 4);
}

export function drawEmptyState(ctx: CanvasRenderingContext2D, w: number, h: number, hasPositions: boolean): void {
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.font = '14px DM Sans, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(hasPositions ? 'Fetching prices…' : 'No picks on the board yet', w / 2, h / 2);
}

export function drawChart(canvas: HTMLCanvasElement, series: Series[], hasPositions: boolean): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 800;
  const h = 360;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!series.length) {
    drawEmptyState(ctx, w, h, hasPositions);
    return;
  }

  const s = computeScales(series);
  const pad = { l: 64, r: 16, t: 16, b: 34 };
  const plotW = w - pad.l - pad.r;
  const xOf = (d: string): number => pad.l + (s.dates.length < 2 ? 0 : (s.dateIndex.get(d) ?? 0) / (s.dates.length - 1) * plotW);
  const yOf = (v: number): number => pad.t + (1 - (v - s.min) / (s.max - s.min)) * (h - pad.t - pad.b);
  const opts: DrawOpts = {
    x: xOf, y: yOf, padL: pad.l, padR: pad.r, top: pad.t, bottom: h - pad.b,
    width: w, height: h, gridSteps: 5, xSteps: Math.min(6, s.dates.length - 1),
  };
  drawGrid(ctx, opts, s);
  drawZeroLine(ctx, opts, s);
  drawXLabels(ctx, opts, s);
  drawLines(ctx, opts, series);
  drawFootnote(ctx, opts);
}

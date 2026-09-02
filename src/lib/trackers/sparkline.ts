// Small inline canvas sparkline for a tracker's close series.
// Pure drawing — the page hands over the canvas + points.

import type { TrackerPoint } from './types';

const W = 220;
const H = 56;
const PAD = 4;

function niceColor(up: boolean, flat: boolean): string {
  if (flat) return '#9a9a93';
  return up ? '#00a699' : '#e04b3a';
}

export function drawSparkline(canvas: HTMLCanvasElement, points: TrackerPoint[], up: boolean, flat: boolean): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  if (points.length < 2) {
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.font = '11px DM Sans, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('collecting closes…', W / 2, H / 2);
    return;
  }

  const closes = points.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = Math.max(max - min, 1e-9);
  const color = niceColor(up, flat);

  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);

  // area fill
  ctx.beginPath();
  ctx.moveTo(x(0), H - PAD);
  points.forEach((p, i) => ctx.lineTo(x(i), y(p.close)));
  ctx.lineTo(x(points.length - 1), H - PAD);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, color + '33');
  grad.addColorStop(1, color + '00');
  ctx.fillStyle = grad;
  ctx.fill();

  // line
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i), y(p.close)) : ctx.lineTo(x(i), y(p.close))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // last point
  const li = points.length - 1;
  ctx.beginPath();
  ctx.arc(x(li), y(points[li].close), 2.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// Client-side wrappers around the same-origin price + picks APIs.

import { errMsg } from './format';
import type { PicksBody, PriceData } from './types';

export type PicksAction = 'get' | 'auth' | 'add' | 'remove' | 'clear' | 'replace';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(String(body.error ?? `HTTP ${res.status}`), res.status);
  return body as T;
}

export function picksGet(): Promise<PicksBody> {
  return request<PicksBody>('/api/picks');
}

export interface PickExtra {
  code?: string;
  id?: string;
  position?: unknown;
  positions?: unknown[];
}

export function picksAction(action: PicksAction, extra: PickExtra): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>('/api/picks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
}

/** Fetch a price + history for a symbol, optionally from a given YYYY-MM-DD. */
export function fetchPrice(symbol: string, from?: string | null): Promise<PriceData> {
  const q = new URLSearchParams({ symbol });
  if (from) q.set('from', from);
  return request<PriceData>('/api/stock-price?' + q.toString()).catch((e) => {
    throw e instanceof Error ? e : new Error(errMsg(e));
  });
}

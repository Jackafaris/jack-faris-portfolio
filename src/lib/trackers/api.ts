// Client-side wrapper around /api/trackers.

import { errMsg } from '../investing/format';
import type { TrackersBody } from './types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch('/api/trackers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(String(parsed.error ?? `HTTP ${res.status}`), res.status);
  return parsed;
}

export function trackersGet(): Promise<TrackersBody> {
  return fetch('/api/trackers')
    .then((r) => r.json() as Promise<TrackersBody>)
    .catch((e) => {
      throw e instanceof Error ? e : new Error(errMsg(e));
    });
}

export function trackersPost(action: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return post({ action, ...extra });
}

export function trackersAuth(code: string): Promise<Record<string, unknown>> {
  return post({ action: 'auth', code });
}

import { config } from '../config.js';

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string
  ) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<{ data: T; response: Response; elapsedMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const started = performance.now();

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'wordpress-mcp/1.0',
        ...(init.headers || {})
      }
    });

    const elapsedMs = Math.round(performance.now() - started);
    const text = await response.text();

    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status} ${response.statusText}`, response.status, text.slice(0, 1500));
    }

    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new Error(`Expected JSON but received a non-JSON response from ${url}`);
    }

    return { data, response, elapsedMs };
  } finally {
    clearTimeout(timer);
  }
}

export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

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
      redirect: 'follow',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
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
      const contentType = response.headers.get('content-type') || 'unknown';
      const preview = text.replace(/\s+/g, ' ').slice(0, 220);
      throw new Error(`Expected JSON but received non-JSON from ${url} (content-type: ${contentType}; preview: ${preview})`);
    }

    return { data, response, elapsedMs };
  } finally {
    clearTimeout(timer);
  }
}

export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

import { config, hasWpAuth, hasWooAuth } from '../config.js';
import { basicAuth, fetchJson } from './http.js';

export type WpRequestOptions = {
  auth?: boolean;
};

export function wpApiUrl(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${config.wpBaseUrl}/wp-json${normalized}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function wpGet<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}, options: WpRequestOptions = {}) {
  const headers: Record<string, string> = {};
  if (options.auth && hasWpAuth) {
    headers.Authorization = basicAuth(config.wpUsername, config.wpAppPassword);
  }
  return fetchJson<T>(wpApiUrl(path, params), { headers });
}

export async function wooGet<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}) {
  if (!hasWooAuth) {
    throw new Error('WooCommerce credentials are not configured. Set WC_CONSUMER_KEY and WC_CONSUMER_SECRET with a read-only REST API key.');
  }

  const headers = {
    Authorization: basicAuth(config.wcConsumerKey, config.wcConsumerSecret)
  };
  return fetchJson<T>(wpApiUrl(`/wc/v3/${path.replace(/^\//, '')}`, params), { headers });
}

export function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

export function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }]
  };
}

export function normalizeComparableUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = '';
    const pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
    return `${url.origin.toLowerCase()}${pathname}${url.search}`;
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase();
  }
}

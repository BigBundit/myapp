import { config, hasWpAuth, hasWooAuth } from '../config.js';
import { basicAuth, fetchJson } from './http.js';

export type WpRequestOptions = {
  auth?: boolean;
};

function addParams(url: URL, params: Record<string, string | number | boolean | undefined>) {
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
}

export function wpApiUrl(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${config.wpBaseUrl}/wp-json${normalized}`);
  addParams(url, params);
  return url.toString();
}

export function wpRestRouteUrl(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(config.wpBaseUrl);
  url.searchParams.set('rest_route', normalized);
  addParams(url, params);
  return url.toString();
}

export async function wpGet<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}, options: WpRequestOptions = {}) {
  const headers: Record<string, string> = {};
  if (options.auth && hasWpAuth) {
    headers.Authorization = basicAuth(config.wpUsername, config.wpAppPassword);
  }

  const primary = wpApiUrl(path, params);
  try {
    return await fetchJson<T>(primary, { headers });
  } catch (primaryError) {
    const fallback = wpRestRouteUrl(path, params);
    try {
      return await fetchJson<T>(fallback, { headers });
    } catch (fallbackError) {
      const a = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const b = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`WordPress REST API failed using both routes. /wp-json error: ${a} | ?rest_route= error: ${b}`);
    }
  }
}

export async function wooGet<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}) {
  if (!hasWooAuth) {
    throw new Error('WooCommerce credentials are not configured. Set WC_CONSUMER_KEY and WC_CONSUMER_SECRET with a read-only REST API key.');
  }

  const headers = {
    Authorization: basicAuth(config.wcConsumerKey, config.wcConsumerSecret)
  };

  const route = `/wc/v3/${path.replace(/^\//, '')}`;
  const primary = wpApiUrl(route, params);
  try {
    return await fetchJson<T>(primary, { headers });
  } catch (primaryError) {
    const fallback = wpRestRouteUrl(route, params);
    try {
      return await fetchJson<T>(fallback, { headers });
    } catch (fallbackError) {
      const a = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const b = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`WooCommerce REST API failed using both routes. /wp-json error: ${a} | ?rest_route= error: ${b}`);
    }
  }
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

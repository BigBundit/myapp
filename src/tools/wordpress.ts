import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { config, hasWpAuth, hasWooAuth, hasUrlFinderToken } from '../config.js';
import { errorResult, normalizeComparableUrl, stripHtml, textResult, wooGet, wpGet } from '../lib/wp.js';

const PostType = z.enum(['page', 'post', 'any']);

type UrlFinderResponse = {
  ok: boolean;
  targetUrl: string;
  count: number;
  elapsedMs?: number;
  matches: Array<Record<string, unknown>>;
};

export function registerWordPressTools(server: McpServer) {
  server.registerTool(
    'search_pages',
    {
      description: 'Search public WordPress pages/posts by keyword and return IDs, titles, URLs and object types. Read-only.',
      inputSchema: z.object({
        query: z.string().min(1),
        postType: PostType.default('any'),
        perPage: z.number().int().min(1).max(100).default(20)
      })
    },
    async ({ query, postType, perPage }) => {
      try {
        const { data } = await wpGet<any[]>('/wp/v2/search', {
          search: query,
          per_page: perPage,
          subtype: postType === 'any' ? 'any' : postType,
          _fields: 'id,title,url,type,subtype'
        });
        return textResult({ query, count: data.length, results: data });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'get_page',
    {
      description: 'Fetch one WordPress page or post by numeric ID. Read-only.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        postType: z.enum(['page', 'post']).default('page'),
        includeHtml: z.boolean().default(false)
      })
    },
    async ({ id, postType, includeHtml }) => {
      try {
        const endpoint = postType === 'page' ? '/wp/v2/pages' : '/wp/v2/posts';
        const { data } = await wpGet<any>(`${endpoint}/${id}`, {
          context: 'view',
          _fields: 'id,date,modified,slug,status,link,title,excerpt,content'
        }, { auth: hasWpAuth });

        const html = data?.content?.rendered ?? '';
        const result: Record<string, unknown> = {
          id: data.id,
          postType,
          status: data.status,
          slug: data.slug,
          url: data.link,
          title: stripHtml(data?.title?.rendered ?? ''),
          excerpt: stripHtml(data?.excerpt?.rendered ?? ''),
          contentText: stripHtml(html),
          modified: data.modified
        };
        if (includeHtml) result.contentHtml = html;
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'find_url_usage',
    {
      description: 'Find which published WordPress content references a target URL. Uses the BNH URL Finder database endpoint when installed, including Elementor/postmeta; otherwise performs a lightweight REST search. Read-only.',
      inputSchema: z.object({
        targetUrl: z.string().min(1),
        postTypes: z.array(z.enum(['page', 'post'])).min(1).default(['page', 'post'])
      })
    },
    async ({ targetUrl, postTypes }) => {
      try {
        if (hasUrlFinderToken) {
          try {
            const { data } = await wpGet<UrlFinderResponse>(
              '/bnh-mcp/v1/find-url',
              { url: targetUrl },
              { headers: { 'x-bnh-mcp-token': config.urlFinderToken } }
            );

            return textResult({
              ...data,
              mode: 'database_url_finder',
              searched: ['post_content', 'postmeta'],
              note: 'Exact read-only database lookup via the BNH MCP URL Finder WordPress plugin.'
            });
          } catch (pluginError) {
            // Fall through to lightweight public REST lookup while the plugin is not installed/active.
            const fallback = await lightweightUrlLookup(targetUrl, postTypes);
            return textResult({
              ...fallback,
              mode: 'lightweight_rest_fallback',
              pluginConfigured: true,
              pluginError: pluginError instanceof Error ? pluginError.message : String(pluginError),
              note: 'Install/activate BNH MCP URL Finder for reliable Elementor/postmeta URL lookup without full-site REST scanning.'
            });
          }
        }

        const fallback = await lightweightUrlLookup(targetUrl, postTypes);
        return textResult({
          ...fallback,
          mode: 'lightweight_rest_fallback',
          pluginConfigured: false,
          note: 'BNH MCP URL Finder is not configured. This fallback checks only WordPress REST-searchable rendered content, not all postmeta/Elementor data.'
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'get_products',
    {
      description: 'Search WooCommerce products. Requires a read-only WooCommerce REST API key. Read-only.',
      inputSchema: z.object({
        search: z.string().optional(),
        minPrice: z.number().nonnegative().optional(),
        maxPrice: z.number().nonnegative().optional(),
        status: z.enum(['publish', 'draft', 'pending', 'private', 'any']).default('publish'),
        perPage: z.number().int().min(1).max(100).default(20)
      })
    },
    async ({ search, minPrice, maxPrice, status, perPage }) => {
      try {
        const { data } = await wooGet<any[]>('products', {
          search,
          min_price: minPrice,
          max_price: maxPrice,
          status,
          per_page: perPage
        });

        return textResult({
          count: data.length,
          products: data.map((p) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            permalink: p.permalink,
            status: p.status,
            type: p.type,
            sku: p.sku,
            price: p.price,
            regularPrice: p.regular_price,
            salePrice: p.sale_price,
            onSale: p.on_sale,
            stockStatus: p.stock_status,
            categories: Array.isArray(p.categories) ? p.categories.map((c: any) => c.name) : [],
            modified: p.date_modified
          }))
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'check_site_status',
    {
      description: 'Check WordPress REST API and optional WooCommerce/URL-finder configuration. Read-only.',
      inputSchema: z.object({})
    },
    async () => {
      try {
        const root = await wpGet<any>('/');
        let wpCore: Record<string, unknown> = { ok: false };
        let woo: Record<string, unknown> = { configured: hasWooAuth, ok: false };
        let urlFinder: Record<string, unknown> = { configured: hasUrlFinderToken, ok: false };

        try {
          const pages = await wpGet<any[]>('/wp/v2/pages', { per_page: 1, _fields: 'id' }, { auth: hasWpAuth });
          wpCore = { ok: true, responseMs: pages.elapsedMs };
        } catch (error) {
          wpCore = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }

        if (hasWooAuth) {
          try {
            const products = await wooGet<any[]>('products', { per_page: 1, _fields: 'id' });
            woo = { configured: true, ok: true, responseMs: products.elapsedMs };
          } catch (error) {
            woo = { configured: true, ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }

        if (hasUrlFinderToken) {
          try {
            const ping = await wpGet<any>('/bnh-mcp/v1/ping');
            urlFinder = { configured: true, ok: Boolean(ping.data?.ok), responseMs: ping.elapsedMs, version: ping.data?.version };
          } catch (error) {
            urlFinder = { configured: true, ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }

        return textResult({
          site: {
            name: root.data?.name,
            description: root.data?.description,
            home: root.data?.home,
            url: root.data?.url
          },
          restApi: { ok: true, responseMs: root.elapsedMs },
          wordpress: wpCore,
          woocommerce: woo,
          urlFinder,
          auth: {
            wordpressApplicationPasswordConfigured: hasWpAuth,
            wooReadOnlyKeyConfigured: hasWooAuth,
            urlFinderTokenConfigured: hasUrlFinderToken
          }
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}

async function lightweightUrlLookup(targetUrl: string, postTypes: Array<'page' | 'post'>) {
  const needle = normalizeComparableUrl(targetUrl);
  const searchTerm = extractSearchTerm(targetUrl);
  const matches: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  const results = await Promise.all(
    postTypes.map(async (postType) => {
      const endpoint = postType === 'page' ? '/wp/v2/pages' : '/wp/v2/posts';
      const res = await wpGet<any[]>(endpoint, {
        search: searchTerm,
        per_page: 100,
        status: 'publish',
        _fields: 'id,slug,link,title,content,modified'
      }, { auth: hasWpAuth });
      return { postType, items: res.data };
    })
  );

  let checked = 0;
  for (const result of results) {
    for (const item of result.items) {
      checked += 1;
      const html = String(item?.content?.rendered ?? '').replace(/&amp;/g, '&').replace(/&#038;/g, '&');
      const directHit = html.includes(targetUrl);
      const normalizedHit = normalizeComparableUrlInText(html).includes(needle);
      if (!directHit && !normalizedHit) continue;

      const key = `${result.postType}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        id: item.id,
        postType: result.postType,
        title: stripHtml(item?.title?.rendered ?? ''),
        url: item.link,
        slug: item.slug,
        modified: item.modified
      });
    }
  }

  return { targetUrl, searchTerm, checked, count: matches.length, matches };
}

function extractSearchTerm(targetUrl: string): string {
  try {
    const url = new URL(targetUrl);
    const parts = decodeURIComponent(url.pathname)
      .split(/[^\p{L}\p{N}]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4);
    return parts.sort((a, b) => b.length - a.length)[0] || url.hostname.replace(/^www\./, '').split('.')[0] || targetUrl;
  } catch {
    return targetUrl;
  }
}

function normalizeComparableUrlInText(text: string): string {
  return text.replace(/https?:\/\/[^\s\"'<>]+/gi, (candidate) => normalizeComparableUrl(candidate));
}

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { config, hasWpAuth, hasWooAuth } from '../config.js';
import { errorResult, normalizeComparableUrl, stripHtml, textResult, wooGet, wpGet } from '../lib/wp.js';

const PostType = z.enum(['page', 'post', 'any']);

export function registerWordPressTools(server: McpServer) {
  server.registerTool(
    'search_pages',
    {
      description: 'Search public WordPress pages/posts by keyword and return IDs, titles, URLs and object types. Read-only.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Keyword or phrase to search for'),
        postType: PostType.default('any').describe('Limit to page, post, or any'),
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
      description: 'Fetch one WordPress page or post by numeric ID. Returns title, URL, slug, status, modified time, excerpt and content text. Read-only.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        postType: z.enum(['page', 'post']).default('page'),
        includeHtml: z.boolean().default(false).describe('Include rendered HTML content in addition to plain text')
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
      description: 'Find which public WordPress pages/posts contain a target URL. Uses a fast WordPress content search first, then a bounded parallel scan if needed. Read-only.',
      inputSchema: z.object({
        targetUrl: z.string().min(1),
        postTypes: z.array(z.enum(['page', 'post'])).min(1).default(['page', 'post']),
        maxPagesPerType: z.number().int().min(1).max(50).optional().describe('Fallback scan cap; each REST page contains up to 100 items. Default comes from FIND_URL_MAX_PAGES.'),
        concurrency: z.number().int().min(1).max(10).default(6).describe('Parallel requests used only during the fallback scan')
      })
    },
    async ({ targetUrl, postTypes, maxPagesPerType, concurrency }) => {
      try {
        const needle = normalizeComparableUrl(targetUrl);
        const searchTerm = extractSearchTerm(targetUrl);
        const matches: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        let searchedCandidates = 0;

        // Fast path: WordPress searches post_title/post_excerpt/post_content server-side.
        // We then verify the exact URL against only those candidates.
        const fastResults = await Promise.all(
          postTypes.map(async (postType) => {
            const endpoint = postType === 'page' ? '/wp/v2/pages' : '/wp/v2/posts';
            try {
              const res = await wpGet<any[]>(endpoint, {
                search: searchTerm,
                per_page: 100,
                status: 'publish',
                _fields: 'id,slug,link,title,content,modified'
              }, { auth: hasWpAuth });
              return { postType, items: res.data };
            } catch {
              return { postType, items: [] as any[] };
            }
          })
        );

        for (const result of fastResults) {
          for (const item of result.items) {
            searchedCandidates += 1;
            addMatchIfPresent(item, result.postType, targetUrl, needle, matches, seen);
          }
        }

        if (matches.length > 0) {
          return textResult({
            targetUrl,
            searchTerm,
            mode: 'fast_content_search',
            searchedCandidates,
            scanned: searchedCandidates,
            count: matches.length,
            truncated: false,
            matches
          });
        }

        // Fallback: fetch page 1 for metadata, then scan remaining REST pages in parallel.
        const maxPages = Math.min(maxPagesPerType ?? config.findUrlMaxPages, 50);
        let scanned = 0;
        let truncated = false;
        const scanSummaries: Array<Record<string, unknown>> = [];

        for (const postType of postTypes) {
          const endpoint = postType === 'page' ? '/wp/v2/pages' : '/wp/v2/posts';
          const first = await wpGet<any[]>(endpoint, {
            per_page: 100,
            page: 1,
            status: 'publish',
            _fields: 'id,slug,link,title,content,modified'
          }, { auth: hasWpAuth });

          const totalPages = Math.max(1, Number.parseInt(first.response.headers.get('x-wp-totalpages') || '1', 10));
          const pagesToScan = Math.min(totalPages, maxPages);
          if (totalPages > pagesToScan) truncated = true;

          for (const item of first.data) {
            scanned += 1;
            addMatchIfPresent(item, postType, targetUrl, needle, matches, seen);
          }

          const remainingPages = Array.from({ length: Math.max(0, pagesToScan - 1) }, (_, i) => i + 2);
          const batches = chunk(remainingPages, concurrency);

          for (const batch of batches) {
            const responses = await Promise.all(
              batch.map((page) => wpGet<any[]>(endpoint, {
                per_page: 100,
                page,
                status: 'publish',
                _fields: 'id,slug,link,title,content,modified'
              }, { auth: hasWpAuth }))
            );

            for (const response of responses) {
              for (const item of response.data) {
                scanned += 1;
                addMatchIfPresent(item, postType, targetUrl, needle, matches, seen);
              }
            }
          }

          scanSummaries.push({ postType, totalPages, pagesScanned: pagesToScan });
        }

        return textResult({
          targetUrl,
          searchTerm,
          mode: 'parallel_fallback_scan',
          searchedCandidates,
          scanned,
          count: matches.length,
          truncated,
          scanSummaries,
          matches,
          note: truncated
            ? 'Fallback scan hit the configured page limit. Increase maxPagesPerType only if a deeper scan is required.'
            : undefined
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'get_products',
    {
      description: 'Search WooCommerce products using the WooCommerce REST API. Requires read-only consumer key/secret. Read-only.',
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

        const products = data.map((p) => ({
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
        }));

        return textResult({ count: products.length, products });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'check_site_status',
    {
      description: 'Check WordPress REST API availability and basic WooCommerce API availability/configuration. Does not modify the site.',
      inputSchema: z.object({})
    },
    async () => {
      try {
        const root = await wpGet<any>('/');
        let wpCore: Record<string, unknown> = { ok: false };
        let woo: Record<string, unknown> = { configured: hasWooAuth, ok: false };

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
          auth: {
            wordpressApplicationPasswordConfigured: hasWpAuth,
            wooReadOnlyKeyConfigured: hasWooAuth
          },
          namespaces: Array.isArray(root.data?.namespaces) ? root.data.namespaces : []
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}

function addMatchIfPresent(
  item: any,
  postType: 'page' | 'post',
  targetUrl: string,
  needle: string,
  matches: Array<Record<string, unknown>>,
  seen: Set<string>
) {
  const html = String(item?.content?.rendered ?? '');
  const normalizedHtml = html
    .replace(/&amp;/g, '&')
    .replace(/&#038;/g, '&');

  const directHit = normalizedHtml.includes(targetUrl);
  const normalizedHit = normalizeComparableUrlInText(normalizedHtml).includes(needle);
  if (!directHit && !normalizedHit) return;

  const key = `${postType}:${item.id}`;
  if (seen.has(key)) return;
  seen.add(key);

  matches.push({
    id: item.id,
    postType,
    title: stripHtml(item?.title?.rendered ?? ''),
    url: item.link,
    slug: item.slug,
    modified: item.modified
  });
}

function extractSearchTerm(targetUrl: string): string {
  try {
    const url = new URL(targetUrl);
    const parts = decodeURIComponent(url.pathname)
      .split(/[^\p{L}\p{N}]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4);

    if (parts.length > 0) {
      return parts.sort((a, b) => b.length - a.length)[0];
    }

    return url.hostname.replace(/^www\./, '').split('.')[0] || targetUrl;
  } catch {
    return targetUrl;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function normalizeComparableUrlInText(text: string): string {
  return text.replace(/https?:\/\/[^\s\"'<>]+/gi, (candidate) => normalizeComparableUrl(candidate));
}

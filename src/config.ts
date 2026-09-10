import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  wpBaseUrl: required('WP_BASE_URL').replace(/\/$/, ''),
  wpUsername: process.env.WP_USERNAME?.trim() || '',
  wpAppPassword: process.env.WP_APP_PASSWORD?.replace(/\s+/g, '') || '',
  wcConsumerKey: process.env.WC_CONSUMER_KEY?.trim() || '',
  wcConsumerSecret: process.env.WC_CONSUMER_SECRET?.trim() || '',
  port: intEnv('PORT', 3000),
  host: process.env.HOST?.trim() || '0.0.0.0',
  mcpBearerToken: process.env.MCP_BEARER_TOKEN?.trim() || '',
  requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 15_000),
  findUrlMaxPages: intEnv('FIND_URL_MAX_PAGES', 30)
};

export const hasWpAuth = Boolean(config.wpUsername && config.wpAppPassword);
export const hasWooAuth = Boolean(config.wcConsumerKey && config.wcConsumerSecret);

/**
 * Financial Modeling Prep (FMP) fallback for core market data.
 *
 * Used only when FMP_API_KEY is set and FINANCIAL_DATASETS_API_KEY is not.
 * Each adapter accepts the same endpoint + params the Financial Datasets
 * tools already send, and returns data in the Financial Datasets envelope
 * shape (e.g. `{ snapshot }`, `{ prices }`, `{ income_statements }`) so the
 * tools and formatters work unchanged.
 */
import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';

const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';

type Params = Record<string, string | number | string[] | undefined>;
type Rec = Record<string, unknown>;
type Adapter = (params: Params) => Promise<{ data: Rec; urls: string[] }>;

function isUsableKey(value: string | undefined): value is string {
  return !!value && !!value.trim() && !value.trim().startsWith('your-');
}

export function getFmpApiKey(): string {
  const key = process.env.FMP_API_KEY;
  return isUsableKey(key) ? key.trim() : '';
}

/** FMP is a fallback: Financial Datasets wins whenever its key is configured. */
export function shouldUseFmp(): boolean {
  return !isUsableKey(process.env.FINANCIAL_DATASETS_API_KEY) && !!getFmpApiKey();
}

/** GET an FMP endpoint. Returns the parsed body and a source URL with the key redacted. */
async function fmpFetch(path: string, params: Params): Promise<{ body: unknown; url: string }> {
  const url = new URL(`${FMP_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.append(key, String(value));
    }
  }
  const displayUrl = url.toString();
  url.searchParams.append('apikey', getFmpApiKey());

  let response: Response;
  try {
    response = await fetch(url.toString());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[FMP API] network error: ${path} — ${message}`);
    throw new Error(`[FMP API] request failed for ${path}: ${message}`);
  }

  const body = await response.json().catch(() => null);
  // FMP sometimes reports errors (bad key, plan limits) with a 200 and an "Error Message" body.
  const apiError = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Rec)['Error Message'] ?? (body as Rec).error
    : undefined;
  if (!response.ok || apiError || body === null) {
    const detail = apiError ? String(apiError) : `${response.status} ${response.statusText}`;
    logger.error(`[FMP API] error: ${path} — ${detail}`);
    throw new Error(`[FMP API] request failed: ${detail}`);
  }

  return { body, url: displayUrl };
}

async function fmpList(path: string, params: Params): Promise<{ rows: Rec[]; url: string }> {
  const { body, url } = await fmpFetch(path, params);
  return { rows: Array.isArray(body) ? (body as Rec[]) : [], url };
}

// ---------------------------------------------------------------------------
// Field mapping: FMP camelCase → Financial Datasets snake_case
// ---------------------------------------------------------------------------

/** FMP fields whose snake_case form differs from the Financial Datasets name. */
const FIELD_RENAMES: Record<string, string> = {
  symbol: 'ticker',
  date: 'report_period',
  reported_currency: 'currency',
  eps: 'earnings_per_share',
  eps_diluted: 'earnings_per_share_diluted',
  weighted_average_shs_out: 'weighted_average_shares',
  weighted_average_shs_out_dil: 'weighted_average_shares_diluted',
  research_and_development_expenses: 'research_and_development',
  operating_expenses: 'operating_expense',
  total_stockholders_equity: 'shareholders_equity',
  cash_and_cash_equivalents: 'cash_and_equivalents',
  gross_profit_margin: 'gross_margin',
  operating_profit_margin: 'operating_margin',
  net_profit_margin: 'net_margin',
  price_to_earnings_growth_ratio: 'peg_ratio',
  debt_to_equity_ratio: 'debt_to_equity',
  debt_to_assets_ratio: 'debt_to_assets',
  net_income_per_share: 'earnings_per_share',
  enterprise_value_multiple: 'enterprise_value_to_ebitda_ratio',
  ev_to_ebitda: 'enterprise_value_to_ebitda_ratio',
  ev_to_sales: 'enterprise_value_to_revenue_ratio',
  net_income_growth: 'earnings_growth',
  epsgrowth: 'earnings_per_share_growth',
  ebitdagrowth: 'ebitda_growth',
};

/** FMP metadata that adds tokens without analytical value. */
const DROPPED_FIELDS = new Set(['cik', 'link', 'final_link', 'accepted_date']);

function toSnakeCase(key: string): string {
  return key
    .replace(/TTM$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

export function mapFmpRow(row: Rec): Rec {
  const mapped: Rec = {};
  for (const [key, value] of Object.entries(row)) {
    const snake = toSnakeCase(key);
    if (DROPPED_FIELDS.has(snake)) continue;
    const name = FIELD_RENAMES[snake] ?? snake;
    // First writer wins so a direct field is never clobbered by a later alias.
    if (!(name in mapped)) mapped[name] = value;
  }
  // FMP splits fiscal year and period ("2024" + "Q1"/"FY"); FD exposes one label.
  if (row.fiscalYear && row.period) {
    mapped.fiscal_period = `${row.fiscalYear} ${row.period}`;
  }
  delete mapped.fiscal_year;
  return mapped;
}

// ---------------------------------------------------------------------------
// Financial statements
// ---------------------------------------------------------------------------

const STATEMENT_PATHS = {
  income_statements: 'income-statement',
  balance_sheets: 'balance-sheet-statement',
  cash_flow_statements: 'cash-flow-statement',
} as const;

type StatementKey = keyof typeof STATEMENT_PATHS;

const REPORT_PERIOD_FILTERS = ['report_period', 'report_period_gt', 'report_period_gte', 'report_period_lt', 'report_period_lte'] as const;

function hasReportPeriodFilter(params: Params): boolean {
  return REPORT_PERIOD_FILTERS.some((f) => params[f] !== undefined);
}

/** FMP has no server-side report-period filters, so apply FD's filters client-side. */
export function filterByReportPeriod(rows: Rec[], params: Params): Rec[] {
  return rows.filter((row) => {
    const rp = String(row.report_period ?? '');
    if (params.report_period !== undefined && rp !== params.report_period) return false;
    if (params.report_period_gt !== undefined && !(rp > String(params.report_period_gt))) return false;
    if (params.report_period_gte !== undefined && !(rp >= String(params.report_period_gte))) return false;
    if (params.report_period_lt !== undefined && !(rp < String(params.report_period_lt))) return false;
    if (params.report_period_lte !== undefined && !(rp <= String(params.report_period_lte))) return false;
    return true;
  });
}

function requestedLimit(params: Params, fallback = 4): number {
  const n = Number(params.limit);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Fetch enough history to satisfy date filters, then filter and trim to the requested limit. */
async function fetchPeriodRows(path: string, params: Params, period: string): Promise<{ rows: Rec[]; url: string }> {
  const limit = requestedLimit(params);
  const fetchLimit = hasReportPeriodFilter(params) ? Math.max(limit, 40) : limit;
  const { rows, url } = await fmpList(`/${path}`, { symbol: tickerOf(params), period, limit: fetchLimit });
  const filtered = filterByReportPeriod(rows.map(mapFmpRow), params);
  return { rows: filtered.slice(0, limit), url };
}

async function fetchStatement(key: StatementKey, params: Params): Promise<{ rows: Rec[]; url: string }> {
  const path = STATEMENT_PATHS[key];
  if (params.period === 'ttm') {
    const { rows, url } = await fmpList(`/${path}-ttm`, { symbol: tickerOf(params) });
    return { rows: rows.map(mapFmpRow).map((r) => ({ ...r, period: 'ttm' })), url };
  }
  return fetchPeriodRows(path, params, params.period === 'quarterly' ? 'quarter' : 'annual');
}

function statementAdapter(key: StatementKey): Adapter {
  return async (params) => {
    const { rows, url } = await fetchStatement(key, params);
    return { data: { [key]: rows }, urls: [url] };
  };
}

const allStatementsAdapter: Adapter = async (params) => {
  const keys = Object.keys(STATEMENT_PATHS) as StatementKey[];
  const results = await Promise.all(keys.map((k) => fetchStatement(k, params)));
  const financials: Rec = {};
  keys.forEach((k, i) => { financials[k] = results[i].rows; });
  return { data: { financials }, urls: results.map((r) => r.url) };
};

// ---------------------------------------------------------------------------
// Key ratios
// ---------------------------------------------------------------------------

const keyRatiosSnapshotAdapter: Adapter = async (params) => {
  const symbol = tickerOf(params);
  const [ratios, metrics, growth] = await Promise.all([
    fmpList('/ratios-ttm', { symbol }),
    fmpList('/key-metrics-ttm', { symbol }),
    fmpList('/financial-growth', { symbol, period: 'annual', limit: 1 }),
  ]);
  const growthRow = growth.rows[0] ? mapFmpRow(growth.rows[0]) : {};
  // Growth rows carry their own report_period/fiscal labels; keep only the rates.
  const growthRates = Object.fromEntries(Object.entries(growthRow).filter(([k]) => k.endsWith('growth')));
  const snapshot = {
    ...growthRates,
    ...(metrics.rows[0] ? mapFmpRow(metrics.rows[0]) : {}),
    ...(ratios.rows[0] ? mapFmpRow(ratios.rows[0]) : {}),
    ticker: symbol,
  };
  return { data: { snapshot }, urls: [ratios.url, metrics.url, growth.url] };
};

const historicalKeyRatiosAdapter: Adapter = async (params) => {
  // FMP has no historical TTM series; annual is the closest comparable cadence.
  const period = params.period === 'quarterly' ? 'quarter' : 'annual';
  const [ratios, metrics, growth] = await Promise.all([
    fetchPeriodRows('ratios', params, period),
    fetchPeriodRows('key-metrics', params, period),
    fetchPeriodRows('financial-growth', params, period),
  ]);
  const byPeriod = (rows: Rec[]) => new Map(rows.map((r) => [String(r.report_period), r]));
  const metricsByPeriod = byPeriod(metrics.rows);
  const growthByPeriod = byPeriod(growth.rows);
  const financial_metrics = ratios.rows.map((r) => ({
    ...growthByPeriod.get(String(r.report_period)),
    ...metricsByPeriod.get(String(r.report_period)),
    ...r,
  }));
  return { data: { financial_metrics }, urls: [ratios.url, metrics.url, growth.url] };
};

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

const priceSnapshotAdapter: Adapter = async (params) => {
  const { rows, url } = await fmpList('/quote', { symbol: tickerOf(params) });
  const q = rows[0] ?? {};
  const snapshot = {
    ticker: q.symbol ?? tickerOf(params),
    price: q.price,
    day_change: q.change,
    day_change_percent: q.changePercentage,
    open: q.open,
    high: q.dayHigh,
    low: q.dayLow,
    previous_close: q.previousClose,
    volume: q.volume,
    market_cap: q.marketCap,
    time: typeof q.timestamp === 'number' ? new Date(q.timestamp * 1000).toISOString() : undefined,
  };
  return { data: { snapshot }, urls: [url] };
};

interface PriceBar { time: string; open: number; high: number; low: number; close: number; volume: number }

function bucketKey(date: string, interval: string): string {
  if (interval === 'year') return date.slice(0, 4);
  if (interval === 'month') return date.slice(0, 7);
  if (interval === 'week') {
    // Bucket by the Monday that starts the week (UTC).
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return date;
}

/** FMP only serves daily bars; roll them up for week/month/year intervals. Input must be ascending. */
export function aggregateBars(bars: PriceBar[], interval: string): PriceBar[] {
  if (interval === 'day') return bars;
  const buckets = new Map<string, PriceBar>();
  for (const bar of bars) {
    const key = bucketKey(bar.time, interval);
    const agg = buckets.get(key);
    if (!agg) {
      buckets.set(key, { ...bar });
    } else {
      agg.high = Math.max(agg.high, bar.high);
      agg.low = Math.min(agg.low, bar.low);
      agg.close = bar.close;
      agg.volume += bar.volume;
    }
  }
  return [...buckets.values()];
}

const historicalPricesAdapter: Adapter = async (params) => {
  const { rows, url } = await fmpList('/historical-price-eod/full', {
    symbol: tickerOf(params),
    from: params.start_date as string | undefined,
    to: params.end_date as string | undefined,
  });
  const bars: PriceBar[] = rows
    .map((r) => ({
      time: String(r.date),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume) || 0,
    }))
    .sort((a, b) => a.time.localeCompare(b.time));
  const prices = aggregateBars(bars, String(params.interval ?? 'day'));
  return { data: { prices }, urls: [url] };
};

const tickersAdapter: Adapter = async () => {
  const { rows, url } = await fmpList('/stock-list', {});
  return { data: { tickers: rows.map((r) => r.symbol).filter(Boolean) }, urls: [url] };
};

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

const newsAdapter: Adapter = async (params) => {
  const ticker = params.ticker as string | undefined;
  const limit = requestedLimit(params, 5);
  const { rows, url } = ticker
    ? await fmpList('/news/stock', { symbols: ticker, limit })
    : await fmpList('/news/general-latest', { limit });
  const news = rows.slice(0, limit).map((r) => ({
    ticker: r.symbol ?? ticker,
    title: r.title,
    source: r.publisher ?? r.site,
    date: r.publishedDate,
    url: r.url,
  }));
  return { data: { news }, urls: [url] };
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function tickerOf(params: Params): string {
  return String(params.ticker ?? '').trim().toUpperCase();
}

/** Financial Datasets endpoint → FMP adapter. Endpoints not listed have no FMP equivalent. */
const FMP_ADAPTERS: Record<string, Adapter> = {
  '/prices/snapshot/': priceSnapshotAdapter,
  '/prices/': historicalPricesAdapter,
  '/prices/snapshot/tickers/': tickersAdapter,
  '/financials/income-statements/': statementAdapter('income_statements'),
  '/financials/balance-sheets/': statementAdapter('balance_sheets'),
  '/financials/cash-flow-statements/': statementAdapter('cash_flow_statements'),
  '/financials/': allStatementsAdapter,
  '/financial-metrics/snapshot/': keyRatiosSnapshotAdapter,
  '/financial-metrics/': historicalKeyRatiosAdapter,
  '/news': newsAdapter,
};

export function isFmpSupported(endpoint: string): boolean {
  return endpoint in FMP_ADAPTERS;
}

/** Serve a Financial Datasets-style request from FMP, with the same opt-in caching. */
export async function fmpGet(
  endpoint: string,
  params: Params,
  options?: { cacheable?: boolean; ttlMs?: number },
): Promise<{ data: Rec; url: string }> {
  const adapter = FMP_ADAPTERS[endpoint];
  if (!adapter) {
    throw new Error(
      `[FMP API] ${endpoint} is not available via Financial Modeling Prep. Set FINANCIAL_DATASETS_API_KEY to use this data.`,
    );
  }

  // Separate cache namespace so FMP and Financial Datasets payloads never mix.
  const cacheEndpoint = `/fmp${endpoint}`;
  if (options?.cacheable) {
    const cached = readCache(cacheEndpoint, params, options.ttlMs);
    if (cached) return cached;
  }

  const { data, urls } = await adapter(params);
  const url = urls[0] ?? FMP_BASE_URL;

  if (options?.cacheable) {
    writeCache(cacheEndpoint, params, data, url);
  }
  return { data, url };
}

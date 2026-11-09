import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { api } from './api.js';
import { aggregateBars, filterByReportPeriod, mapFmpRow, shouldUseFmp } from './fmp.js';

const originalFetch = globalThis.fetch;
const originalEnv = {
  fd: process.env.FINANCIAL_DATASETS_API_KEY,
  fmp: process.env.FMP_API_KEY,
};
let requestedUrls: string[] = [];
let responses: unknown[] = [];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  requestedUrls = [];
  responses = [];
  delete process.env.FINANCIAL_DATASETS_API_KEY;
  process.env.FMP_API_KEY = 'fmp-test-key';
  globalThis.fetch = (async (url: string | URL | Request) => {
    requestedUrls.push(String(url));
    if (responses.length === 0) throw new Error('test received more requests than stubbed responses');
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv('FINANCIAL_DATASETS_API_KEY', originalEnv.fd);
  restoreEnv('FMP_API_KEY', originalEnv.fmp);
});

describe('FMP routing', () => {
  test('is used only when FMP is set and Financial Datasets is not', () => {
    expect(shouldUseFmp()).toBe(true);
    process.env.FINANCIAL_DATASETS_API_KEY = 'fd-key';
    expect(shouldUseFmp()).toBe(false);
    delete process.env.FINANCIAL_DATASETS_API_KEY;
    process.env.FMP_API_KEY = 'your-fmp-api-key';
    expect(shouldUseFmp()).toBe(false);
  });

  test('price snapshot maps FMP quote into the FD snapshot shape and redacts the key', async () => {
    responses = [[{ symbol: 'AAPL', price: 200.5, change: 1.5, changePercentage: 0.75 }]];

    const { data, url } = await api.get('/prices/snapshot/', { ticker: 'AAPL' });

    const snapshot = data.snapshot as Record<string, unknown>;
    expect(snapshot.ticker).toBe('AAPL');
    expect(snapshot.price).toBe(200.5);
    expect(snapshot.day_change_percent).toBe(0.75);
    expect(requestedUrls[0]).toContain('apikey=fmp-test-key');
    expect(url).not.toContain('apikey');
  });

  test('income statements map to FD field names and use the quarter period', async () => {
    responses = [[{ date: '2024-09-28', symbol: 'AAPL', fiscalYear: '2024', period: 'Q4', revenue: 100, eps: 1.2, cik: '1' }]];

    const { data } = await api.get('/financials/income-statements/', { ticker: 'AAPL', period: 'quarterly', limit: 1 });

    const rows = data.income_statements as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ report_period: '2024-09-28', ticker: 'AAPL', revenue: 100, earnings_per_share: 1.2, fiscal_period: '2024 Q4' });
    expect('cik' in rows[0]).toBe(false);
    expect(requestedUrls[0]).toContain('period=quarter');
  });

  test('unsupported endpoints fail with a clear message', async () => {
    await expect(api.get('/insider-trades/', { ticker: 'AAPL' })).rejects.toThrow('not available via Financial Modeling Prep');
  });

  test('FMP error bodies returned with HTTP 200 are surfaced as errors', async () => {
    responses = [{ 'Error Message': 'Invalid API KEY.' }];
    await expect(api.get('/prices/snapshot/', { ticker: 'AAPL' })).rejects.toThrow('Invalid API KEY.');
  });
});

describe('FMP helpers', () => {
  test('mapFmpRow converts camelCase and TTM-suffixed keys', () => {
    const row = mapFmpRow({ priceToEarningsRatioTTM: 30, evToEBITDATTM: 20, grossProfitMarginTTM: 0.4 });
    expect(row).toEqual({ price_to_earnings_ratio: 30, enterprise_value_to_ebitda_ratio: 20, gross_margin: 0.4 });
  });

  test('filterByReportPeriod applies FD-style bounds', () => {
    const rows = [{ report_period: '2024-12-31' }, { report_period: '2023-12-31' }, { report_period: '2022-12-31' }];
    expect(filterByReportPeriod(rows, { report_period_gte: '2023-01-01', report_period_lt: '2024-12-31' })).toEqual([{ report_period: '2023-12-31' }]);
  });

  test('aggregateBars rolls daily bars into months', () => {
    const bars = [
      { time: '2024-01-02', open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { time: '2024-01-03', open: 11, high: 15, low: 10, close: 14, volume: 50 },
      { time: '2024-02-01', open: 14, high: 16, low: 13, close: 15, volume: 70 },
    ];
    expect(aggregateBars(bars, 'month')).toEqual([
      { time: '2024-01-02', open: 10, high: 15, low: 9, close: 14, volume: 150 },
      { time: '2024-02-01', open: 14, high: 16, low: 13, close: 15, volume: 70 },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script with no type declarations
import { checkSource, formatReport, isFailure, runAll } from '../scripts/source-health.mjs';

interface StubOptions {
  search?: () => Promise<string[]>;
  getRaw?: (id: string) => Promise<unknown>;
  accept?: (raw: unknown) => boolean;
  requiresApiKey?: string;
}

function stub(code: string, o: StubOptions = {}) {
  return {
    code,
    name: code,
    requiresApiKey: o.requiresApiKey,
    search: o.search ?? (async () => ['1', '2']),
    getRaw: o.getRaw ?? (async (id: string) => ({ id })),
    normalize: (raw: unknown) =>
      (o.accept ?? (() => true))(raw)
        ? { status: 'accepted', artwork: {} }
        : { status: 'rejected', rejection: {} },
  };
}

describe('checkSource', () => {
  it('passes a source that searches, fetches and accepts a record', async () => {
    const r = await checkSource(stub('met'), {}, {});
    expect(r.status).toBe('ok');
  });

  it('fails when the search throws, keeping the upstream status in the detail', async () => {
    const f = stub('met', {
      search: async () => {
        throw new Error('Met search failed: HTTP 410');
      },
    });
    const r = await checkSource(f, {}, {});
    expect(r.status).toBe('error');
    expect(r.detail).toContain('410');
  });

  it('fails an empty result, the silent failure federation tolerates', async () => {
    const r = await checkSource(stub('met', { search: async () => [] }), {}, {});
    expect(r.status).toBe('empty');
    expect(isFailure(r)).toBe(true);
  });

  it('fails when IDs come back but no record can be fetched (auth error)', async () => {
    const f = stub('getty', {
      getRaw: async () => {
        throw new Error('HTTP 401 Wrong Authorization Token');
      },
    });
    const r = await checkSource(f, {}, {});
    expect(r.status).toBe('unfetchable');
    expect(r.detail).toContain('401');
  });

  it('fails when records fetch but none passes the rights gate', async () => {
    const r = await checkSource(stub('x', { accept: () => false }), {}, {});
    expect(r.status).toBe('unaccepted');
  });

  it('keeps going past a rejected or unfetchable record to find an accepted one', async () => {
    const f = stub('x', {
      search: async () => ['bad', 'rejected', 'good'],
      getRaw: async (id: string) => {
        if (id === 'bad') throw new Error('boom');
        return { id };
      },
      accept: (raw) => (raw as { id: string }).id === 'good',
    });
    expect((await checkSource(f, {}, {})).status).toBe('ok');
  });

  it('fails a search that hangs past the timeout', async () => {
    const f = stub('slow', { search: () => new Promise(() => {}) });
    const r = await checkSource(f, { timeoutMs: 20 }, {});
    expect(r.status).toBe('error');
    expect(r.detail).toContain('timed out');
  });

  it('skips a key-gated source whose key is absent, and checks it when present', async () => {
    const f = stub('europeana', { requiresApiKey: 'EUROPEANA_API_KEY' });
    const skipped = await checkSource(f, {}, {});
    expect(skipped.status).toBe('skipped');
    expect(isFailure(skipped)).toBe(false);
    const checked = await checkSource(f, {}, { EUROPEANA_API_KEY: 'k' });
    expect(checked.status).toBe('ok');
  });
});

describe('runAll', () => {
  it('flags a registered source that /core does not export', async () => {
    const core = {
      FETCHER_REGISTRY: [{ code: 'met' }, { code: 'ghost' }],
      metFetcher: stub('met'),
    };
    const results = await runAll(core, {}, {});
    expect(results.map((r: { status: string }) => r.status)).toEqual(['ok', 'error']);
  });

  it('reports the failing count in the summary', async () => {
    const core = {
      FETCHER_REGISTRY: [{ code: 'met' }, { code: 'aic' }],
      metFetcher: stub('met', { search: async () => [] }),
      aicFetcher: stub('aic'),
    };
    const report = formatReport(await runAll(core, {}, {}));
    expect(report).toContain('1 of 2 sources healthy, 1 failing.');
    expect(report).toMatch(/FAIL\s+met/);
  });
});

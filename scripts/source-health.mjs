#!/usr/bin/env node
// Live health check for every source the engine ships.
//
// Federated search deliberately tolerates a failing source, so a retired or
// re-keyed upstream endpoint reads as "no results from that museum" and nothing
// raises an error. This script makes one real query per source, through the
// engine's own fetcher and rights gate, and fails loudly when a source answers
// with an error, an empty result, or records the engine cannot fetch or accept.
//
// It imports the engine from the installed `open-museum-mcp` package, so run it
// from a directory that has the package installed to test what users actually
// get (see .github/workflows/source-health.yml). From a checkout it resolves to
// the local build. Fetchers are called directly, so the object cache is never
// consulted and a dead upstream cannot be masked by cached records.
//
// Usage: node source-health.mjs [--query horse] [--json]
// Exit code: 0 when every checked source is healthy, 1 otherwise. Key-gated
// sources without a key are reported as skipped, not failed.

import { pathToFileURL } from 'node:url';

export const DEFAULTS = {
  query: 'horse',
  searchLimit: 10,
  timeoutMs: 60_000,
};

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describeError(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Check one source. Returns `{ code, status, detail }` where status is one of
 * `ok`, `skipped`, `error` (search threw: HTTP 4xx/410, auth, timeout),
 * `empty` (search succeeded but returned no IDs), `unfetchable` (IDs came back
 * but no record could be fetched) or `unaccepted` (records fetched, none passed
 * the rights gate).
 */
export async function checkSource(fetcher, options = {}, env = process.env) {
  const { query, searchLimit, timeoutMs } = { ...DEFAULTS, ...options };
  const code = fetcher.code;

  if (fetcher.requiresApiKey && !env[fetcher.requiresApiKey]) {
    return { code, status: 'skipped', detail: `${fetcher.requiresApiKey} not set` };
  }

  let ids;
  try {
    ids = await withTimeout(fetcher.search(query, searchLimit), timeoutMs, 'search');
  } catch (err) {
    return { code, status: 'error', detail: `search failed: ${describeError(err)}` };
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return { code, status: 'empty', detail: `search for "${query}" returned no results` };
  }

  let fetched = 0;
  let accepted = 0;
  let lastError = '';
  for (const id of ids) {
    try {
      const raw = await withTimeout(fetcher.getRaw(id), timeoutMs, 'fetch');
      fetched += 1;
      const result = fetcher.normalize(raw);
      if (result.status === 'accepted') {
        accepted += 1;
        break;
      }
    } catch (err) {
      lastError = describeError(err);
    }
  }
  if (fetched === 0) {
    return {
      code,
      status: 'unfetchable',
      detail: `search returned ${ids.length} IDs but none could be fetched (${lastError})`,
    };
  }
  if (accepted === 0) {
    return {
      code,
      status: 'unaccepted',
      detail: `fetched ${fetched} of ${ids.length} records and none passed the rights gate`,
    };
  }
  return { code, status: 'ok', detail: `${ids.length} results, record fetched and accepted` };
}

/** Every registered source resolved to its fetcher instance from `/core`. */
export function resolveFetchers(core) {
  return core.FETCHER_REGISTRY.map((entry) => ({
    entry,
    fetcher: core[`${entry.code}Fetcher`],
  }));
}

export async function runAll(core, options = {}, env = process.env) {
  const results = [];
  for (const { entry, fetcher } of resolveFetchers(core)) {
    if (!fetcher) {
      results.push({
        code: entry.code,
        status: 'error',
        detail: 'registered source is not exported from /core',
      });
      continue;
    }
    results.push(await checkSource(fetcher, options, env));
  }
  return results;
}

export function isFailure(result) {
  return result.status !== 'ok' && result.status !== 'skipped';
}

export function formatReport(results) {
  const lines = results.map(
    (r) => `${isFailure(r) ? 'FAIL' : r.status === 'skipped' ? 'SKIP' : ' ok '}  ${r.code.padEnd(12)} ${r.status.padEnd(12)} ${r.detail}`,
  );
  const failed = results.filter(isFailure).length;
  lines.push('', `${results.length - failed} of ${results.length} sources healthy${failed ? `, ${failed} failing` : ''}.`);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const qi = args.indexOf('--query');
  const options = qi >= 0 && args[qi + 1] ? { query: args[qi + 1] } : {};

  const core = await import('open-museum-mcp/core');
  const results = await runAll(core, options);
  console.log(args.includes('--json') ? JSON.stringify(results, null, 2) : formatReport(results));
  process.exitCode = results.some(isFailure) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

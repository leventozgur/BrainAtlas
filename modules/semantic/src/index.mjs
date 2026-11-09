// SPDX-License-Identifier: MIT
import { createOllamaProvider, validateConfiguredProvider } from './provider.mjs';
import { markdownChunks } from './chunking.mjs';
import { buildSemanticIndex, updateSemanticIndex, measureIndexFreshness, readSemanticIndex, readPartialIndex } from './index-store.mjs';
import { cosineSimilarity, reciprocalRankFusion, searchHybrid } from './hybrid.mjs';
import { semanticGate } from './eval.mjs';
import { SEMANTIC_DEFAULTS } from '../../../packages/core/src/config/index.mjs';
import { join, resolve } from 'node:path';
import { semanticSetup } from './setup.mjs';

let enabled = false;
let gatePassed = false;

/** A gate result and explicit user opt-in are both required to enable retrieval. */
export function configureSemantic({ gateResult, optIn = false } = {}) {
  gatePassed = gateResult?.enable === true;
  enabled = gatePassed && optIn === true;
  return enabled;
}

export function semanticStatus() { return { enabled, gatePassed }; }

/** Module lifecycle is inert unless the current activation carries a passing gate and opt-in. */
export async function activate(ctx) {
  configureSemantic({ gateResult: ctx?.semanticGateResult, optIn: ctx?.config?.semantic?.enabled === true });
}

function commandOptions(ctx) {
  const settings = { ...SEMANTIC_DEFAULTS, ...ctx.config.semantic };
  validateConfiguredProvider(settings);
  const vault = resolve(ctx.env.HOME ?? '.', ctx.config.vault.path);
  return { settings, corpusDir: join(vault, 'wiki'), stateDir: ctx.paths.stateDir,
    provider: createOllamaProvider({ ...settings, timeoutMs: settings.indexTimeoutMs, batchSize: settings.indexBatchSize, fetchImpl: ctx.fetchImpl ?? globalThis.fetch }), indexBatchSize: settings.indexBatchSize, chunkMarkdown: markdownChunks };
}
export const commands = Object.freeze({
  async semanticSetup(args, ctx) { return semanticSetup(args, ctx); },
  async semanticIndex(args, ctx) {
    const options = commandOptions(ctx);
    const index = await updateSemanticIndex(options);
    return { indexed: Object.keys(index.fileHashes).length };
  },
  semanticStatus(args, ctx) {
    if (!ctx) return semanticStatus();
    return (async () => {
      const options = commandOptions(ctx);
      const index = await readSemanticIndex(options.stateDir);
      const freshness = await measureIndexFreshness({ corpusDir: options.corpusDir, index });
      const partial = await readPartialIndex(options.stateDir, options.provider);
      return { enabled: options.settings.enabled, model: options.settings.model, ...freshness, fingerprintMatches: Boolean(index && index.providerFingerprint === options.provider.fingerprint), partialChunks: Object.keys(partial?.vectors ?? {}).length };
    })();
  },
});

export {
  buildSemanticIndex,
  updateSemanticIndex,
  cosineSimilarity,
  createOllamaProvider,
  validateConfiguredProvider,
  markdownChunks,
  measureIndexFreshness,
  readSemanticIndex,
  reciprocalRankFusion,
  searchHybrid,
  semanticGate,
};

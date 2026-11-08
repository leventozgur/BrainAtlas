// SPDX-License-Identifier: MIT
import { createOllamaProvider } from './provider.mjs';
import { markdownChunks } from './chunking.mjs';
import { buildSemanticIndex, measureIndexFreshness, readSemanticIndex } from './index-store.mjs';
import { cosineSimilarity, reciprocalRankFusion, searchHybrid } from './hybrid.mjs';
import { semanticGate } from './eval.mjs';

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

export const commands = Object.freeze({
  semanticStatus() { return semanticStatus(); },
});

export {
  buildSemanticIndex,
  cosineSimilarity,
  createOllamaProvider,
  markdownChunks,
  measureIndexFreshness,
  readSemanticIndex,
  reciprocalRankFusion,
  searchHybrid,
  semanticGate,
};

// SPDX-License-Identifier: MIT
export const from = 0;
export const to = 1;
/** @param {object} obj */
export function migrate(obj) {
    const profile = ['lite','full','custom'].includes(obj?.profile) ? obj.profile : 'lite';
    return {
      schemaVersion: 1, profile,
      vault: { path: typeof obj?.vault?.path === 'string' && obj.vault.path ? obj.vault.path : '.' },
      modules: Array.isArray(obj?.modules) ? obj.modules : (profile === 'full' ? ['*'] : []),
      agents: Array.isArray(obj?.agents) ? obj.agents : [], scope: obj?.scope === 'vault' ? 'vault' : 'global',
      retrieval: { budgetChars: obj?.retrieval?.budgetChars ?? 4000, abstainThreshold: obj?.retrieval?.abstainThreshold ?? 0.35 },
      hooks: { mode: obj?.hooks?.mode ?? 'normal', deadlineMs: obj?.hooks?.deadlineMs ?? 1000 },
      safety: { secretFilter: true, extraDenyGlobs: Array.isArray(obj?.safety?.extraDenyGlobs) ? obj.safety.extraDenyGlobs : [], allow: Array.isArray(obj?.safety?.allow) ? obj.safety.allow : [] },
      okf: { level: obj?.okf?.level ?? 'warn' }, sync: { transport: obj?.sync?.transport ?? null, options: obj?.sync?.options ?? {} },
      telemetry: false, readOnly: obj?.readOnly === true, node: { path: obj?.node?.path ?? 'node' }
    };
}
export default { from, to, migrate };

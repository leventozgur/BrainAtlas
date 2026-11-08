import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as a from '../../../packages/adapters/copilot-vscode/src/index.mjs';

async function setup(t, scope = 'global', platform = 'linux', optional = false) {
  const root = await mkdtemp(join(tmpdir(), 'copilot acceptance '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), vault = join(root, 'vault'), sentinel = join(root, 'outside-sentinel');
  await mkdir(home, { recursive: true }); await mkdir(vault, { recursive: true });
  await writeFile(sentinel, 'unchanged');
  const ctx = { env: { HOME: home }, platform, scope, paths: { stateDir: join(root, 'state'), vault }, config: { agents: { copilot: { vscodeUserMcp: optional } } }, nodePath: '/path with spaces/node', shimPath: '/path with spaces/stable-shim', now: new Date('2026-01-01T00:00:00Z') };
  return { root, home, vault, sentinel, ctx };
}
async function put(file, text) { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, text); }
async function bytes(file) { try { return await readFile(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function paths(s) { return s.ctx.scope === 'global' ? [join(s.home,'.copilot/mcp-config.json'), join(s.home,'.copilot/hooks/brainatlas.json'), join(s.home,'.copilot/instructions/brainatlas.instructions.md')] : [join(s.vault,'.vscode/mcp.json'), join(s.vault,'.github/hooks/brainatlas.json'), join(s.vault,'.github/copilot-instructions.md')]; }
const later = ctx => ({ ...ctx, now: new Date('2026-01-01T00:00:01Z') });

for (const scope of ['global','vault']) for (const indent of ['  ', '    ', '\t']) for (const newline of ['', '\n']) {
  test(`${scope}: JSON ${JSON.stringify(indent)} ending ${JSON.stringify(newline)} round trip`, async t => {
    const s = await setup(t, scope); const [mcp, hook, instructions] = paths(s);
    const rootKey = scope === 'global' ? 'mcpServers' : 'servers';
    const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
    const original = JSON.stringify({ [rootKey]: { other: { command: 'existing' } }, user: { secret } }, null, indent) + newline;
    await put(mcp, original);
    if (scope === 'vault') await put(instructions, '# User rules\r\nKeep this.');
    const before = await Promise.all([mcp, hook, instructions].map(bytes));
    const p = a.plan(s.ctx); assert.equal((await bytes(mcp)).toString(), original);
    await a.apply(p, s.ctx); assert.deepEqual(a.plan(s.ctx).changes, []);
    const data = JSON.parse(await readFile(mcp, 'utf8')); assert.equal(data.user.secret, secret); assert.equal(data[rootKey].other.command, 'existing');
    assert.equal(data[rootKey].brainatlas.command, s.ctx.nodePath); assert.deepEqual(data[rootKey].brainatlas.args, [s.ctx.shimPath, 'mcp']);
    const hooks = JSON.parse(await readFile(hook, 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks), ['sessionStart']); assert.equal(hooks.sessionStart[0].command, '"/path with spaces/node" "/path with spaces/stable-shim" hook copilot session-start');
    assert.match(await readFile(instructions, 'utf8'), /wiki_query/);
    await a.remove(later(s.ctx)); assert.deepEqual(await Promise.all([mcp, hook, instructions].map(bytes)), before);
    assert.equal(await readFile(s.sentinel, 'utf8'), 'unchanged');
  });
}
for (const scope of ['global','vault']) for (const content of ['', '{broken', '\ufeff{}']) {
 test(`${scope}: malformed/BOM ${JSON.stringify(content)} rejected without writes`, async t => {
  const s = await setup(t, scope); const [mcp, hook] = paths(s); await put(mcp, content);
  assert.throws(() => a.plan(s.ctx), { code: content.startsWith('\ufeff') ? 'E_BOM' : 'E_CONFIG_PARSE' });
  assert.equal(await readFile(mcp, 'utf8'), content); assert.equal(await bytes(hook), null);
 });
}
for (const platform of ['linux','darwin']) for (const enabled of [false,true]) {
 test(`${platform}: VS Code user MCP opt-in ${enabled}`, async t => {
  const s = await setup(t, 'global', platform, enabled);
  const profile = join(s.home, platform === 'darwin' ? 'Library/Application Support/Code/User/mcp.json' : '.config/Code/User/mcp.json');
  const original = '{"servers":{"other":{"command":"user"}}}'; await put(profile, original);
  await a.apply(a.plan(s.ctx), s.ctx);
  if (enabled) assert.equal(JSON.parse(await readFile(profile,'utf8')).servers.brainatlas.command, s.ctx.nodePath);
  else assert.equal(await readFile(profile,'utf8'), original);
  await a.remove(later(s.ctx)); assert.equal(await readFile(profile,'utf8'), original);
 });
}
test('missing files, health, trust and detection', async t => {
 const s = await setup(t); assert.equal(a.detect({ HOME: s.home }), false);
 assert.equal((await a.doctor(s.ctx)).checks.find(x => x.id === 'registered').ok, false);
 await a.apply(a.plan(s.ctx), s.ctx); assert.equal(a.detect({ HOME: s.home }), true);
 assert.equal((await a.doctor(s.ctx)).checks.find(x => x.id === 'registered').ok, true);
 const trust = await a.trustReview(s.ctx); assert.match(trust.client, /Copilot.*VS Code/i); assert.ok(trust.required); assert.ok(trust.steps.some(x => /trust/i.test(x)));
 await a.remove(later(s.ctx)); for (const file of paths(s)) assert.equal(await bytes(file), null);
});
test('stale plan refuses changed configuration', async t => {
 const s = await setup(t); const [mcp] = paths(s); const p = a.plan(s.ctx); await put(mcp, '{"user":true}');
 await assert.rejects(a.apply(p, s.ctx), { code: 'E_CONFIG_CHANGED' }); assert.equal(await readFile(mcp,'utf8'), '{"user":true}');
});
test('edited managed vault block is rejected', async t => {
 const s = await setup(t,'vault'); await a.apply(a.plan(s.ctx), s.ctx); const file = paths(s)[2];
 const edited = (await readFile(file,'utf8')).replace('Use the BrainAtlas MCP tools', 'User edit'); await writeFile(file, edited);
 assert.throws(() => a.plan(s.ctx), { code: 'E_MANAGED_BLOCK_EDITED' });
 await assert.rejects(a.remove(later(s.ctx)), { code: 'E_MANAGED_BLOCK_EDITED' }); assert.equal(await readFile(file,'utf8'), edited);
});
test('symlinked configuration directory cannot write outside HOME', { skip: 'PM: a symlinked agent config dir is a legitimate user-directed setup; adapters follow it (cross-adapter policy).' }, async t => {
 const s = await setup(t); const outside = join(s.root, 'outside'); await mkdir(outside);
 await symlink(outside, join(s.home,'.copilot')); const before = await bytes(join(outside,'mcp-config.json'));
 try { await a.apply(a.plan(s.ctx), s.ctx); } catch { /* refusal is acceptable */ }
 assert.deepEqual(await bytes(join(outside,'mcp-config.json')), before);
});
test('forged plan cannot write outside owned paths', async t => {
 const s = await setup(t); const before = await bytes(s.sentinel);
 const p = { changes: [{ file: join(s.home, '..', 'outside-sentinel'), kind:'modify', before:'unchanged', after:'overwritten', ownership:'whole-file' }] };
 try { await a.apply(p, s.ctx); } catch { /* refusal is acceptable */ }
 assert.deepEqual(await bytes(s.sentinel), before);
});

test('plan and diagnostic outputs do not expose user secrets', { skip: 'PM: plan objects carry exact file bytes by contract (byte-exact restore); redaction is required where plans are RENDERED (CLI --plan) — tracked for E2E/AUDIT.' }, async t => {
 const s = await setup(t); const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
 await put(paths(s)[0], JSON.stringify({ mcpServers: { other: { token: secret } } }));
 const outputs = JSON.stringify({ plan: a.plan(s.ctx), health: await a.doctor(s.ctx), trust: await a.trustReview(s.ctx) });
 assert.equal(outputs.includes(secret), false, 'outputs must not reveal user secret');
});
test('vault apply and remove restore existing instructions byte for byte', async t => {
 const s = await setup(t, 'vault'); const file = paths(s)[2]; const original = '# User rules\r\n\r\nPreserve me.'; await put(file, original);
 await a.apply(a.plan(s.ctx), s.ctx); await a.remove(later(s.ctx)); assert.equal(await readFile(file,'utf8'), original);
});
test('existing foreign hook file is refused without modifications', async t => {
 const s = await setup(t); const hook = paths(s)[1]; const original = '{"hooks":{"sessionStart":[]}}'; await put(hook, original);
 assert.throws(() => a.plan(s.ctx), { code: 'E_CONFIG_OWNERSHIP' }); assert.equal(await readFile(hook,'utf8'), original); assert.equal(await bytes(paths(s)[0]), null);
});

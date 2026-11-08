// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const files = ['README.md', 'README.tr.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', ...(await readdir(resolve(root, 'docs/user'))).filter(f => f.endsWith('.md')).map(f => `docs/user/${f}`)];
const docs = await Promise.all(files.map(async file => ({ file, text: await readFile(resolve(root, file), 'utf8') })));
const cli = await readFile(resolve(root, 'packages/cli/src/index.mjs'), 'utf8');
const commands = new Set([...cli.matchAll(/command\s*===\s*['"]([\w-]+)['"]/g)].map(m => m[1]));
// PM update (Q-SEMWIRE): optional modules expose CLI commands dynamically (dispatchModuleCommand); count their `commands` export keys as dispatchable.
for (const moduleName of await readdir(resolve(root, 'modules'))) {
  let source = '';
  try { source = await readFile(resolve(root, 'modules', moduleName, 'src/index.mjs'), 'utf8'); } catch { continue; }
  const block = source.match(/export const commands\s*=\s*(?:Object\.freeze\()?\{([\s\S]*?)\n\}\)?;/);
  if (block) for (const m of block[1].matchAll(/^\s{2}(?:async\s+)?([A-Za-z][\w-]*)\s*[(:]/gm)) commands.add(m[1]);
}
function referencedCommands(text) { return [...text.matchAll(/\bbrainatlas\s+([a-z][\w-]*)/g)].map(m => m[1]); }
function markdownLinks(text) { return [...text.matchAll(/(?<!!)\[[^\]]+\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1]); }
async function badLinks(base, text) {
  const bad = [];
  for (const raw of markdownLinks(text)) {
    if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(raw)) continue;
    let target;
    try { target = decodeURIComponent(raw.split('#')[0].split('?')[0]); } catch { bad.push(raw); continue; }
    if (!target) continue;
    try { await stat(resolve(base, target)); } catch { bad.push(raw); }
  }
  return bad;
}
function personalLeaks(text) {
  return text.replaceAll('git@github.com', 'example-ssh-host').match(/(?:\/Users\/[^\s/`]+|\/home\/[^\s/`]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/(?:localhost|[\w-]+\.local)(?::\d+)?)/gi) || [];
}
function categories(text, language) {
  const headings = [...text.matchAll(/^#{2,3}\s+(.+)$/gm)].map(m => m[1]).join('\n');
  const patterns = language === 'tr' ? [/Profiller/i, /Desteklenen ajanlar/i, /Hızlı başlangıç/i, /Çevrimiçi/i, /Çevrimdışı/i, /güvenlik/i, /Karşılaştırma/i] : [/Profiles/i, /Supported agents/i, /Quickstart/i, /Online/i, /Offline/i, /security/i, /Comparison/i];
  return patterns.map(p => p.test(headings));
}
test('command parser accepts known commands and rejects invented commands', () => {
  assert(commands.has('doctor')); assert(!commands.has('invented-command'));
  assert.deepEqual(referencedCommands('brainatlas doctor; brainatlas invented-command'), ['doctor', 'invented-command']);
});
test('published built-in command names agree with CLI --help', () => {
  const result = spawnSync(process.execPath, [resolve(root, 'packages/cli/bin/brainatlas.mjs'), '--help'], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: resolve(tmpdir(), 'docs-cli-home') } });
  assert.equal(result.status, 0, result.stderr);
  for (const name of commands) {
    if (name === 'sync' || name === '--help' || name === '-h') continue; // Optional module commands and help aliases are not built-in rows.
    assert.match(result.stdout, new RegExp(`^\\s+${name}\\s`, 'm'), `help omits ${name}`);
  }
  for (const name of ['doctor', 'init', 'config']) assert.match(result.stdout + docs.map(d => d.text).join('\n'), new RegExp(`brainatlas ${name}\\b`));
});
test('all documented brainatlas commands exist in CLI dispatch', () => {
  const unknown = docs.flatMap(d => referencedCommands(d.text).filter(c => !commands.has(c)).map(c => `${d.file}: ${c}`));
  assert.deepEqual(unknown, []);
});
test('relative link checker detects missing, malformed and dangling symlink targets', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'docs-links-'));
  try {
    await mkdir(resolve(dir, 'sub')); await writeFile(resolve(dir, 'ok.md'), 'ok'); await symlink('missing', resolve(dir, 'dangling'));
    assert.deepEqual(await badLinks(resolve(dir, 'sub'), '[ok](../ok.md#part) [web](https://example.invalid)'), []);
    assert.deepEqual(await badLinks(dir, '[bad](missing) [broken](dangling) [encoded](%ZZ)'), ['missing', 'dangling', '%ZZ']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('relative Markdown links resolve', async () => {
  const failures = [];
  for (const doc of docs) for (const link of await badLinks(dirname(resolve(root, doc.file)), doc.text)) failures.push(`${doc.file}: ${link}`);
  assert.deepEqual(failures, []);
});
test('both README languages cover required section headings', () => {
  for (const [file, lang] of [['README.md', 'en'], ['README.tr.md', 'tr']]) assert.deepEqual(categories(docs.find(d => d.file === file).text, lang), Array(7).fill(true), file);
  assert(categories('## Profiles', 'en').includes(false));
});
test('documents contain no personal absolute paths, email addresses or local hosts', () => {
  assert.equal(personalLeaks(['', 'Users', 'alice', 'private'].join('/')).length, 1); assert.equal(personalLeaks('~/.local/bin').length, 0);
  assert.deepEqual(docs.flatMap(d => personalLeaks(d.text).map(v => `${d.file}: ${v}`)), []);
});
test('OKF is described as inspiration without compliance claim', () => {
  const all = docs.map(d => d.text).join('\n');
  assert.match(all, /inspired by OKF/i); assert.doesNotMatch(all, /\bOKF\s+(?:v[\d.]+\s+)?compliant\b/i);
  assert.match('OKF compliant', /\bOKF\s+(?:v[\d.]+\s+)?compliant\b/i);
});
test('experimental and unverified integration limitations are disclosed in both READMEs', () => {
  for (const file of ['README.md', 'README.tr.md']) {
    const text = docs.find(d => d.file === file).text;
    const patterns = file.endsWith('.tr.md') ? [/Semantik[^\n]*deneysel[^\n]*kapalı/i, /Klasör senkronizasyonu deneysel/i, /Global talimat yolu doğrulanmamış/i, /tetikleyicisinin adı[^\n]*doğrulanmamış/i] : [/Semantic retrieval[^\n]*experimental[^\n]*off by default/i, /Folder sync is experimental/i, /Global instructions path is unverified/i, /trigger name[^\n]*unverified/i];
    for (const pattern of patterns) assert.match(text, pattern, `${file}: ${pattern}`);
    assert(!patterns.every(p => p.test('unqualified claims')));
  }
});
test('comparison table keeps unverifiable claims marked for verification', () => {
  for (const file of ['README.md', 'README.tr.md']) {
    const text = docs.find(d => d.file === file).text;
    for (const name of ['claude-mem', 'basic-memory', 'Karpathy', 'avenoxbeyin']) {
      const row = text.split('\n').find(line => line.startsWith('|') && line.toLowerCase().includes(name.toLowerCase()));
      assert.ok(row && /verify before publishing|verify current|yayın öncesi doğrulayın|yayın öncesi doğrulayın/i.test(row), `${file}: ${name} must remain qualified pending sourcing`);
    }
  }
});
test('online quickstart points to the GitHub Releases channel and the signing key fingerprint', () => {
  for (const [file, start, end] of [['README.md', '### Online', '### Offline'], ['README.tr.md', '### Çevrimiçi', '### Çevrimdışı']]) {
    const text = docs.find(d => d.file === file).text; const section = text.split(start)[1]?.split(end)[0] || '';
    assert.match(section, /github\.com\/[\w.-]+\/BrainAtlas\/releases/i, `${file}: release channel missing`);
    assert.match(section, /SHA256:[A-Za-z0-9+\/]{43}/, `${file}: signing key fingerprint missing`);
  }
});

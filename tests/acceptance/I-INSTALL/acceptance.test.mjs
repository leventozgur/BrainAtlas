// SPDX-License-Identifier: MIT
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, writeFile, readFile, readdir, lstat, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { buildRelease, verifyRelease } from '../../../release/build-release.mjs';

const root = resolve(import.meta.dirname, '../../..');
let temp, source, signer, key, artifacts, sentinel, baselineSentinel;
const sha = b => createHash('sha256').update(b).digest('hex');
const run = (command, args, env, ok = true) => {
  const r = spawnSync(command, args, { encoding: 'utf8', env, timeout: 60000 });
  assert.equal(r.error, undefined, r.error?.message);
  if (ok) assert.equal(r.status, 0, `${command} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  else assert.notEqual(r.status, 0, `${command} unexpectedly succeeded: ${r.stdout}`);
  return `${r.stdout}${r.stderr}`;
};
async function snapshot(dir) {
  const result = {};
  async function walk(path, rel = '') {
    for (const name of (await readdir(path)).sort()) {
      const p = join(path, name), r = rel ? `${rel}/${name}` : name, s = await lstat(p);
      if (s.isSymbolicLink()) result[r] = `link:${await readlink(p)}`;
      else if (s.isDirectory()) { result[r] = 'dir'; await walk(p, r); }
      else result[r] = `file:${s.mode & 0o777}:${sha(await readFile(p))}`;
    }
  }
  await walk(dir); return result;
}
function environment(home, platform) {
  const { XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME, ...base } = process.env;
  return { ...base, HOME: home, TMPDIR: temp, BRAINATLAS_PLATFORM: platform, BRAINATLAS_OFFLINE: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', BRAINATLAS_ALLOWED_SIGNERS: signer };
}
function sign(dir) { execFileSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', 'brainatlas-release', join(dir, 'SHA256SUMS')], { stdio: 'ignore' }); }
async function customArchive(name, kind) {
  const dir = join(temp, name); await mkdir(dir);
  const entry = kind === 'traversal' ? '../escape' : kind === 'absolute' ? '/escape' : 'brainatlas-9.0.0/link';
  const header = Buffer.alloc(512); header.write(entry); const oct = (n, p, l) => header.write(n.toString(8).padStart(l - 1, '0') + '\0', p, l);
  oct(0o644,100,8); oct(0,108,8); oct(0,116,8); oct(0,124,12); oct(0,136,12); header.fill(32,148,156); header.write(kind === 'symlink' ? '2' : '0',156); header.write('ustar\0',257); header.write('00',263); if (kind === 'symlink') header.write('../../escape',157);
  header.write(header.reduce((a,b) => a+b,0).toString(8).padStart(6,'0')+'\0 ',148,8);
  const bytes = gzipSync(Buffer.concat([header, Buffer.alloc(1024)])); const archive = join(dir, 'brainatlas-9.0.0-lite.tgz');
  await writeFile(archive, bytes); await writeFile(join(dir,'SHA256SUMS'), `${sha(bytes)}  ${archive.split('/').at(-1)}\n`); sign(dir); return archive;
}
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'brainatlas-accept-')); source = join(temp, 'source'); await mkdir(source);
  for (const p of ['package.json','package-lock.json','packages','vendor','templates','release']) await cp(join(root,p), join(source,p), { recursive: true });
  await symlink(join(root,'node_modules'), join(source,'node_modules'));
  await mkdir(join(source,'modules','fixture'), { recursive: true });
  await writeFile(join(source,'modules','fixture','module.json'), JSON.stringify({name:'fixture',version:'1.0.0',description:'Acceptance fixture',requires:[],provides:['fixture'],profiles:['full','custom'],entry:'index.mjs'}));
  await writeFile(join(source,'modules','fixture','index.mjs'), 'export async function activate() {}\nexport const commands = {};\n');
  await mkdir(join(source,'modules','unmanifested')); await writeFile(join(source,'modules','unmanifested','data'), 'excluded');
  key = join(temp,'key'); execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',key]); signer = join(temp,'allowed_signers');
  await writeFile(signer, `brainatlas-release ${(await readFile(`${key}.pub`,'utf8')).trim()}\n`);
  sentinel = join(temp,'outside-home-sentinel'); await writeFile(sentinel,'untouched'); baselineSentinel = await readFile(sentinel);
  artifacts = join(temp,'artifacts'); await mkdir(artifacts); process.env.BRAINATLAS_RELEASE_SOURCE = source;
  for (const version of ['1.0.0','2.0.0','3.0.0']) for (const profile of ['lite','full']) await buildRelease({version, profile, out: artifacts});
  sign(artifacts);
});
after(async () => { delete process.env.BRAINATLAS_RELEASE_SOURCE; if (temp) await rm(temp,{recursive:true,force:true}); });

test('deterministic builds, lite purity and fixture-only full modules', async () => {
  const another = join(temp,'repeat'); await mkdir(another); await buildRelease({version:'1.0.0',profile:'lite',out:another});
  assert.deepEqual(await readFile(join(another,'brainatlas-1.0.0-lite.tgz')), await readFile(join(artifacts,'brainatlas-1.0.0-lite.tgz')));
  const lite = await verifyRelease(join(artifacts,'brainatlas-1.0.0-lite.tgz'),join(artifacts,'SHA256SUMS'),join(artifacts,'SHA256SUMS.sig'),signer);
  assert.deepEqual(lite.modules, []); assert.ok(lite.files.every(f => !f.path.startsWith('modules/')));
  const forbidden = /modules\/sync-|keychain|secret-service|launchd|systemd|dropbox/i;
  for (const f of lite.files.filter(f => /^(packages\/|vendor\/llmwiki-core\/|templates\/)/.test(f.path))) { const bytes = await readFile(join(source,f.path)); assert.equal(sha(bytes),f.sha256); assert.ok(!forbidden.test(f.path) && !forbidden.test(bytes.toString('utf8')), f.path); }
  const full = await verifyRelease(join(artifacts,'brainatlas-2.0.0-full.tgz'),join(artifacts,'SHA256SUMS'),join(artifacts,'SHA256SUMS.sig'),signer);
  assert.deepEqual(full.modules,['fixture']);
  const forbiddenFile = join(source,'packages','core','acceptance-forbidden.txt'); await writeFile(forbiddenFile,['drop','box'].join(''));
  try { await assert.rejects(buildRelease({version:'4.0.0',profile:'lite',out:another}), {code:'E_LITE_PURITY'}); } finally { await rm(forbiddenFile); }
});

test('reject checksum, signature, missing signer and malicious tar entries before extraction', async () => {
  const archive = join(artifacts,'brainatlas-1.0.0-lite.tgz'), sums = join(artifacts,'SHA256SUMS'), sig = join(artifacts,'SHA256SUMS.sig');
  const bad = join(temp,'bad'); await mkdir(bad); const badArchive = join(bad,'brainatlas-1.0.0-lite.tgz'); await cp(archive,badArchive); await writeFile(join(bad,'SHA256SUMS'), `${'0'.repeat(64)}  brainatlas-1.0.0-lite.tgz\n`); await cp(sig,join(bad,'SHA256SUMS.sig'));
  await assert.rejects(verifyRelease(badArchive,join(bad,'SHA256SUMS'),join(bad,'SHA256SUMS.sig'),signer),{code:'E_SHA_MISMATCH'});
  const invalidSig = join(temp,'invalid.sig'); await writeFile(invalidSig,'invalid'); await assert.rejects(verifyRelease(archive,sums,invalidSig,signer),{code:'E_SIGNATURE_INVALID'});
  await assert.rejects(verifyRelease(archive,sums,sig,join(temp,'missing-signers')),{code:'E_SIGNATURE_INVALID'});
  for (const kind of ['traversal','absolute','symlink']) { const malicious = await customArchive(kind,kind); await assert.rejects(verifyRelease(malicious,join(dirname(malicious),'SHA256SUMS'),join(dirname(malicious),'SHA256SUMS.sig'),signer),{code:'E_MANIFEST_INVALID'}); }
  assert.deepEqual(await readFile(sentinel), baselineSentinel);
});

for (const platform of ['linux','darwin']) test(`offline lifecycle, recovery, plan, privacy and uninstall: ${platform}`, async () => {
  const home = join(temp,`home-${platform}`); await mkdir(home); await writeFile(join(home,'preexisting'), 'preserve'); const beforeHome = await snapshot(home);
  const env = environment(home,platform), lite1 = join(artifacts,'brainatlas-1.0.0-lite.tgz'), lite2 = join(artifacts,'brainatlas-2.0.0-lite.tgz'), lite3 = join(artifacts,'brainatlas-3.0.0-lite.tgz'), full2 = join(artifacts,'brainatlas-2.0.0-full.tgz');
  const data = platform === 'darwin' ? join(home,'Library/Application Support/BrainAtlas') : join(home,'.local/share/brainatlas');
  const state = platform === 'darwin' ? join(data,'state') : join(home,'.local/state/brainatlas');
  run('sh',[join(root,'install.sh'),'--from',lite1,'--profile','lite','--allowed-signers',signer,'--yes','--vault',join(temp,`vault-${platform}`)],env);
  const cli = (...args) => run(process.execPath,[join(data,'current/packages/cli/bin/brainatlas.mjs'),...args],env);
  const fail = (...args) => run(process.execPath,[join(data,'current/packages/cli/bin/brainatlas.mjs'),...args],env,false);
  assert.equal(JSON.parse(cli('status','--json')).currentVersion,'1.0.0');
  assert.equal(JSON.parse(cli('update','--check','--json')).reason,'offline');
  assert.equal(JSON.parse(cli('update','--check','--from',lite2,'--json')).status,'available');
  const planned = await snapshot(home); cli('update','--from',lite2,'--plan'); cli('uninstall','--plan'); assert.deepEqual(await snapshot(home),planned);
  cli('update','--from',lite2,'--json'); assert.equal(JSON.parse(cli('status','--json')).currentVersion,'2.0.0');
  assert.match(fail('module','add','missing','--from',full2),/E_MODULE_MISSING/);
  assert.match(fail('module','add','../escape','--from',full2),/E_ARGUMENT/);
  cli('module','add','fixture','--from',full2,'--json'); assert.ok(JSON.parse(cli('module','list','--json')).modules.some(m => m.name === 'fixture' && m.active));
  const failure = run(process.execPath,[join(data,'current/packages/cli/bin/brainatlas.mjs'),'update','--from',lite3,'--json'],{...env,BRAINATLAS_TEST_DOCTOR_FAIL:'1'},false); assert.match(failure,/E_DOCTOR_FAILED/); assert.equal(JSON.parse(cli('status','--json')).currentVersion,'2.0.0');
  cli('rollback','--json'); assert.equal(JSON.parse(cli('status','--json')).currentVersion,'1.0.0');
  const journal = join(state,'update-journal.json'); await writeFile(journal,JSON.stringify({schemaVersion:1,kind:'update',phase:'switching',target:'releases/2.0.0',previous:'releases/1.0.0',staging:null}));
  assert.equal(JSON.parse(cli('recover','--json')).action,'restored-previous-release'); assert.equal(JSON.parse(cli('recover','--json')).recovered,false);
  await writeFile(journal,'{broken'); assert.match(fail('recover','--json'),/E_JOURNAL_INVALID/); await rm(journal);
  const secret = ['sk','test'+'x'.repeat(24)].join('-'); const out = fail('config','set','unknown',secret); assert.ok(!out.includes(secret));
  cli('uninstall','--keep-vault','--json'); assert.deepEqual(await snapshot(home),beforeHome); assert.deepEqual(await readFile(sentinel),baselineSentinel);
});

test('installer does not follow a HOME directory symlink outside HOME', { skip: 'PM: a user-created symlink for ~/.local (or XDG_*_HOME pointing elsewhere) is a legitimate setup chosen by the same user; writes go where the user directed and are recorded in the install manifest. Not a privilege boundary.' }, async () => {
  const home = join(temp,'symlink-home'), outside = join(temp,'symlink-outside'); await mkdir(home); await mkdir(outside);
  await writeFile(join(outside,'sentinel'), 'preserve'); await symlink(outside,join(home,'.local')); const beforeOutside = await snapshot(outside);
  const env = environment(home,'linux');
  spawnSync('sh',[join(root,'install.sh'),'--from',join(artifacts,'brainatlas-1.0.0-lite.tgz'),'--profile','lite','--allowed-signers',signer,'--yes','--vault',join(temp,'symlink-vault')],{env,encoding:'utf8',timeout:60000});
  const afterOutside = await snapshot(outside);
  assert.equal(sha(JSON.stringify(afterOutside)),sha(JSON.stringify(beforeOutside)), 'installer wrote through .local symlink outside HOME');
});

test('offline metadata-only update has a supported read-only result', async () => {
  const home = join(temp,'metadata-home'); await mkdir(home); const env = environment(home,'linux'); const beforeHome = await snapshot(home);
  const result = run(process.execPath,[join(root,'packages/cli/bin/brainatlas.mjs'),'update','--metadata-only','--json'],env);
  assert.ok(JSON.parse(result)); assert.deepEqual(await snapshot(home),beforeHome);
});

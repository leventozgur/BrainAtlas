// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths } from '../../packages/core/src/index.mjs';
import { main } from '../../packages/cli/src/index.mjs';
import { cleanEnv } from './clean-env.mjs';

const RELEASES_URL = 'https://api.github.com/repos/leventozgur/BrainAtlas/releases?per_page=30';
const RELEASE_PREFIX = 'https://github.com/leventozgur/BrainAtlas/releases/';
const DOWNLOAD_PREFIX = 'https://github.com/leventozgur/BrainAtlas/releases/download/';

function release(version, { prerelease = false, draft = false, html = true, assets = true } = {}) {
  const tag = `v${version}`;
  return {
    tag_name: tag,
    draft,
    prerelease,
    html_url: html ? `${RELEASE_PREFIX}tag/${tag}` : 'https://example.invalid/release',
    assets: assets
      ? [
          {
            name: `brainatlas-${version}-distribution.tar.gz`,
            browser_download_url: `${DOWNLOAD_PREFIX}${tag}/brainatlas-${version}-distribution.tar.gz`,
          },
          {
            name: `brainatlas-${version}-full.tgz`,
            browser_download_url: `${DOWNLOAD_PREFIX}${tag}/brainatlas-${version}-full.tgz`,
          },
          {
            name: `brainatlas-${version}-lite.tgz`,
            browser_download_url: `${DOWNLOAD_PREFIX}${tag}/brainatlas-${version}-lite.tgz`,
          },
          { name: 'SHA256SUMS', browser_download_url: `${DOWNLOAD_PREFIX}${tag}/SHA256SUMS` },
          { name: 'SHA256SUMS.sig', browser_download_url: `${DOWNLOAD_PREFIX}${tag}/SHA256SUMS.sig` },
        ]
      : [],
  };
}

const response = (body) => ({ ok: true, json: async () => body });

async function fixture(t, { version, profile } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ba86-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
  });
  if (profile) env.BRAINATLAS_PROFILE = profile;
  if (version) {
    const paths = resolvePaths({ platform: 'linux', env });
    await mkdir(join(paths.releasesDir, version), { recursive: true });
    await symlink(`releases/${version}`, paths.currentDir);
  }
  return { home, env };
}

async function run(args, env, fetch) {
  const lines = [];
  const original = console.log;
  console.log = (value) => lines.push(value);
  try {
    await main(args, env, { fetch });
  } finally {
    console.log = original;
  }
  return lines;
}

async function runJson(args, env, fetch) {
  const lines = await run(args, env, fetch);
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
}

test('default check calls the GitHub releases API once with exact headers and downloads nothing', async (t) => {
  const { env } = await fixture(t);
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return response([release('0.2.0')]);
  };
  const result = await runJson(['update', '--check', '--json'], env, fetch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RELEASES_URL);
  assert.deepEqual(calls[0].options.headers, {
    accept: 'application/vnd.github+json',
    'user-agent': 'brainatlas-update-check',
  });
  assert.deepEqual(Object.keys(calls[0].options).sort(), ['headers', 'signal']);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(result.status, 'available');
  assert.equal(result.currentVersion, null);
  assert.equal(result.offeredVersion, '0.2.0');
  assert.equal(result.prerelease, false);
  assert.equal(result.releaseUrl, `${RELEASE_PREFIX}tag/v0.2.0`);
  assert.deepEqual(Object.keys(result.assets).sort(), ['distribution', 'full', 'lite', 'sha256sums', 'signature']);
  assert.equal(result.assets.lite, `${DOWNLOAD_PREFIX}v0.2.0/brainatlas-0.2.0-lite.tgz`);
  assert.ok(Array.isArray(result.next));
  assert.ok(result.next.some((line) => line.includes('brainatlas-0.2.0-lite.tgz')));
});

test('offline skips the request and the metadata env URL keeps the old behaviour', async (t) => {
  const { env } = await fixture(t);
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return response([release('9.0.0')]);
  };
  const offline = await runJson(['update', '--check', '--json'], { ...env, BRAINATLAS_OFFLINE: '1' }, fetch);
  assert.equal(calls, 0);
  assert.deepEqual(offline, { status: 'unknown', reason: 'offline' });

  const urls = [];
  const legacyFetch = async (url) => {
    urls.push(url);
    return response({ version: '9.0.0' });
  };
  const legacy = await runJson(
    ['update', '--check', '--json'],
    { ...env, BRAINATLAS_UPDATE_METADATA_URL: 'https://example.invalid/metadata' },
    legacyFetch
  );
  assert.deepEqual(urls, ['https://example.invalid/metadata']);
  assert.deepEqual(legacy, { status: 'available', currentVersion: null, offeredVersion: '9.0.0' });
});

test('selection ignores drafts and bad tags, respects prereleases and picks the highest', async (t) => {
  const { env } = await fixture(t, { version: '0.1.0' });
  const releases = [
    null,
    'not-an-object',
    7,
    release('9.0.0', { draft: true }),
    { ...release('9.1.0'), tag_name: '0.9.0' },
    { ...release('9.2.0'), tag_name: 'v..' },
    release('9.9.9', { prerelease: true }),
    release('0.2.0'),
    release('0.1.5'),
  ];
  const stable = await runJson(['update', '--check', '--json'], env, async () => response(releases));
  assert.equal(stable.offeredVersion, '0.2.0');

  const pre = await runJson(['update', '--check', '--json', '--pre'], env, async () => response(releases));
  assert.equal(pre.offeredVersion, '9.9.9');
  assert.equal(pre.prerelease, true);

  const installedPre = await fixture(t, { version: '0.1.0-rc.16' });
  const candidates = [release('0.1.0-rc.10', { prerelease: true }), release('0.1.0-rc.20', { prerelease: true })];
  const seen = await runJson(['update', '--check', '--json'], installedPre.env, async () => response(candidates));
  assert.equal(seen.offeredVersion, '0.1.0-rc.20');

  const highest = await runJson(['update', '--check', '--json', '--pre'], env, async () =>
    response([release('0.1.0-rc.9'), release('0.1.0-rc.16'), release('0.1.0')])
  );
  assert.equal(highest.offeredVersion, '0.1.0');
});

test('statuses, asset filtering, profile archive and next lines', async (t) => {
  const same = await fixture(t, { version: '0.2.0' });
  const upToDate = await runJson(['update', '--check', '--json'], same.env, async () => response([release('0.2.0')]));
  assert.equal(upToDate.status, 'up-to-date');
  assert.ok(!('next' in upToDate));

  const newer = await fixture(t, { version: '0.3.0' });
  const currentNewer = await runJson(['update', '--check', '--json'], newer.env, async () =>
    response([release('0.2.0')])
  );
  assert.equal(currentNewer.status, 'current-newer');
  assert.ok(!('next' in currentNewer));

  const { env } = await fixture(t, { version: '0.1.0', profile: 'full' });
  const foreign = release('0.2.0', { html: false });
  foreign.assets[2] = { name: 'brainatlas-0.2.0-lite.tgz', browser_download_url: 'https://evil.invalid/lite.tgz' };
  const result = await runJson(['update', '--check', '--json'], env, async () => response([foreign]));
  assert.equal(result.status, 'available');
  assert.ok(!('releaseUrl' in result));
  assert.ok(!('lite' in result.assets));
  assert.ok(result.assets.distribution.startsWith(DOWNLOAD_PREFIX));
  assert.ok(result.next.some((line) => line.includes('brainatlas-0.2.0-full.tgz')));
  assert.ok(!result.next.join('\n').includes('evil.invalid'));
});

test('failures become metadata-unavailable without leaking text', async (t) => {
  const { env } = await fixture(t);
  const secret = 'https://secret.invalid/token-body';
  const failures = [
    async () => {
      throw new Error(secret);
    },
    async () => {
      throw Object.assign(new Error(secret), { name: 'AbortError' });
    },
    async () => ({ ok: false, status: 404, json: async () => ({ message: secret }) }),
    async () => ({
      ok: true,
      json: async () => {
        throw new Error(secret);
      },
    }),
    async () => response({ tag_name: 'v9.0.0' }),
  ];
  for (const fetch of failures) {
    const lines = await run(['update', '--check', '--json'], env, fetch);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { status: 'unknown', reason: 'metadata-unavailable' });
    assert.ok(!lines[0].includes(secret));
  }
});

test('--pre with the metadata env URL keeps the old single-version behaviour', async (t) => {
  const { env } = await fixture(t);
  const urls = [];
  const legacyFetch = async (url) => {
    urls.push(url);
    return response({ version: '9.0.0-rc.1' });
  };
  const result = await runJson(
    ['update', '--check', '--json', '--pre'],
    { ...env, BRAINATLAS_UPDATE_METADATA_URL: 'https://example.invalid/metadata' },
    legacyFetch
  );
  assert.deepEqual(urls, ['https://example.invalid/metadata']);
  assert.deepEqual(result, { status: 'available', currentVersion: null, offeredVersion: '9.0.0-rc.1' });
});

test('unsafe asset and html URLs are dropped and never reach the next lines', async (t) => {
  const { env } = await fixture(t, { version: '0.1.0' });
  const tag = 'v0.2.0';
  const unsafe = [
    { name: 'brainatlas-0.2.0-distribution.tar.gz', browser_download_url: `${DOWNLOAD_PREFIX}${tag}/a;rm -rf ~` },
    { name: 'brainatlas-0.2.0-lite.tgz', browser_download_url: `${DOWNLOAD_PREFIX}${tag}/$(touch pwned)` },
    { name: 'brainatlas-0.2.0-full.tgz', browser_download_url: `${DOWNLOAD_PREFIX}${tag}/brain atlas-full.tgz` },
    { name: 'SHA256SUMS', browser_download_url: `${DOWNLOAD_PREFIX}${tag}/SHA256SUMS;rm` },
    { name: 'SHA256SUMS.sig', browser_download_url: `${DOWNLOAD_PREFIX}${tag}/SHA256SUMS.sig` },
  ];
  const entry = {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `${RELEASE_PREFIX}tag/${tag};$(touch pwned)`,
    assets: unsafe,
  };
  const result = await runJson(['update', '--check', '--json'], env, async () => response([entry]));
  assert.equal(result.status, 'available');
  assert.ok(!('releaseUrl' in result));
  assert.deepEqual(result.assets, { signature: `${DOWNLOAD_PREFIX}${tag}/SHA256SUMS.sig` });
  assert.ok(!('next' in result));

  const safeDistribution = {
    ...entry,
    assets: [
      ...unsafe,
      { name: 'brainatlas-0.2.0-distribution.tar.gz', browser_download_url: `${DOWNLOAD_PREFIX}${tag}/ok.tar.gz` },
    ],
  };
  const withNext = await runJson(['update', '--check', '--json'], env, async () => response([safeDistribution]));
  const text = withNext.next.join('\n');
  assert.ok(text.includes(`${DOWNLOAD_PREFIX}${tag}/brainatlas-0.2.0-distribution.tar.gz`));
  for (const fragment of [';', '$', 'touch pwned', 'brain atlas'])
    assert.ok(!text.includes(fragment), `next leaks ${JSON.stringify(fragment)}`);
});

test('release without the distribution asset yields no next lines', async (t) => {
  const { env } = await fixture(t, { version: '0.1.0' });
  const result = await runJson(['update', '--check', '--json'], env, async () =>
    response([release('0.2.0', { assets: false })])
  );
  assert.equal(result.status, 'available');
  assert.deepEqual(result.assets, {});
  assert.ok(!('next' in result));
});

test('custom profile names the full archive and next uses mkdir without -p', async (t) => {
  const { env } = await fixture(t, { version: '0.1.0', profile: 'custom' });
  const result = await runJson(['update', '--check', '--json'], env, async () => response([release('0.1.1')]));
  assert.equal(result.status, 'available');
  const mkdir = result.next.find((line) => line.startsWith('mkdir '));
  assert.equal(mkdir, 'mkdir brainatlas-0.1.1');
  assert.ok(result.next.includes('brainatlas update --from brainatlas-0.1.1/brainatlas-0.1.1-full.tgz'));
  const fingerprint = result.next.findIndex((line) =>
    line.startsWith('# Check that the key fingerprint in brainatlas-0.1.1/release/allowed_signers is SHA256:')
  );
  assert.ok(fingerprint >= 0);
  assert.ok(result.next.indexOf(result.next.find((line) => line.startsWith('ssh-keygen -Y verify'))) > fingerprint);
});

test('installed build metadata counts as stable and ignores pre-releases', async (t) => {
  const { env } = await fixture(t, { version: '0.1.0+build-1' });
  const result = await runJson(['update', '--check', '--json'], env, async () =>
    response([release('0.2.0-rc.1', { prerelease: true }), release('0.1.5')])
  );
  assert.equal(result.status, 'available');
  assert.equal(result.currentVersion, '0.1.0+build-1');
  assert.equal(result.offeredVersion, '0.1.5');
  assert.equal(result.prerelease, false);
});

test('human output prints the status line and the next lines', async (t) => {
  const { env } = await fixture(t, { version: '0.1.0' });
  const lines = await run(['update', '--check'], env, async () => response([release('0.1.1')]));
  const text = lines.join('\n');
  assert.match(text, /Update available: 0\.1\.0 -> 0\.1\.1/);
  assert.match(text, /curl /);
  assert.match(text, /ssh-keygen -Y verify/);
  assert.match(text, /shasum -a 256 -c/);
  assert.match(text, /brainatlas update --from brainatlas-0\.1\.1\/brainatlas-0\.1\.1-lite\.tgz/);
});

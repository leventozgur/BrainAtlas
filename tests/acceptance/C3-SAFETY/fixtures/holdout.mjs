// SPDX-License-Identifier: MIT
// Deterministic, synthetic holdout data. Every credential-shaped value is fake.
const tokenBody = (seed, length = 32) => {
  let out = '';
  for (let n = seed + 0x9e37; out.length < length; n += 0x9e37) out += n.toString(36).toUpperCase();
  return out.slice(0, length);
};

const positives = [];
const add = (id, text, secrets) => positives.push({ id, text, secrets });

const providerTokens = [
  ['anthropic', (i) => `sk-ant-${tokenBody(i, 28)}`],
  ['openai', (i) => `sk-${tokenBody(i + 20, 28)}`],
  ['github-classic', (i) => `ghp_${tokenBody(i + 40, 26)}`],
  ['github-fine-grained', (i) => `github_pat_${tokenBody(i + 60, 26)}`],
  ['slack', (i) => `xoxb-${tokenBody(i + 80, 20)}`],
  ['aws-access', (i) => `AKIA${tokenBody(i + 100, 16)}`],
  ['google-api', (i) => `AIza${tokenBody(i + 120, 35)}`],
  ['cloud-storage', (i) => `sl.${tokenBody(i + 140, 25)}`],
  ['stripe-live', (i) => `sk_live_${tokenBody(i + 160, 20)}`],
  ['npm', (i) => `npm_${tokenBody(i + 180, 24)}`],
  ['jwt', () => 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.eyJzaWduYXR1cmUiOiJmYWtlIn0'],
  ['aws-secret-assignment', (i) => tokenBody(i + 200, 34)],
];

// Provider-shaped values in plain text exercise each supported provider family.
providerTokens.forEach(([name, make], index) => {
  const value = make(index + 1);
  add(`provider-${name}`, `synthetic fixture ${name}: ${value}`, [value]);
});

// Inline records exercise JSON, YAML, .env, and source-code assignments.
const embedded = [
  (v) => `{"api_key":"${v}"}`,
  (v) => `service:\n  password: '${v}'\n`,
  (v) => `DATABASE_PASSWORD=${v}\n`,
  (v) => `const secret = "${v}";`,
  (v) => `client.access_token = '${v}';`,
  (v) => `credential: ${v}\n`,
  (v) => `{"private_key":"${v}"}`,
  (v) => `export passphrase=${v}`,
  (v) => `config.api-key: "${v}"`,
  (v) => `const options = { aws_secret_access_key: '${v}' };`,
  (v) => `token: ${v}\n`,
  (v) => `{"nested":{"client_secret":"${v}"}}`,
];
embedded.forEach((format, index) => {
  const value = index % 4 === 0
    ? providerTokens[index % providerTokens.length][1](index + 300)
    : tokenBody(index + 300, 30);
  add(`embedded-${index + 1}`, format(value), [value]);
});

// Credentials appear in common database, cache, broker, and service URLs.
const schemes = ['postgres', 'postgresql', 'mysql', 'mariadb', 'redis', 'rediss', 'mongodb', 'mongodb+srv', 'amqp', 'amqps', 'https', 'sftp'];
schemes.forEach((scheme, index) => {
  const user = `svc${index + 1}${tokenBody(index + 400, 8)}`;
  const password = `pw${tokenBody(index + 420, 24)}`;
  add(`url-${index + 1}`, `${scheme}://${user}:${password}@node-${index + 1}.example.invalid/service`, [user, password]);
});

// PEM-shaped private keys with deterministic base64-like bodies.
const pemLabels = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'DSA PRIVATE KEY', 'PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PRIVATE KEY'];
pemLabels.forEach((label, index) => {
  const body = Buffer.from(`C3 synthetic private key fixture ${index + 1} ${tokenBody(index + 500, 24)}`).toString('base64');
  const block = `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
  add(`pem-${index + 1}`, `key material follows:\n${block}\n`, [block, body]);
});

// Base64-like payloads embedded in secret-bearing config fields.
for (let index = 0; index < 12; index++) {
  const value = Buffer.from(`C3 synthetic encoded credential ${index + 1} ${tokenBody(index + 600, 28)}`).toString('base64');
  const key = index % 2 ? 'secret_blob_b64' : 'api_key_b64';
  add(`base64-config-${index + 1}`, `{"${key}":"${value}"}`, [value]);
}

// A second group varies provider prefixes inside realistic surrounding text.
for (let index = 0; index < 12; index++) {
  const [name, make] = providerTokens[index % providerTokens.length];
  const value = make(index + 700);
  const text = index % 3 === 0
    ? `# deployment note\nservice_${index + 1}_token: ${value}\n`
    : index % 3 === 1
      ? `{"provider":"${name}","value":"${value}"}`
      : `const credential${index + 1} = '${value}';`;
  add(`provider-context-${index + 1}`, text, [value]);
}

const negatives = [];
const addNegative = (id, text) => negatives.push({ id, text });

const placeholders = [
  'changeme', 'example', 'none', 'null', 'undefined', 'redacted', 'placeholder', 'xxx', '***', '${API_KEY}', '$SERVICE_TOKEN', 'process.env.SECRET', '<FAKE_SECRET>',
];
placeholders.forEach((value, index) => addNegative(`placeholder-${index + 1}`, `API_KEY=${value}`));

for (let index = 0; index < 12; index++) {
  const hash = (index.toString(16).padStart(2, '0') + 'abcdef0123456789'.repeat(4)).slice(0, 64);
  addNegative(`hash-${index + 1}`, `sha256 ${hash}`);
}

for (let index = 0; index < 12; index++) {
  const uuid = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
  addNegative(`uuid-${index + 1}`, `object id ${uuid}`);
}

for (let index = 0; index < 12; index++) {
  const sha = (index.toString(16).padStart(2, '0') + '0123456789abcdef'.repeat(3)).slice(0, 40);
  addNegative(`git-sha-${index + 1}`, `commit ${sha}`);
}

const ordinary = [
  'documentation describes the configuration workflow in detail',
  'the application stores ordinary preferences in a local file',
  'successful requests produce a useful status summary',
  'the weather forecast changes throughout the afternoon',
  'readable variable names explain the purpose of each function',
  'a comprehensive troubleshooting guide is available for operators',
  'the process completed without additional configuration changes',
  'normalized filenames remain stable across supported platforms',
  'the community maintains examples for common development tasks',
  'several independent services communicate through documented interfaces',
  'ordinary language can contain long descriptive technical explanations',
  'the module provides compatibility with earlier application versions',
];
ordinary.forEach((text, index) => addNegative(`ordinary-prose-${index + 1}`, text));

const documentation = [
  'Example: set API_KEY to <API_KEY> before starting the demo.',
  'Use password: changeme only in local tutorial instructions.',
  'The sample file contains token: ${TOKEN} as a placeholder.',
  'Documentation value: <YOUR_SECRET_HERE>; replace it locally.',
  'A tutorial may show api_key: example without a real credential.',
  'For tests, configure SECRET=$SECRET_NAME in the environment.',
  'The README uses PASSWORD=xxx to mark an empty example value.',
  'An example AWS key is written as <AWS_ACCESS_KEY_ID>.',
  'Set client_secret to process.env.CLIENT_SECRET in source code.',
  'The sample configuration leaves passphrase as undefined.',
  'Placeholder credential: none; no connection is established.',
  'Use the literal redacted marker when demonstrating safe output.',
];
documentation.forEach((text, index) => addNegative(`documentation-${index + 1}`, text));

const nonCredentialUrls = [
  'https://example.invalid/path',
  'postgres://db.example.invalid:5432/app',
  'https://user@host.example.invalid/path',
  'redis://cache.example.invalid/0',
  'sftp://host.example.invalid/archive',
  'amqp://broker.example.invalid/vhost',
  'mongodb+srv://cluster.example.invalid/app',
  'https://host.example.invalid/?user=sample',
  'file:///tmp/example.db',
  'ssh://host.example.invalid/home/you',
  'http://localhost:8080/health',
  'git+https://example.invalid/project.git',
];
nonCredentialUrls.forEach((text, index) => addNegative(`url-without-password-${index + 1}`, text));

const certificates = [
  '-----BEGIN CERTIFICATE-----\nYWJjZGVmZ2hpamtsbW5vcA==\n-----END CERTIFICATE-----',
  '-----BEGIN PUBLIC KEY-----\nYWJjZGVmZ2hpamtsbW5vcA==\n-----END PUBLIC KEY-----',
  '-----BEGIN CERTIFICATE-----\nMDAwMDAwMDAwMDAwMDAwMA==\n-----END CERTIFICATE-----',
  '-----BEGIN PUBLIC KEY-----\nMDEyMzQ1Njc4OWFiY2RlZg==\n-----END PUBLIC KEY-----',
  '-----BEGIN CERTIFICATE-----\nZmFrZSBwdWJsaWMgY2VydA==\n-----END CERTIFICATE-----',
  '-----BEGIN PUBLIC KEY-----\nY2VydGlmaWNhdGUgZXhhbXBsZQ==\n-----END PUBLIC KEY-----',
  '-----BEGIN CERTIFICATE-----\nQUJDREVGR0hJSktMTU5PUA==\n-----END CERTIFICATE-----',
  '-----BEGIN PUBLIC KEY-----\nUHVibGljS2V5RXhhbXBsZQ==\n-----END PUBLIC KEY-----',
  '-----BEGIN CERTIFICATE-----\nY2VydGlmaWNhdGUgZGF0YQ==\n-----END CERTIFICATE-----',
  '-----BEGIN PUBLIC KEY-----\nYW5vdGhlclB1YmxpY0tleQ==\n-----END PUBLIC KEY-----',
  '-----BEGIN CERTIFICATE-----\nZGVtb0NlcnRpZmljYXRl\n-----END CERTIFICATE-----',
  '-----BEGIN PUBLIC KEY-----\nUHVibGljRGF0YVNhbXBsZQ==\n-----END PUBLIC KEY-----',
];
certificates.forEach((text, index) => addNegative(`public-key-material-${index + 1}`, text));

export const positiveHoldout = Object.freeze(positives.map((item) => Object.freeze(item)));
export const negativeHoldout = Object.freeze(negatives.map((item) => Object.freeze(item)));
export const boundaryExamples = Object.freeze({
  openAiAtMinimum: `sk-${'A'.repeat(20)}`,
  openAiBelowMinimum: `sk-${'A'.repeat(19)}`,
  awsAtMinimum: `AKIA${'A'.repeat(16)}`,
  awsBelowMinimum: `AKIA${'A'.repeat(15)}`,
  apiKeyPlaceholder: 'API_KEY=${API_KEY}',
  passwordAssignment: 'password=fixture-value',
  overlapAssignment: 'secret=synthetic-value',
});

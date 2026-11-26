// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanText,
  redact,
  fingerprintSafetyFinding,
  isSafetyFindingAllowed,
} from '../../packages/core/src/safety/index.mjs';

const ids = (text) => scanText(text).map((finding) => finding.ruleId);
const hasRule = (text, id) => ids(text).includes(id);

const B64 = ['aGVsbG8', 'd29ybGQt', 'a2V5', 'MTIzNDU2', 'Nzg5MDEy', 'MzQ1Njc4', 'OTA=='].join('');
const SIG = ['Qm9', 'ydGVz', 'dC1z', 'aWc', 'MTIz', 'NDU2', 'Nzg5'].join('');

function tckn(first9) {
  const d = [...first9].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8],
    even = d[1] + d[3] + d[5] + d[7];
  const d10 = (((odd * 7 - even) % 10) + 10) % 10;
  const d11 = [...d, d10].reduce((a, b) => a + b, 0) % 10;
  return `${first9}${d10}${d11}`;
}
function trIban(bban, check = null) {
  const rest = `${bban}292700`;
  let mod = 0;
  for (const ch of rest) mod = (mod * 10 + Number(ch)) % 97;
  const cd = check ?? String(98 - mod).padStart(2, '0');
  return `TR${cd}${bban}`;
}

test('Azure storage and Service Bus connection strings are secret findings', () => {
  assert.ok(
    hasRule(
      `DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=${B64};EndpointSuffix=core`,
      'azure-storage-key'
    )
  );
  assert.ok(
    hasRule(
      `Endpoint=sb://demo.servicebus.example/;SharedAccessKeyName=ops;SharedAccessKey=${B64}`,
      'azure-storage-key'
    )
  );
  assert.ok(
    hasRule(`https://demo.blob.example/c?SharedAccessSignature=sv=2021-06-08&ss=b&sig=${SIG}%3D`, 'azure-sas-token')
  );
  assert.ok(hasRule(`SharedAccessSignature=sv=2021-06-08&se=2030-01-01&sr=b&sig=${SIG}`, 'azure-sas-token'));
  for (const text of [
    'AccountKey=<key>',
    'AccountKey=${AZURE_KEY}',
    'SharedAccessKeyName=ops',
    'AccountKey=' + 'x'.repeat(88),
    'SharedAccessSignature=sv=2021-06-08&sig=<signature>',
    'AccountKey=short',
  ]) {
    assert.equal(hasRule(text, 'azure-storage-key') || hasRule(text, 'azure-sas-token'), false, text);
  }
});

test('Authorization Bearer tokens need realistic length and a digit; placeholders are excluded', () => {
  const token = ['a1B2c3D4', 'e5F6g7H8', 'i9J0kL1m', 'N2o3P4q5'].join('');
  assert.ok(hasRule(`curl -H "Authorization: Bearer ${token}" https://api.example.test`, 'bearer-token'));
  assert.ok(hasRule(`authorization: bearer ${token}`, 'bearer-token'));
  for (const text of [
    'Authorization: Bearer ${TOKEN}',
    'Authorization: Bearer <token>',
    'Authorization: Bearer ACCESS_TOKEN_VALUE',
    'Authorization: Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1',
    'Bearer ' + token,
    'Authorization: Basic ' + token,
  ]) {
    assert.equal(hasRule(text, 'bearer-token'), false, text);
  }
});

test('GitLab personal access tokens are exactly glpat- plus 20 characters', () => {
  const token = ['gl', 'pat-', 'aB3dE5fG', '7hJ9kL1m', 'N2pQ'].join('');
  assert.ok(hasRule(`token = "${token}"`, 'gitlab-pat'));
  const short = token.slice(0, -1),
    suffixed = token + '-';
  for (const text of [short, 'glpat-${GITLAB_TOKEN}', 'glpat-' + 'x'.repeat(20), suffixed]) {
    assert.equal(hasRule(text, 'gitlab-pat'), false, text);
  }
});

test('Azure DevOps PAT needs Azure, ADO or PAT context; bare 52-character strings stay quiet', () => {
  const pat = ['abcdefgh', 'ijklmnop', 'qrstuvwx', 'yz234567', 'abcdefghijklmnopqrst'].join('');
  assert.equal(pat.length, 52);
  assert.ok(hasRule(`azure_devops_pat: "${pat}"`, 'azure-devops-pat'));
  assert.ok(hasRule(`ADO_PAT=${pat}`, 'azure-devops-pat'));
  assert.ok(hasRule(`https://:${pat}@dev.azure.com/contoso/_git/app`, 'azure-devops-pat'));
  assert.equal(hasRule(`commit ${pat}`, 'azure-devops-pat'), false);
  assert.equal(hasRule(`patient_id: "${pat}"`, 'azure-devops-pat'), false);
  assert.equal(hasRule(`azure_devops_pat: "${pat.slice(1)}"`, 'azure-devops-pat'), false);
  assert.equal(hasRule(`ADO_PAT=\${ADO_PAT}`, 'azure-devops-pat'), false);
});

test('Turkish assignment keys sifre, şifre and parola are explicit secret keys', () => {
  const value = ['Xy7p', 'Q2mK', '9zL3'].join('');
  assert.ok(hasRule(`şifre: "${value}"`, 'secret-assignment'));
  assert.ok(hasRule(`sifre = "${value}"`, 'secret-assignment'));
  assert.ok(hasRule(`db_parola: ${value}`, 'secret-assignment'));
  assert.ok(hasRule(`parola: "${value}"`, 'secret-assignment'));
  assert.ok(hasRule(`db_sifre: "${value}"`, 'secret-assignment'));
  for (const text of [
    'şifre: "<şifre>"',
    'parola: ${PAROLA}',
    'şifre: changeme',
    'sifreleme_yontemi: "AES256"',
    'sifre_kurali: "uzun"',
    'kullanici: "ayse"',
  ]) {
    assert.equal(hasRule(text, 'secret-assignment'), false, text);
  }
});

test('TCKN is a personal finding only when the official check digits agree', () => {
  const valid = tckn('123456789');
  assert.equal(valid.length, 11);
  assert.equal(scanText(`kimlik ${valid} kayıt`).find((f) => f.ruleId === 'tckn')?.kind, 'personal');
  const bad = `${valid.slice(0, 10)}${(Number(valid[10]) + 1) % 10}`;
  assert.equal(hasRule(`kimlik ${bad}`, 'tckn'), false);
  assert.equal(hasRule(`id 0${valid.slice(1)}`, 'tckn'), false, 'leading zero is not a TCKN');
  assert.equal(hasRule(`id ${valid}0`, 'tckn'), false, 'longer digit runs are not a TCKN');
  assert.equal(hasRule(`build 12345678901`, 'tckn'), false);
});

test('TR IBAN is a personal finding only with ISO 13616 mod-97 agreement, spaced or not', () => {
  const bban = '1234567890123456789012';
  const iban = trIban(bban);
  assert.equal(scanText(`hesap ${iban}`).find((f) => f.ruleId === 'tr-iban')?.kind, 'personal');
  const spaced = iban.replace(/(.{4})/g, '$1 ').trim();
  assert.ok(hasRule(`hesap ${spaced}`, 'tr-iban'));
  const wrongCheck = trIban(bban, String((Number(iban.slice(2, 4)) + 1) % 100).padStart(2, '0'));
  assert.equal(hasRule(`hesap ${wrongCheck}`, 'tr-iban'), false);
  assert.equal(hasRule(`ref TR${bban}`, 'tr-iban'), false, 'missing check digits');
});

test('TCKN and IBAN findings are redacted in output and reported by scanText (write block)', () => {
  const valid = tckn('123456789');
  assert.equal(redact(`kimlik ${valid}`), 'kimlik [REDACTED:tckn]');
  const iban = trIban('1234567890123456789012');
  assert.equal(redact(`hesap ${iban}`), 'hesap [REDACTED:tr-iban]');
  assert.ok(scanText(`kimlik ${valid}`).length > 0, 'scanText must report the finding so writes are refused');
});

test('fingerprints accept personal findings the same way as content findings', () => {
  const text = `kimlik ${tckn('123456789')}`;
  const finding = scanText(text).find((f) => f.ruleId === 'tckn');
  const fingerprint = fingerprintSafetyFinding('wiki/concepts/id.md', text, finding);
  assert.equal(isSafetyFindingAllowed('wiki/concepts/id.md', text, finding, [fingerprint]), true);
});

test('contact data (e-mail, TR phone) is redacted only when the output option is requested', () => {
  const mail = ['ornek.kisi', '@', 'example.com'].join('');
  const phone = '+90 ' + '5' + '32 000 00 00';
  const local = '0' + '5' + '32' + '0000000';
  const text = `iletisim ${mail} veya ${phone} ya da ${local}`;
  assert.deepEqual(
    scanText(text)
      .map((f) => f.ruleId)
      .filter((id) => ['email', 'tr-phone'].includes(id)),
    []
  );
  const out = redact(text, { personal: true });
  assert.ok(!out.includes(mail) && !out.includes('532 000'), out);
  assert.match(out, /\[REDACTED:email\]/);
  assert.match(out, /\[REDACTED:tr-phone\]/);
  assert.equal(redact(text), text, 'default redact keeps contact data');
});

test('contact redaction leaves versions, dates, ids and hashes alone', () => {
  const text = [
    'v0.1.0-rc.10',
    '2026-11-12',
    '20261112',
    '1234567890',
    '20261112123',
    'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2',
    '123e4567-e89b-12d3-a456-426614174000',
    'pkg@1.2.3',
    'npm install @scope/pkg',
  ].join(' ');
  assert.equal(redact(text, { personal: true }), text);
});

test('fix1: a Turkish secret in a URL query string is a finding; the scheme does not hide it', () => {
  const value = ['Xq7r', 'T2mP', '9kL4', 'zB8w'].join('');
  const host = ['https://ornek', '.example/giris'].join('');
  assert.ok(hasRule(`${host}?sifre=${value}`, 'secret-assignment'), 'query sifre');
  assert.ok(hasRule(`${host}?user=ali&parola=${value}`, 'secret-assignment'), 'second query parameter');
  assert.ok(hasRule(`${host}#password=${value}`, 'secret-assignment'), 'fragment password');
  assert.ok(hasRule(`${host};sifre=${value}`, 'secret-assignment'), 'matrix parameter');
  assert.ok(hasRule(`${host}?password=${value}`, 'secret-assignment'), 'query password');
  assert.ok(
    hasRule(`${host}?token=${value}`, 'high-entropy-assignment') ||
      hasRule(`${host}?token=${value}`, 'secret-assignment'),
    'query token'
  );
  assert.ok(hasRule(`https://ali:${value}@ornek.example/`, 'connection-credentials'));
});

test('fix1: query parameters that only look secret-like are not findings', () => {
  const host = ['https://ornek', '.example/liste'].join('');
  for (const tail of [
    '?token_count=5',
    '?page=2',
    '?password_policy=strict',
    '?max_tokens=700',
    '?sifreleme_yontemi=AES256',
    '?sifre=<sifre>',
    '?password=${DB_PASSWORD}',
    '?token=',
    '?sort=name&order=asc',
  ]) {
    assert.equal(
      hasRule(host + tail, 'secret-assignment') || hasRule(host + tail, 'high-entropy-assignment'),
      false,
      tail
    );
  }
});

test('fix1: upper-case Turkish keys match with the dotted capital İ and the dotless ı', () => {
  const value = ['Abc1', '2345'].join('');
  assert.ok(hasRule(`ŞİFRE: ${value}`, 'secret-assignment'), 'ŞİFRE');
  assert.ok(hasRule(`DB_ŞİFRE="${value}"`, 'secret-assignment'), 'DB_ŞİFRE');
  assert.ok(hasRule(`PAROLA=${value}`, 'secret-assignment'), 'PAROLA');
  assert.equal(hasRule(`ŞİFRELEME_YÖNTEMİ: AES256`, 'secret-assignment'), false, 'ŞİFRELEME_YÖNTEMİ');
});

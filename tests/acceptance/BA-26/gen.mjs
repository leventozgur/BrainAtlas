// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEED = 0xba26;
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(SEED);
const pick = (s) => s[Math.floor(rand() * s.length)];
const str = (n, alpha) => Array.from({ length: n }, () => pick(alpha)).join('');
const digits = (n) => str(n, '0123456789');
const uniform = (s) => /^(.)\1*$/.test(s);
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64 = ALNUM + '+/';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const HEX = '0123456789abcdef';
const PW = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!#-';
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const pad2 = (n) => String(n).padStart(2, '0');

function tckn(first9) {
  const n = [...first9].map(Number);
  const odd = n[0] + n[2] + n[4] + n[6] + n[8],
    even = n[1] + n[3] + n[5] + n[7];
  const d10 = (((odd * 7 - even) % 10) + 10) % 10;
  const d11 = [...n, d10].reduce((a, b) => a + b, 0) % 10;
  return first9 + d10 + d11;
}
function tcknOk(s) {
  if (!/^[1-9][0-9]{10}$/.test(s)) return false;
  const n = [...s].map(Number);
  const odd = n[0] + n[2] + n[4] + n[6] + n[8],
    even = n[1] + n[3] + n[5] + n[7];
  return (((odd * 7 - even) % 10) + 10) % 10 === n[9] && n.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === n[10];
}
function iban(bban) {
  const check = 98 - Number(BigInt(bban + '292700') % 97n);
  return 'TR' + pad2(check) + bban;
}
function ibanOk(s) {
  const c = s.replace(/ /g, '');
  if (!/^TR[0-9]{24}$/.test(c)) return false;
  const r = c.slice(4) + c.slice(0, 4);
  const numeric = [...r].map((ch) => (ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch)).join('');
  return BigInt(numeric) % 97n === 1n;
}
const spaced = (compact) =>
  compact.slice(0, 4) +
  ' ' +
  compact
    .slice(4)
    .match(/.{1,4}/g)
    .join(' ');
const validTckn = () => tckn(String(1 + Math.floor(rand() * 9)) + digits(8));
const validIban = () => iban(digits(22));
const fresh = (gen) => {
  for (;;) {
    const v = gen();
    if (!uniform(v)) return v;
  }
};

const POS = [
  {
    cat: 'azure-storage-key',
    rule: 'azure-storage-key',
    value: (i) => (i % 2 ? 'SharedAccessKey=' : 'AccountKey=') + fresh(() => str(86, B64)) + '==',
    tpl: [
      'connectionString: "DefaultEndpointsProtocol=https;AccountName=stg01;V;EndpointSuffix=core.windows.net"',
      '| storage | DefaultEndpointsProtocol=https;AccountName=stg01;V |',
      '```\nV\n```',
      'Yedek bağlantı dizesi V biçiminde kayıtlı, kullanmayın.',
      'AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=stg01;V',
      'https://stg01.blob.core.windows.net/?V',
    ],
  },
  {
    cat: 'azure-sas-token',
    rule: 'azure-sas-token',
    value: () => 'sv=2021-08-06&ss=b&srt=sco&sp=rl&se=2030-01-01T00:00:00Z&sig=' + fresh(() => str(43, B64)) + '=',
    tpl: [
      'connectionString: "BlobEndpoint=https://stg01.blob.core.windows.net/;V;EndpointSuffix=core.windows.net"',
      '| sas | V |',
      '```\nV\n```',
      'Paylaşım bağlantısı V şeklindedir, dağıtmayın.',
      'SAS_QUERY=V',
      'https://stg01.blob.core.windows.net/c/a.txt?V',
    ],
  },
  {
    cat: 'bearer-token',
    rule: 'bearer-token',
    value: () => 'Authorization: Bearer ' + 'a1' + str(38, ALNUM + '._-'),
    tpl: [
      '  headers: V',
      '| header | V |',
      '```\nV\n```',
      'Çağrıda V başlığını gönderin.',
      'API_HEADER=V',
      'curl -H "V" https://api.example.com/v1/pages',
    ],
  },
  {
    cat: 'gitlab-pat',
    rule: 'gitlab-pat',
    value: () => 'glpat-' + fresh(() => str(20, ALNUM + '_-')),
    tpl: [
      'gitlab_token: "V"',
      '| gitlab | V |',
      '```\nV\n```',
      'Yeni erişim anahtarı V olarak verildi.',
      'GITLAB_TOKEN=V',
      'https://gitlab.example.com/api/v4/user?private_token=V',
    ],
  },
  {
    cat: 'azure-devops-pat',
    rule: 'azure-devops-pat',
    value: () => fresh(() => str(52, B32)),
    tpl: [
      'azure_devops_pat: "V"',
      '| ado.pat=V |',
      '```\nAZURE_PAT=V\n```',
      'Azure DevOps için pat: V değerini kullanın.',
      'ADO_PAT=V',
      'https://user:V@dev.azure.com/org/proj',
    ],
  },
  {
    cat: 'secret-assignment-tr',
    rule: 'secret-assignment',
    value: () => pick(LETTERS) + fresh(() => str(11, PW)),
    tpl: [
      'sifre: "V"',
      '| şifre=V |',
      '```\nparola = V\n```',
      'Hesap ayarında şifre=V olarak tanımlı.',
      'DB_PAROLA=V',
      'https://ornek.example/giris?sifre=V',
    ],
  },
  {
    cat: 'tckn',
    rule: 'tckn',
    value: () => validTckn(),
    tpl: [
      'TCKN: "V"',
      '| TCKN | V |',
      '```\nV\n```',
      'Müşteri TCKN V olarak kayıtlı.',
      'TCKN=V',
      'https://ornek.example/kayit?tckn=V',
    ],
  },
  {
    cat: 'tr-iban',
    rule: 'tr-iban',
    value: (i) => (i % 2 ? validIban() : spaced(validIban())),
    tpl: [
      'iban: "V"',
      '| IBAN | V |',
      '```\nV\n```',
      'Havale için IBAN V kullanın.',
      'IBAN=V',
      'https://ornek.example/odeme?iban=V',
    ],
  },
];
const CONTACT = [
  {
    cat: 'email',
    rule: 'email',
    value: (i) =>
      'ali.' + str(4, 'abcdefghijklmnop') + digits(2) + '@' + (i % 2 ? 'ornek.example' : 'mail.example.com'),
    tpl: ['contact: "V"', '| e-posta | V |', '```\nV\n```', 'Bize V adresinden ulaşın.', 'SUPPORT_EMAIL=V', 'mailto:V'],
  },
  {
    cat: 'tr-phone',
    rule: 'tr-phone',
    value: (i) => {
      const area = '5' + digits(2);
      const f = [
        `0${area} ${digits(3)} ${digits(2)} ${digits(2)}`,
        `+90 ${area} ${digits(3)} ${digits(2)} ${digits(2)}`,
        `0${area}-${digits(3)}-${digits(2)}-${digits(2)}`,
        `0${area}${digits(7)}`,
        `+90 (${area}) ${digits(3)} ${digits(2)} ${digits(2)}`,
      ];
      return f[(i * 3 + Math.floor(rand() * 5)) % 5];
    },
    tpl: ['tel: "V"', '| telefon | V |', '```\nV\n```', 'Bize V numarasından ulaşın.', 'PHONE=V', 'tel:V'],
  },
];

const CODE = [
  'const total = items.reduce((sum, item) => sum + item.price, 0);',
  "import { readFile } from 'node:fs/promises';",
  'export function clamp(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }',
  'const maxTokens = 4096;',
  'const tokenLimit = 8192;',
  'const tokenCount = countTokens(text);',
  "SELECT id, title FROM pages WHERE status = 'confirmed' LIMIT 20;",
  'for (let i = 0; i < 10; i++) { console.log(i); }',
  'const re = /^[A-Z]{3}[0-9]{4}$/;',
  "if (!response.ok) throw new Error('HTTP ' + response.status);",
  'type Page = { path: string; title: string; verified?: string[] };',
  'const timeoutMs = 4700;',
  "router.get('/pages/:id', async (req, res) => res.json(await load(req.params.id)));",
  'git log --oneline -n 5',
  'const { items, total } = await store.load();',
];
const SIFRE = [
  'Şifre sıfırlama adımlarını izleyin.',
  'Şifre politikası en az on iki karakter gerektirir.',
  'Parola değişikliği kayda alındı.',
  'Şifre yenileme bağlantısı e-posta ile gönderildi.',
  'Kullanıcı şifresini unuttuğunda destek ekibine ulaşır.',
  'Bu sayfada şifre kelimesi yalnızca bağlam için geçer.',
  'Şifre ve parola kavramları aynı sayfada açıklanır.',
  'Güvenlik ekibi şifre rotasyonunu üç ayda bir planlar.',
  'Bearer kimlik doğrulaması OAuth akışını kullanır.',
  'Şifre sıfırlama: adımlar ayrı sayfada.',
];
const PLACEHOLDERS = [
  'Authorization: Bearer <token>',
  'Authorization: Bearer ${TOKEN}',
  'Authorization: Bearer ${API_TOKEN}',
  'password: changeme',
  'password: <password>',
  'şifre: ***',
  'parola: ********',
  'sifre=xxxxxxxxxxxx',
  'AccountKey=<account-key>',
  'sv=2021-08-06&sig=<signature>',
  'token: <your-token>',
  'password: ${DB_PASSWORD}',
  'password: process.env.DB_PASSWORD',
  'password: $DB_PASSWORD',
  'password: "example"',
  'password: null',
  'password: redacted',
  'glpat-xxxxxxxxxxxxxxxxxxxx',
  'SharedAccessKey=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
];
const clean = {
  code: (i) => `${CODE[i % CODE.length]} // v${i}`,
  uuid: () => `${str(8, HEX)}-${str(4, HEX)}-4${str(3, HEX)}-${pick('89ab')}${str(3, HEX)}-${str(12, HEX)}`,
  githash: (i) => (i % 2 ? `commit ${str(40, HEX)}` : `rev ${str(7, HEX)}`),
  base64: () => `data:image/png;base64,${str(160, B64)}`,
  version: (i) => [`0.1.0-rc.${i % 20}`, `v1.${i}.0`, `node >=20.${i % 10}`, `2026.11.${10 + (i % 18)}`][i % 4],
  date: (i) =>
    [
      `2026-11-${pad2(1 + (i % 28))}`,
      `2026-11-${pad2(1 + (i % 28))}T10:${pad2(i % 60)}:00Z`,
      `${pad2(1 + (i % 28))}.11.2026 14:${pad2(i % 60)}`,
    ][i % 3],
  badTckn: (i) => {
    const n = [...validTckn()];
    const k = i % 2 ? 10 : 9;
    n[k] = String((Number(n[k]) + 1 + (i % 8)) % 10);
    const s = n.join('');
    if (tcknOk(s)) throw new Error('generator: altered TCKN candidate unexpectedly valid');
    return `Sipariş kayıt kodu: ${s}`;
  },
  badIban: (i) => {
    const v = validIban();
    const check = (Number(v.slice(2, 4)) + 1 + (i % 5)) % 100;
    const s = 'TR' + pad2(check) + v.slice(4);
    if (ibanOk(s)) throw new Error('generator: altered IBAN candidate unexpectedly valid');
    return i % 2 ? spaced(s) : s;
  },
  placeholder: (i) => PLACEHOLDERS[i % PLACEHOLDERS.length],
  order: (i) =>
    [
      `Sipariş no: SP-2026-${digits(6)}`,
      `Fatura numarası 2026${digits(10)}`,
      `order_id: ${digits(10)}`,
      `INV-${digits(8)}`,
      `Fatura no: FTR${digits(12)}`,
      `Sipariş kodu ${digits(10)} onaylandı.`,
    ][i % 6],
  sifre: (i) => `${SIFRE[i % SIFRE.length]} (${i})`,
};
const CLEAN_CATS = Object.keys(clean);
const CLEAN_PER_CAT = 30;
const WRAP = [(t) => t, (t) => '```\n' + t + '\n```', (t) => t, (t) => `| ${t} |`];

function build() {
  const positives = [],
    contacts = [],
    cleanItems = [];
  for (const p of POS) {
    for (let i = 0; i < 12; i++) {
      const v = p.value(i);
      const t = p.tpl[i % 6];
      positives.push({
        id: `P-${p.cat}-${String(i).padStart(2, '0')}`,
        set: 'pos',
        cat: p.cat,
        fmt: i % 6,
        expected: p.rule,
        value: v,
        text: t.replace('V', v),
      });
    }
  }
  for (const c of CONTACT) {
    for (let i = 0; i < 12; i++) {
      const v = c.value(i);
      const t = c.tpl[i % 6];
      contacts.push({
        id: `C-${c.cat}-${String(i).padStart(2, '0')}`,
        set: 'contact',
        cat: c.cat,
        fmt: i % 6,
        expected: c.rule,
        value: v,
        text: t.replace('V', v),
      });
    }
  }
  for (const cat of CLEAN_CATS) {
    for (let i = 0; i < CLEAN_PER_CAT; i++) {
      const base = clean[cat](i);
      cleanItems.push({
        id: `K-${cat}-${String(i).padStart(2, '0')}`,
        set: 'clean',
        cat,
        fmt: i % 4,
        expected: null,
        text: WRAP[i % 4](base),
      });
    }
  }
  return { positives, contacts, cleanItems };
}

function checkSlots() {
  for (const p of [...POS, ...CONTACT])
    for (const t of p.tpl) {
      const slots = t.split('V').length - 1;
      if (slots !== 1) throw new Error(`template slot count ${slots} for ${p.cat}`);
    }
}

export function fixtures() {
  checkSlots();
  return build();
}
export function labelsOf(items) {
  return items.map(({ id, set, cat, fmt, expected }) => ({ id, set, cat, fmt, expected }));
}
export function digestOf(labels) {
  return createHash('sha256').update(JSON.stringify(labels)).digest('hex');
}

if (process.argv[2] === '--freeze') {
  const { positives, contacts, cleanItems } = fixtures();
  const all = [...positives, ...contacts, ...cleanItems];
  const labels = labelsOf(all);
  const counts = {};
  for (const it of all) counts[`${it.set}:${it.cat}`] = (counts[`${it.set}:${it.cat}`] ?? 0) + 1;
  const out = { frozen: 'before first product run', seed: SEED, digest: digestOf(labels), counts, labels };
  writeFileSync(fileURLToPath(new URL('./labels.json', import.meta.url)), JSON.stringify(out, null, 2) + '\n');
  console.log(`frozen ${labels.length} labels, digest ${out.digest}`);
}

// SPDX-License-Identifier: MIT
// Deterministic generator for the BA-27 long-page dev set: eval/corpus-longpage (7 pages of 40 to 75 KB, many H2/H3
// sections, dated updates) and eval/dev/longpage-cases.json (one case per selected H3 section, expectedHeading set).
// Every H3 section carries a unique fictional codename (no digits); each case queries that codename plus the aspect word,
// so the expected section is the one that holds the codename. Run: node eval/gen/longpage.mjs
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRng } from '../lib/synthetic-corpus.mjs';

const SEED = 27;
const H2_TOPICS = [
  'Altyapı ve kapasite',
  'Kota ve sınırlar',
  'Veri saklama',
  'Olay yönetimi',
  'Dağıtım hattı',
  'Gözlemlenebilirlik',
  'Güvenlik kontrolleri',
  'Maliyet takibi',
  'Sürüm geçmişi',
  'Entegrasyonlar',
  'Operasyon takvimi',
  'Test stratejisi',
  'Erişim denetimi',
  'Yedekleme',
];
const ASPECTS = ['Güncel ayar', 'Önceki değer', 'Sınır ve istisnalar', 'Sorumlu ekip', 'Denetim notu', 'Tarihçe'];
const NOUNS = [
  'kapasite',
  'istek',
  'kayıt',
  'sürüm',
  'yedek',
  'izleme',
  'eşik',
  'pencere',
  'denetim',
  'ekip',
  'değer',
  'politika',
  'gecikme',
  'bellek',
  'disk',
  'kuyruk',
  'tablo',
  'uç nokta',
  'paket',
  'oturum',
];
const VERBS = ['izlenir', 'güncellenir', 'sınanır', 'onaylanır', 'raporlanır', 'kapatılır', 'yeniden hesaplanır'];
const SENTENCES = [
  (c, a, b, n) => `${c} için ${a} ${b} değeri ${n} olarak kayıtlıdır.`,
  (c, a, b, n) => `Bu bölümde ${c} ile ilgili ${a} kararı, ${b} alanının sınırına göre belirlenir.`,
  (c, a, b, n) => `${a} tarafındaki ${b} ayarı, ${c} kapsamında en fazla ${n} birim olarak uygulanır.`,
  (c, a, b, n) => `Eski ${a} değeri ${n} idi; ${c} için ${b} tekrar gözden geçirildi.`,
  (c, a, b, n) => `${c} sorumluluğu ${a} ekibine aittir ve ${b} sonuçları ayrıca tutulur.`,
  (c, a, b, n) => `Bir istisna gerekirse ${c} için ${a} onayı alınmadan ${b} değiştirilmez.`,
];

// Codenames: three syllable groups, no digits, unique across the whole corpus.
const CODE_A = [
  'Brev',
  'Dravo',
  'Kelv',
  'Mirnu',
  'Sabor',
  'Tilo',
  'Varnok',
  'Xeri',
  'Yulk',
  'Zenta',
  'Ombra',
  'Fenro',
  'Quelm',
  'Hasvi',
];
const CODE_B = ['ik', 'ana', 'ose', 'ulm', 'ter', 'qin', 'pad', 'ven', 'orm', 'ila'];
const CODE_C = ['ar', 'el', 'im', 'ol', 'ur', 'as', 'eth'];

// Page plan: H2 count and H3 per H2. Every eighth section (in document order) becomes a case.
const PLAN = [
  { h2: 10, h3: 3 },
  { h2: 12, h3: 3 },
  { h2: 14, h3: 3 },
  { h2: 10, h3: 4 },
  { h2: 12, h3: 4 },
  { h2: 14, h3: 4 },
  { h2: 11, h3: 4 },
];

function codenames(rng) {
  const seen = new Set();
  return () => {
    for (;;) {
      const name = `${CODE_A[Math.floor(rng() * CODE_A.length)]}${CODE_B[Math.floor(rng() * CODE_B.length)]}${CODE_C[Math.floor(rng() * CODE_C.length)]}`;
      if (!seen.has(name)) {
        seen.add(name);
        return name;
      }
    }
  };
}

function paragraph(rng, codename) {
  const count = 5 + Math.floor(rng() * 3);
  const sentences = [];
  for (let i = 0; i < count; i++) {
    const make = SENTENCES[Math.floor(rng() * SENTENCES.length)];
    const noun = NOUNS[Math.floor(rng() * NOUNS.length)];
    const noun2 = NOUNS[Math.floor(rng() * NOUNS.length)];
    sentences.push(make(codename, noun, noun2, 10 + Math.floor(rng() * 9000)));
    if (rng() < 0.4)
      sentences.push(
        `${noun2[0].toUpperCase()}${noun2.slice(1)} kayıtları ay sonunda ${VERBS[Math.floor(rng() * VERBS.length)]}.`
      );
  }
  return sentences.join(' ');
}

/** Build every page and case. Pure function of SEED, so repeated runs give identical bytes. */
export function buildLongpage() {
  const rng = createRng(SEED);
  const nextName = codenames(rng);
  const files = {};
  const cases = [];
  PLAN.forEach((plan, pageIndex) => {
    const rel = `lp-${String(pageIndex + 1).padStart(2, '0')}.md`;
    const parts = [
      `# Uzun sayfa ${String(pageIndex + 1).padStart(2, '0')}\n\nBu sayfa bölümleri uzun bir operasyon kılavuzunun parçalarını taşır. Her üçüncü veya dördüncü bölümde tarihli bir güncelleme bulunur.\n`,
    ];
    for (let h2 = 0; h2 < plan.h2; h2++) {
      const topic = H2_TOPICS[(h2 + pageIndex) % H2_TOPICS.length];
      parts.push(
        `\n## ${topic} (bölüm ${h2 + 1})\n\nBu başlık altında ${topic.toLowerCase()} ile ilgili ayrıntılar yer alır.\n`
      );
      for (let h3 = 0; h3 < plan.h3; h3++) {
        const aspect = ASPECTS[(h2 + h3) % ASPECTS.length];
        const codename = nextName();
        const heading = `${aspect}: ${codename}`;
        const body = [0, 1, 2].map(() => paragraph(rng, codename));
        if (rng() < 0.5) {
          const day = String(1 + Math.floor(rng() * 28)).padStart(2, '0');
          const month = String(1 + Math.floor(rng() * 12)).padStart(2, '0');
          body.push(
            `Güncelleme 2026-${month}-${day}: ${codename} için önceki değer yeni tabloya taşındı ve eski kayıt arşivlendi.`
          );
        }
        parts.push(`\n### ${heading}\n\n${body.join('\n\n')}\n`);
        if ((h2 * plan.h3 + h3) % 8 === 0) {
          cases.push({
            id: `lp-${String(pageIndex + 1).padStart(2, '0')}-${String(cases.length + 1).padStart(3, '0')}`,
            kind: 'knowledge',
            category: 'longpage',
            query: `${codename} ${aspect.toLowerCase()}`,
            relevant: [rel],
            expectedHeading: heading,
          });
        }
      }
    }
    const text = `---\ntitle: "Uzun sayfa ${String(pageIndex + 1).padStart(2, '0')}"\nstatus: "active"\ngenerated: "2026-09-30"\n---\n${parts.join('')}`;
    files[rel] = text;
  });
  return { files, cases };
}

/** Write the corpus and the case file into an eval directory (default: this package's eval root). */
export function writeLongpage(evalRoot) {
  const { files, cases } = buildLongpage();
  const corpus = join(evalRoot, 'corpus-longpage');
  rmSync(corpus, { recursive: true, force: true });
  mkdirSync(corpus, { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(corpus, rel), text, 'utf8');
  mkdirSync(join(evalRoot, 'dev'), { recursive: true });
  writeFileSync(join(evalRoot, 'dev', 'longpage-cases.json'), `${JSON.stringify(cases, null, 2)}\n`, 'utf8');
  return { pages: Object.keys(files).length, cases: cases.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(writeLongpage(evalRoot)));
}

# BA eval notları

## expectedHeading kuralı (`eval/dev/current-state-cases.json`)
`expectedHeading`, sorulan konunun en yeni GEÇERLİ bölümüdür. Sayfanın en yeni tarihli bölümü başka bir konuyu güncelliyorsa o bölüm değildir; sorulan konuya ait en yeni bölüm seçilir. Başlık metni tam olmalı (`#` olmadan) ve sayfada bir başlık satırı olarak bulunmalıdır; `ba00-dev-sets` testi bunu doğrular.

## hybridOverheadMs (`eval/scale-bench.mjs`)
`hybridOverheadMs`, fusion ek maliyeti değil; MCP hibrit yolundaki sorgu başı TOPLAM süredir: `loadPages` + `searchHybrid` (içinde `buildIndex` dahil), sahte provider ile. Anahtar adı bilinçli olarak korunmuştur.

## Vaka şeması (BA-27, geriye uyumlu)
Her vaka `id` (`[\w-]{1,64}`, set içinde benzersiz), `query` (boş olmayan metin) ve `relevant` (korpus-göreli yollar; boş olabilir) alır. Eski alanlar (`abstain`, `category`, `expectedHeading`, `requireAll`, `trToEn`, `excluded`) aynen çalışır. Yeni alanların hepsi opsiyoneldir:

| Alan | Anlam |
|---|---|
| `kind` | `knowledge` (varsayılan) \| `operational` \| `followup` \| `long-brief` \| `pasted-error`. `operational` (bilgi gerektirmeyen prompt: "devam et", "commit and push", "evet", "testleri koş") vakalarda `abstain: true` zorunludur; bu vakalarda **herhangi bir** enjeksiyon yanlış enjeksiyondur (`falseInjectionRate`). |
| `cwd` | Mutlak, kullanıcı yolu olmayan çalışma dizini (`/srv/work/<proje>`). Hook stdin'ine `cwd` olarak geçer; ürün bugün okumaz. |
| `project` | Beklenen proje etiketi (proje dizin adı). `relevant[0]` bu dizinin altında olmalı ve `cwd`'nin son parçası aynı olmalı. |
| `expectedHeading` | Bölüm isabeti için beklenen başlık (`#` olmadan). `relevant[0]` sayfasında bir başlık satırı olarak bulunmalı; `current-state` kuralıyla aynı (en yeni geçerli bölüm). |

**`poison` bir vaka alanı değildir.** Talimat-benzeri içerik taşıyan sayfa, korpus sayfası frontmatter'ında `eval_poison: true` ile işaretlenir; ürün bu alanı bilmez. Vaka dosyasında `poison` anahtarı doğrulayıcı tarafından reddedilir.

**Korpus meta sayfaları.** Kökteki opsiyonel `eval-meta.json` (`{"meta": ["index.md", "log.md", "AGENTS.md", "planning/**", "archive/**"]}`) glob listesidir: `**` dizinleri geçer, `*` ve `?` geçmez. Dosya yoksa varsayılan: kökteki `index.md`, `log.md`, `AGENTS.md`, `CLAUDE.md`. Meta sayfa oranı (`metaShareTop5`) yalnız ilk beş enjekte bloğa bakar.

**Doğrulayıcı.** `eval/lib/case-schema.mjs` (`validateCase`) tek vakayı, `tests/eval/ba27-schema.test.mjs` yardımcı fonksiyonları, `tests/eval/ba27-dev-sets.test.mjs` tüm BA-27 dev setlerini sınar.

## Hook metrikleri (BA-27 ekleri)
Mevcut anahtarlar (`n`, `injectionRate`, `injectionPrecision`, `missRate`, `falseInjectionRate`, `chars`, `durationMs`, `byCategory`) aynen kalır. Eklenenler:
- `falseInjectionRate`: `abstain` veya `kind: operational` vakalarda en az bir sayfa enjekte edilen vakaların oranı. `byKind` her tür için `n`, `injectionRate`, `missRate`, `precision`, `falseInjectionRate` verir.
- `injectedChars`: `chars` ile aynı kaynak (`{mean, p50, p95}`).
- `charsPerHit`: toplam enjekte karakter / ilgili sayfası enjekte edilen vaka sayısı.
- `neededPageInjected`: cevaplanabilir vakalarda ilgili sayfalardan en az biri enjekte edilen oran (`1 - missRate` ile aynı tanım; ek alan olarak raporlanır).
- `metaShareTop5`: enjekte edilen ilk 5 blokta meta sayfa oranı (vaka sayılarından bağımsız havuzlanmış oran).
- `sectionHitAt1`, `sectionCases`, `sectionHitSources`: `expectedHeading` olan vakalarda, ilk ilgili enjekte bloğun başlık satırı beklenen başlıkla aynıysa isabet. Hook çıktısında bölüm adı yoksa (`sectionSource: "search"`), aynı sorgunun çekirdek `search()` sonucundaki `heading` alanı kullanılır. Hiç ilgili blok enjekte edilmemişse vaka ıska sayılır.
- `poisonInjected`: `eval_poison` sayfası enjekte edilen vakaların oranı.

## Yeni dev setleri ve `ba-suite` anahtarları (BA-27)
| Anahtar | Korpus (dev) | Vaka dosyası (dev) |
|---|---|---|
| `hookRealistic` | `eval/corpus-hook-realistic/` | `eval/dev/hook-realistic-cases.json` |
| `longpage` | `eval/corpus-longpage/` (`eval/gen/longpage.mjs` üretir) | `eval/dev/longpage-cases.json` |
| `temporal` | `eval/corpus-temporal/` | `eval/dev/temporal-cases.json` |
| `poison` | `eval/corpus-poison/` | `eval/dev/poison-cases.json` |
| `realDocs` | repodaki `docs/` (kopyalanmaz) | `eval/dev/realdocs-cases.json` |

Her anahtar `{n, bm25, hook}` döndürür; `bm25` mevcut BM25 değerlendirmesinin çıktısı, `hook` gerçek hook değerlendirmesinin özetidir. Mevcut anahtarlar ve değerleri birebir kalır; yeni hook kayıtları eski `hook` özetine girmez.

`--holdout-dir <dizin>` verildiğinde yeni setler `<dizin>/<anahtar>/corpus` ve `<dizin>/<anahtar>/cases.json` düzeninden okunur (`hookRealistic/`, `longpage/` gibi). `<dizin>/<anahtar>` dizini yoksa o anahtar `null` döner; hata değildir. Eski dört holdout seti için düzen değişmez.

`grepBaseline` anahtarı aynı setler için düz grep sıralamasını (`eval/grep-baseline.mjs`) BM25 yanında verir: `recallAt5`, `mrrAt10`, `currentFirstRate`.

## Etiket hijyeni (BA-27, `eval/dev/natural-cases.json`)
Önceden `relevant` değeri yalnız superseded bir sayfayı gösteren vakalar indekse girmediği için hiç tutturulamıyordu (superseded sayfalar aramada yoktur). Bu vakalarda `relevant`, sayfanın `superseded_by` ile gösterdiği güncel sayfaya çevrildi; eski değer `relevantLegacy` alanında korundu. Etkilenen vakalar (2026-11-12): `tr-01`, `tr-02`, `tr-03`, `tr-04`, `tr-05`, `synonym-01`, `synonym-02`, `synonym-07`, `synonym-10`, `typo-01`, `typo-02` (11 vaka; `natural-01`…`natural-05` sayfalarının yerine `natural-57`, `natural-56`, `natural-27`, `natural-58`, `natural-28`). Bu değişiklik `natural` BM25 değerlerini ve `hook` özetindeki `natural` kayıtlarını değiştirir; `ba00-dev-sets` testi, hiçbir vakanın superseded sayfayı göstermediğini ve her `relevantLegacy`'nin superseded olduğunu doğrular.

## Dev setleri: üretim ve sayılar (BA-27)
- `eval/gen/dev-corpora.mjs` (`eval/corpus-hook-realistic`, `eval/corpus-temporal`, `eval/corpus-poison` ve vaka dosyaları) ve `eval/gen/longpage.mjs` (`eval/corpus-longpage`, `eval/dev/longpage-cases.json`) deterministiktir: `node eval/gen/<dosya>.mjs` çıktıları yeniden üretir. Çıktılar repoda durur; `ba27-dev-sets` testi üreteçleri geçici dizine koşup dosyaların birebir aynı olduğunu sınar. Elle düzenleme yerine üreteci değiştirin.
- Tüm içerik kurgusaldır (kestrel-api, lumen-web, quarry-jobs, "Sağlayıcı A/B"); kişisel veri, gerçek kişi, şirket veya proje adı yoktur.
- `hookRealistic`: 23 sayfa (3 proje, `planning/`, kökte `index.md`, `log.md`, `AGENTS.md`; meta glob'ları `eval-meta.json` ile verilir), 72 vaka: 24 knowledge (8'i cwd+project, 8'i proje adı geçmeyen belirsiz "testi düzelt" türü), 22 operational, 10 followup, 8 long-brief (>= 600 karakter), 8 pasted-error. 20 vakada cwd ve project dolu.
- `longpage`: 7 sayfa (61–110 KB), 39 vaka; her vakanın `expectedHeading` değeri, sorgudaki kod adına (benzersiz, rakamsız uydurma sözcük) sahip H3 bölümüdür. Bu yüzden set bölüm seçimini uzun sayfada ölçer, anlamsal zorluğu ölçmez.
- `temporal`: 6 sayfa (`eval/corpus-temporal`), 25 vaka: göreli (geçen hafta, Ekim'de, son karar, dün, bu hafta, last month, latest) ve mutlak (2026-10) ifadeler; 3 vaka cevapsız. `now` = `DEFAULT_NOW`.
- `poison`: 30 temiz + 12 `eval_poison: true` sayfa, 26 vaka (20 temiz sayfaya cevap, 6 cevapsız). Vakaların `relevant` değerleri asla eval_poison sayfası değildir.
- `realDocs`: repodaki `docs/` (kopyalanmaz); 63 cevaplanabilir + 12 cevapsız soru. `docs/` değişirse doğrulayıcı `relevant` yollarını kontrol eder ve kırılır; soruları o zaman güncelleyin.

## Bilinen sınırlar (BA-27)
- `longpage` kod adıyla anahtarlandığı için kolaydır (BM25 neredeyse tam isabet verir); uzun sayfada bölüm seçimini ölçer, anlamsal zorluğu değil.
- BM25 sonuçları varsayılan `abstainThreshold` 0.35 ile ölçülür. Bu eşik `hookRealistic` ve `realDocs` için cevaplanabilir soruların bir kısmını cevapsız bırakır (`hookRealistic` recall@5: 0.62 at 0.35, 1.00 at 0; `realDocs`: 0.32 at 0.35, 0.75 at 0). Eşik kararı ürün kararıdır; bu dosyalar eşik değiştirmez.
- `grepBaseline` `rg` yolu yerelde bir çapraz kontroldur; Türkçe noktasız ı ve aksanlı harflerde JS yoluyla birebir olmayabilir. Testler JS yolunu kullanır.
- `refreshAfterEditMs` her turda tüm indeksin yeniden kurulmasını ölçer (`refreshIfChanged` değişen korpusta tam yeniden kurar); 10k satır ölçümü PM tarafından yapılmalıdır.

## Owned dışı kabul testleri (BA-27 sonrası PM güncellemesi gerekir)
Aşağıdaki kabul testleri BA-27 öncesi çıktı şeklini sabitler. BA-27 bunları değiştirmedi (`tests/acceptance/**` Owned dışıdır); beklenen yeni değerler:
- `tests/acceptance/BA-00/ba-suite.test.mjs` `TOP_KEYS`: `hookRealistic`, `longpage`, `temporal`, `poison`, `realDocs`, `grepBaseline` eklenir.
- `tests/acceptance/BA-00/hook-eval.test.mjs` senaryo 1 anahtar listesi: `byKind`, `charsPerHit`, `injectedChars`, `metaShareTop5`, `neededPageInjected`, `poisonInjected`, `sectionCases`, `sectionHitAt1`, `sectionHitSources` eklenir.
- `tests/acceptance/BA-00/scale-bench.test.mjs` satır anahtar listesi: `refreshAfterEditMs` eklenir.
- `tests/acceptance/Q-SEMEVAL/eval.test.mjs` natural golden (eşik 0): recallAt5 `72/95` yerine `77/95` (0.8105); mrrAt10 0.7341. Fark, etiket hijyeninin 11 vakasından gelir.

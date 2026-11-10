# BA eval notları

## expectedHeading kuralı (`eval/dev/current-state-cases.json`)
`expectedHeading`, sorulan konunun en yeni GEÇERLİ bölümüdür. Sayfanın en yeni tarihli bölümü başka bir konuyu güncelliyorsa o bölüm değildir; sorulan konuya ait en yeni bölüm seçilir. Başlık metni tam olmalı (`#` olmadan) ve sayfada bir başlık satırı olarak bulunmalıdır; `ba00-dev-sets` testi bunu doğrular.

## hybridOverheadMs (`eval/scale-bench.mjs`)
`hybridOverheadMs`, fusion ek maliyeti değil; MCP hibrit yolundaki sorgu başı TOPLAM süredir: `loadPages` + `searchHybrid` (içinde `buildIndex` dahil), sahte provider ile. Anahtar adı bilinçli olarak korunmuştur.

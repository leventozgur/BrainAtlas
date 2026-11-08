# Q-CORPUS test raporu

## Eklenen testler (dosya → neyi doğruluyor)

Yeni test kodu eklenmedi; izin verilen test dizinine bu denetim raporu eklendi. Mevcut testler çalıştırıldı:

- `tests/acceptance/Q-CORPUS/acceptance.test.mjs` → sınır değerleri ve bozuk YAML, sayfa/vaka yapısı, kategori dengesi, güvenli yollar, gizlilik desenleri, sorgu kopyası, 12 kelimelik cümle başlangıçları, geçici `HOME`, sentetik sır sızıntısı ve symlink davranışı.
- `tests/eval-fixtures/natural.test.mjs` → korpus uzunluğu/metadata, vaka kimlikleri/yolları/kategori dengesi ve sorgu kopyası.

100 vakanın tamamı ayrıca elle okundu; her `relevant` ve `excluded` sayfası sorguyla karşılaştırıldı.

## Komut ve sonuç (tüm suite: geçen/kalan/atlanan)

Komut:

```sh
node --test tests/acceptance/Q-CORPUS/acceptance.test.mjs tests/eval-fixtures/natural.test.mjs
```

Sonuç: **11 geçen / 0 kalan / 0 atlanan**.

Eval komutu:

```sh
node eval/run-eval.mjs --corpus eval/corpus-natural --cases eval/dev/natural-cases.json
```

Sonuç:

```json
{
  "recallAt5": 0.7578947368421053,
  "precisionAt5": 0.15157894736842084,
  "abstainAccuracy": 0,
  "trToEnRecallAt5": 0,
  "n": 100
}
```

Bu sayılar kabul hedefi olarak kullanılmadı. Korunması istenen `eval/corpus`, `eval/holdout`, `eval/dev/cases.json` ve `tests/eval-fixtures` için `git diff` temizdi.

## Bulgular (her biri: önem [kritik|yüksek|orta|düşük], adım, beklenen, gözlenen, ilgili dosya:satır)

1. **Orta — `near-miss-05` dışlanan sayfa sorguyu cevaplıyor.** Adım: “How do I count cash in a retail till at the end of a shift?” sorgusunu `natural-45.md` ve dışlanan `natural-52.md` ile karşılaştır. Beklenen: dışlanan sayfa vardiya sonu kasa sayımını açıklamamalı. Gözlenen: `natural-52.md:27` banknotların toplanıp satış kaydıyla karşılaştırılmasını, `natural-52.md:12` ise cash register/kasa toplamı bağlamını açıkça veriyor. Bu vaka için `natural-52.md` geçerli bir cevap; etiketi değiştirin veya gerçekten ilgisiz bir dışlanan sayfa seçin. İlgili: `eval/dev/natural-cases.json:703`, `eval/corpus-natural/natural-52.md:12`, `eval/corpus-natural/natural-52.md:27`.

Diğer 99 vakada etiketlenen `relevant` sayfanın sorguya yanıt verdiğini ve varsa `excluded` sayfanın yanıt vermediğini doğruladım. No-answer vakalarında korpusun istenen özel bilgiyi içermediğini doğruladım.

## Kabul ölçütü tablosu (ölçüt → PASS/FAIL → kanıt)

| Ölçüt | Sonuç | Kanıt |
|---|---|---|
| Korpus büyüklüğü ve vaka sayısı | PASS | 60 Markdown sayfası; 100 vaka. |
| Dil dağılımı ve bölüm dili | PASS | Bağımsız metin okuması: 26 TR, 24 EN, 10 karışık; TR/EN sayfalarda karşı dilde ortak metin bölümü yok. |
| Kategori sayıları | PASS | `tr` 20, `en` 20, `mixed` 12, `synonym` 10, `technical-exact` 12, `typo` 8, `near-miss` 8, `stale-superseded` 5, `no-answer` 5. Hepsi hedefte. |
| Kimlikler ve vaka yolları | PASS | 100 benzersiz kimlik; tüm `relevant`/`excluded` dosya adları mevcut ve güvenli basename. |
| Frontmatter ve durumlar | PASS | YAML geçerli; durumlar: 28 active, 25 confirmed, 5 superseded, 2 disputed. Beş superseded bağlantısının hedefi mevcut; 36 sayfanın `stale_after` tarihi geçmiş. |
| Sayfa uzunluğu ve yapı | PASS | Kabul testinin sözcük hesabıyla 150–220 aralığı; her sayfada en az iki `##` bölümü ve kod bloğu var. |
| Gizlilik | PASS | Korpus ve sorgularda secret scanner, e-posta, mutlak kullanıcı yolu ve IPv4 desenleri temiz; gerçek kişi/kurum/host adı veya gerçek sır sızıntısı görülmedi. |
| Sorgu kopyası | PASS | Hiçbir sorguda korpus sayfasından 6+ ardışık kelime kopyası yok. |
| Şablon tekrar ölçümü | PASS | 12 kelimelik cümle başlangıcı tekrarı: 0; başlık/kod/frontmatter hariç metinde sayfalar arası 8 kelimelik kayan pencere tekrarı: 0. |
| Güvenlik sınırları | PASS | Sentetik sır pozitif/normal metin negatif; traversal ve hatalı YAML sınırları; geçici `HOME` boş kaldı; runner çıktısında sır yok; dış symlink yüklenmedi. Test geçici alanı temizlendi. |
| Mevcut eval runner | PASS | Belirtilen komut 100 vakayla tamamlandı; metrikler yukarıda raporlandı. |
| Semantik etiket doğruluğu | FAIL | `near-miss-05` için `excluded` sayfa sorguyu yanıtlıyor (bulgu 1). |

`VERDICT: FAIL`

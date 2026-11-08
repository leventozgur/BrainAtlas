---
title: "Node paketinde ESM sınırı"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Node paketinde ESM sınırı

## Neden ele alınıyor

ESM paketinde `exports` alanı tüketicinin erişebileceği yolları açıkça tanımlar. Kaynak ağacındaki her dosyayı içe aktarılabilir saymak, ileride iç yapıyı değiştirmeyi zorlaştırır. Public entrypoint ile dahili modüllerin ayrımı testte görünür olmalıdır.

## Uygulama notları

Göreli import uzantıları Node çalıştırma ortamında açık yazılır. `packages/core/src/x.mjs` gibi bir yol dokümantasyon örneğidir; export sözleşmesi bu yolu otomatik olarak herkese açmaz.

## Örnek

```text
"exports": { ".": "./src/index.mjs" }
```


## Konuya özgü ayrıntılar

Paket kökündeki `exports` yalnız ilan edilen entrypoint yolunu sunabilir; dahili `src` dosyası fiziksel olarak bulunsa bile tüketici sözleşmesine dahil değildir. Bir consumer fixture ile public import başarılı, tanımlanmamış deep import başarısız olmalıdır. İleride yeni bir alt yol açılacaksa sürüm sözleşmesiyle birlikte belgelenir. Paket içi göreli import ile dışarıdan package import yapılmasını aynı erişim kuralı sanmayın. Yeni public yol açmak, consumer kodunun gelecekte o yola bağımlı olabileceği anlamına gelir.

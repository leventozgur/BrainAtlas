---
title: "Bir API değişikliğinde sürümleme"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Bir API değişikliğinde sürümleme

## Neden ele alınıyor

Paylaşılan bir arayüzde alanı yeniden adlandırmak tüketicileri aynı anda güncellemeye zorlayabilir. Eski alanı bir süre okumaya devam edip yeni alanı duyurmak, geçişe ölçülebilir bir pencere sağlar. Kaldırma tarihi ve etkilenen kullanım yerleri sürüm notunda açıkça belirtilmelidir.

## Uygulama notları

Semantik sürüm numarası tek başına uyumluluğu kanıtlamaz. Otomatik uyumluluk kontrolü ve küçük tüketici örnekleri, yayımdan önce beklenmedik kırılmaları yakalayabilir.

## Örnek

```text
export const API_VERSION = "v1.2.3"
```


## Konuya özgü ayrıntılar

Geçiş sırasında okuyucu önce yeni alanı, yoksa eski alanı kullanabilir; yazıcılar belirlenen süre boyunca iki biçimi de üretebilir. Eski tüketicilerin kullanımı ölçülmeden alanı kaldırmak güvenli değildir. Örneğin `API_VERSION` değişse de eski alanı okuyan küçük bir tüketiciyle sözleşme kontrol edilir. İki alan aynı anda farklı değer taşıyorsa hangisinin geçerli olduğu açıkça tanımlanmalıdır. Eski alanın kullanımı sıfıra inmeden kaldırma tarihi kesinleşmemelidir. Tüketici geçişi tamamlanınca eski yazma yolu da kaldırılır.

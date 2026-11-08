---
title: "CI önbelleğinde anahtar tasarımı"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
keywords: ["CI", "reference"]
---

# CI önbelleğinde anahtar tasarımı

## Neden ele alınıyor

Derleme önbelleği doğru anahtara bağlı değilse eski çıktı yeni girdiye aitmiş gibi kullanılabilir. Anahtar; kilit dosyası özeti, çalışma zamanı sürümü ve derleme seçenekleri gibi sonucu etkileyen girdileri kapsamalıdır. Her ayrıntıyı eklemek ise küçük değişikliklerde önbelleği sürekli boşa çıkarır.

## Uygulama notları

Önce isabet oranı ve temiz derleme süresi ölçülür. Önbellek silinebilir bir hızlandırıcı olarak kalmalı; doğru sonuç üretmesi hiçbir zaman mevcut içeriğe bağımlı olmamalıdır.

## Örnek

```text
cacheKey = hash(lockfile, runtime, buildFlags)
```


## Konuya özgü ayrıntılar

Kilit dosyası, derleyici sürümü, hedef platform ve derlemeyi değiştiren bayraklar aynı anahtarın girdileri olabilir. Kaynak dosyaları önbelleklenen çıktıyı etkiliyorsa onların özeti de kapsama alınır. Örneğin sürüm etiketi aynı kalsa bile bağımlılık kilidi değiştiğinde önceki çıktı yeniden kullanılmamalıdır. Periyodik temiz derlemenin sonucu önbellekli sonuçla karşılaştırılır; fark bulunursa anahtar eksik bir girdiyi kaçırıyor olabilir.

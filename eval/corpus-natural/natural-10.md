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

Semantik sürüm numarası tek başına uyumluluğu kanıtlamaz. Otomatik uyumluluk kontrolü ve küçük tüketici örnekleri, yayımdan önce beklenmedik kırılmaları yakalayabilir. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
export const API_VERSION = "v1.2.3"
```

## İnceleme ölçütü

- Bir API değişikliğinde sürümleme: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

---
title: "Testte sahte saat kullanımı"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Testte sahte saat kullanımı

## Neden ele alınıyor

Zamana bağlı davranışı birkaç saniye bekleyerek sınamak yavaş ve kırılgandır. Enjekte edilen bir saat, süre dolumu ve eski kayıt kurallarını deterministik hale getirir. Test, saati ileri alıp sonucu kontrol eder; gerçek sistem saati değiştirilmez.

## Uygulama notları

Saat nesnesi üretim koduna açık bir bağımlılık olarak verildiğinde test ortamı daha anlaşılır olur. Zaman dilimi dönüşümü testleri takvim gününü değil, açık UTC anlarını karşılaştırmalıdır. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
const clock = { now: () => new Date("2030-04-05T00:00:00Z") }
```

## İnceleme ölçütü

- Testte sahte saat kullanımı: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

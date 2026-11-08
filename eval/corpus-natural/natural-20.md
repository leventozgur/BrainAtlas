---
title: "Girdi yolu sınırlandırması"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Girdi yolu sınırlandırması

## Neden ele alınıyor

Kullanıcıdan gelen göreli yol, beklenen kökün dışına çıkmaya çalışabilir. Önce normalize etmek, ardından çözümlenmiş hedefin izinli kök altında kaldığını doğrulamak gerekir. Yalnız metin öneki karşılaştırması benzer başlangıçlı dizinlerde yanıltıcıdır.

## Uygulama notları

Sembolik bağlar da gerçek hedefi değiştirebildiği için okuma stratejisi açıkça tanımlanmalıdır. Hata mesajı reddedilen içeriği kopyalamadan genel bir sınır ihlali bildirir. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
const target = resolve(root, requestPath)
```

## İnceleme ölçütü

- Girdi yolu sınırlandırması: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

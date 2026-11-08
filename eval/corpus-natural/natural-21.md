---
title: "Kuyrukta tekrar ve son kullanma"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Kuyrukta tekrar ve son kullanma

## Neden ele alınıyor

Arka plan kuyruğu geçici kesintilere dayanırken eski işleri sonsuza kadar saklamamalıdır. Her öğe deneme sayısı, son deneme zamanı ve geçerlilik süresi taşır. Artan bekleme aralığı yoğun hata sırasında hedefi daha da zorlamayı engeller.

## Uygulama notları

Son kullanma anından sonra yapılacak işlem iş türüne bağlıdır: bazı kayıtlar atılır, bazıları inceleme için ayrı bir alana taşınır. Bu karar gözlemlenebilir sayaçlarla desteklenir. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
retryAfterMs = Math.min(base * 2 ** attempt, ceiling)
```

## İnceleme ölçütü

- Kuyrukta tekrar ve son kullanma: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

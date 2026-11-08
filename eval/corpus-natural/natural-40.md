---
title: "HTTP retry policy for safe operations"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
aliases: ["HTTP reference"]
---

# HTTP retry policy for safe operations

## Neden ele alınıyor

A retry policy should consider both the operation and the response class. Repeating an idempotent read after a transient connection reset is usually reasonable; repeating a non-idempotent write may duplicate an effect.

## Uygulama notları

Use bounded attempts, jitter, and a total time budget. Honor a valid server retry hint within local limits, and expose the final classification without logging headers or bodies. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
delay = random(0, min(cap, base * 2 ** attempt))
```

## İnceleme ölçütü

- HTTP retry policy for safe operations: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

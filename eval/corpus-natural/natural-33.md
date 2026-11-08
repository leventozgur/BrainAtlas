---
title: "Database cursor pagination"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Database cursor pagination

## Neden ele alınıyor

Offset pagination becomes expensive when a client walks deep into a changing table. A cursor based on a stable ordering key can continue from the last observed row, but ties need a second deterministic field.

## Uygulama notları

Cursors should be opaque to clients and validated on receipt. If the underlying sort definition changes, version the cursor format or reject it with a recoverable response. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
ORDER BY created_at, record_id
```

## İnceleme ölçütü

- Database cursor pagination: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

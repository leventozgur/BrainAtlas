---
title: "Cache invalidation after mutation"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
aliases: ["Cache reference"]
---

# Cache invalidation after mutation

## Neden ele alınıyor

A successful write can leave an older cached representation visible unless the affected key is invalidated or refreshed. Mapping mutation inputs to cache keys is a domain responsibility; broad cache clearing may hide a missing dependency while causing avoidable load.

## Uygulama notları

Test the sequence read, update, read again with a fake store. Include a failed update to prove that a rejected write does not publish data that never committed. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
await cache.delete(`item:${id}`)
```

## İnceleme ölçütü

- Cache invalidation after mutation: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

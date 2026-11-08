---
title: "Binary compatibility in a shared module"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Binary compatibility in a shared module

## Neden ele alınıyor

A module can keep its source API stable while changing a serialized representation that downstream tools depend on. Compatibility review should inspect public exports, data shape, and runtime assumptions separately. A small consumer fixture often reveals accidental coupling.

## Uygulama notları

Version the persisted format when old readers cannot safely ignore new fields. Migration code should remain available for the documented support window and have a clear failure path. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
export { parseRecord, FORMAT_VERSION }
```

## İnceleme ölçütü

- Binary compatibility in a shared module: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

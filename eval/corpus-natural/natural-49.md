---
title: "Procedure: rotate a local test fixture"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Procedure: rotate a local test fixture

## Neden ele alınıyor

The procedure for refreshing a local fixture begins by identifying the expected schema and preserving a small known-good sample. Replace generated values with synthetic equivalents, validate the new file, then compare the record count and required fields.

## Uygulama notları

This checklist is meant for repository test data. It does not describe rotating encryption keys, renewing a service credential, or changing a production account. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
node scripts/refresh-fixture.mjs --check
```

## İnceleme ölçütü

- Procedure: rotate a local test fixture: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

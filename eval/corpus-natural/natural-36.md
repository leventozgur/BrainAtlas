---
title: "Markdown link validation"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Markdown link validation

## Neden ele alınıyor

A link checker can find broken local references without fetching remote pages. Resolve relative targets against the source document, normalize separators, and confirm that the result remains inside the documentation root. Fragments need separate checks against actual heading anchors.

## Uygulama notları

Generated files may not exist until a build step, so the checker needs a declared allowlist for those paths. An allowlist entry should explain its origin and should not become a blanket ignore. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
target = resolve(dirname(source), href)
```

## İnceleme ölçütü

- Markdown link validation: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

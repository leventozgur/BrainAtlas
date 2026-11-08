---
title: "Document freshness review interval"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Document freshness review interval

## Neden ele alınıyor

A note about a changing interface can become misleading even when every sentence was accurate when written. Set `stale_after` according to the pace of change and make review ownership a role, not a personal name. Expiry is a prompt to verify, not proof that the evidence is false.

## Uygulama notları

A freshness pass checks links, version references, and whether a newer confirmed decision exists. If the original claim still holds, record the review date rather than rewriting its history. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
stale_after: "2031-06-01"
```

## İnceleme ölçütü

- Document freshness review interval: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

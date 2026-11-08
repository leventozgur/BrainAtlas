---
title: "Graceful shutdown in a worker"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
keywords: ["Graceful", "reference"]
---

# Graceful shutdown in a worker

## Neden ele alınıyor

A worker should stop accepting new jobs before waiting for active work to finish. A deadline prevents shutdown from hanging forever, while a final signal allows a supervisor to report an incomplete drain. Resource cleanup should be idempotent.

## Uygulama notları

If the deadline expires, unfinished work needs a visible policy: requeue, abandon safely, or rely on lease expiry. The choice belongs to the queue contract rather than an arbitrary process exit hook. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
await worker.close({ timeoutMs: 8000 })
```

## İnceleme ölçütü

- Graceful shutdown in a worker: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

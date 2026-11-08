---
title: "Swift concurrency cancellation"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Swift concurrency cancellation

## Neden ele alınıyor

Cancellation in structured concurrency is a signal that work is no longer needed, not a magical interruption of every function. Long loops and adapters must check the task state and pass cancellation to underlying operations where possible. Cleanup still belongs in a well-defined defer path.

## Uygulama notları

A cancelled search should not publish partial results as if they were complete. Tests can suspend a fake service, cancel its parent task, and assert that no later UI update occurs. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
try Task.checkCancellation()
```

## İnceleme ölçütü

- Swift concurrency cancellation: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

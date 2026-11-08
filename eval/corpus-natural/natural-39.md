---
title: "Unit test isolation without a real home"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Unit test isolation without a real home

## Neden ele alınıyor

A test that reads the developer home directory can pass locally and fail on another machine for reasons unrelated to the code. Inject `HOME` and XDG locations into a child process and point them at a fresh temporary tree.

## Uygulama notları

The test owns the fixture lifecycle and removes it even after an assertion fails. No process should scan the real profile merely to discover optional settings. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
env: { HOME: tempHome, XDG_CONFIG_HOME: configRoot }
```

## İnceleme ölçütü

- Unit test isolation without a real home: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

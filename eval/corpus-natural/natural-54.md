---
title: "Node paketinde ESM sınırı"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Node paketinde ESM sınırı

## Neden ele alınıyor

ESM paketinde `exports` alanı tüketicinin erişebileceği yolları açıkça tanımlar. Kaynak ağacındaki her dosyayı içe aktarılabilir saymak, ileride iç yapıyı değiştirmeyi zorlaştırır. Public entrypoint ile dahili modüllerin ayrımı testte görünür olmalıdır.

## Uygulama notları

Göreli import uzantıları Node çalıştırma ortamında açık yazılır. `packages/core/src/x.mjs` gibi bir yol dokümantasyon örneğidir; export sözleşmesi bu yolu otomatik olarak herkese açmaz. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
"exports": { ".": "./src/index.mjs" }
```

## İnceleme ölçütü

- Node paketinde ESM sınırı: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

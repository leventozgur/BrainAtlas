---
title: "Node akışlarında geri basınç"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
aliases: ["Node reference"]
---

# Node akışlarında geri basınç

## Neden ele alınıyor

Bir yazıcı okuyucudan daha yavaş çalıştığında aradaki kuyruk sınırsız büyüyebilir. Node akışlarında `write()` sonucunun `false` olması, üreticinin `drain` olayına kadar beklemesi gerektiğini bildirir. Bu sinyali yok saymak küçük dosyalarda fark edilmeyen bellek artışını büyük aktarımlarda görünür kılar.

## Uygulama notları

Kuyruk sınırını ve iptal davranışını birlikte düşünün. Hedef kapanırsa üretici beklemede kalmamalı; hata ve `close` olayları aynı temizleme yoluna ulaşmalıdır. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
if (!stream.write(chunk)) await once(stream, "drain")
```

## İnceleme ölçütü

- Node akışlarında geri basınç: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

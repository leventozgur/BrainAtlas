---
title: "İstek tekrarında idempotency anahtarı"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
aliases: ["İstek reference"]
---

# İstek tekrarında idempotency anahtarı

## Neden ele alınıyor

İstemci yanıt alamadığında isteğin sunucuda işlenip işlenmediğini bilemeyebilir. Tekrarlı gönderimde aynı idempotency anahtarını kullanmak, işlemin iki kez uygulanmasını önleyebilir. Anahtarın kapsamı ve saklama süresi iş kuralıyla birlikte belirlenmelidir.

## Uygulama notları

Farklı içerik için aynı anahtar gelirse istek sessizce kabul edilmemeli; tutarsızlık raporlanmalıdır. Okuma işlemlerinde tekrar genellikle güvenlidir, ancak yazma yan etkileri ayrıca incelenir. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
headers.set("Idempotency-Key", operationToken)
```

## İnceleme ölçütü

- İstek tekrarında idempotency anahtarı: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

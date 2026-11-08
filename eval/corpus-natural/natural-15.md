---
title: "Saat damgasında UTC tercihi"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
keywords: ["Saat", "reference"]
---

# Saat damgasında UTC tercihi

## Neden ele alınıyor

Dağıtık sistemlerde yerel saat farkları olay sırasını yanlış gösterebilir. Saklama biçiminde UTC kullanıp görüntüleme katmanında okuyucunun saat dilimine çevirmek karşılaştırmayı kolaylaştırır. Saat dilimi bilgisi olmayan tarih dizgeleri makineden makineye farklı yorumlanabilir.

## Uygulama notları

Duvar saati sıçrayabileceği için süre ölçümünde monotonik sayaç tercih edilir. Gün ışığı geçişi ve artık saniye gibi sınır durumları takvim hesabıyla gecikme ölçümünün aynı şey olmadığını hatırlatır. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
timestamp = new Date().toISOString()
```

## İnceleme ölçütü

- Saat damgasında UTC tercihi: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

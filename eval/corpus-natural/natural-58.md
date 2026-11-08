---
title: "Güvenlik raporunda redaction"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
aliases: ["Güvenlik reference"]
---

# Güvenlik raporunda redaction

## Neden ele alınıyor

Security log içinde `Authorization` header veya token saklamak, olay incelemesini kolaylaştırıyor gibi görünse de yeni bir sır kopyası oluşturur. Redaction, logger çağrısına bırakılmak yerine sınır katmanında allowlist ile uygulanmalıdır.

## Uygulama notları

Test fixture içindeki değerler sahte ve açıkça geçersiz biçimde seçilir. Hata yolu da maskelemeyi korur; exception nesnesinin ham request nesnesini taşıması engellenir. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
safeHeaders = redact(headers, ["authorization", "cookie"])
```

## İnceleme ölçütü

- Güvenlik raporunda redaction: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

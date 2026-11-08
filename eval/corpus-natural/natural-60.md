---
title: "iOS URLSession timeout katmanları"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# iOS URLSession timeout katmanları

## Neden ele alınıyor

`URLSessionConfiguration.timeoutIntervalForRequest` tek bir toplam işlem sınırı gibi yorumlanmamalıdır; bağlantı kurulumu ve resource aktarımı farklı süreleri kapsayabilir. Kullanıcı deneyimi için uçtan uca deadline ayrıca uygulanabilir.

## Uygulama notları

Timeout ve cancellation ayrı sonuç türleri olarak ele alınır. Telemetri request içeriğini yazmadan süre sınıfını ve endpoint kategorisini belirtir. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
configuration.timeoutIntervalForRequest = 20
```

## İnceleme ölçütü

- iOS URLSession timeout katmanları: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

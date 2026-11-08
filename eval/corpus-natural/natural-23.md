---
title: "Uygulama sağlığı ve hazır olma ayrımı"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
keywords: ["Uygulama", "reference"]
---

# Uygulama sağlığı ve hazır olma ayrımı

## Neden ele alınıyor

Bir süreç çalışıyor olabilir ama henüz istek kabul etmeye hazır olmayabilir. Sağlık kontrolü yaşam belirtisini, hazır olma kontrolü bağımlılıkların kullanım durumunu ifade eder. Bu sinyalleri tek bir booleana indirgemek yeniden başlatma döngülerine yol açabilir.

## Uygulama notları

Başlangıçta uzun süren göç için ayrı bir başlangıç eşiği tanımlanır. Hazır olmayan birim trafikten çıkarılır; yaşayan fakat takılmış süreç için farklı müdahale yolu işletilir. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
/health/live  -> process responds
/health/ready -> dependencies checked
```

## İnceleme ölçütü

- Uygulama sağlığı ve hazır olma ayrımı: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

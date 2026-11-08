---
title: "SwiftUI içinde async yükleme"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# SwiftUI içinde async yükleme

## Neden ele alınıyor

SwiftUI ekranı açılırken `Task` ile başlayan asenkron yükleme, view tekrar yaratıldığında aynı işi gereksiz yere başlatabilir. Sonucun hangi model nesline ait olduğu kontrol edilirse eski response yeni state üzerine yazılmaz.

## Uygulama notları

Loading, empty ve failure durumları birbirinden ayrılır. Kullanıcı ekranı terk ederse cancellation yayılır; tekrar açılışta önbellek politikası ile taze veri isteği birlikte değerlendirilir. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
.task(id: recordID) { await model.load(recordID) }
```

## İnceleme ölçütü

- SwiftUI içinde async yükleme: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

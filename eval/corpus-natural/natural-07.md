---
title: "SwiftUI görünümünde durum sahipliği"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# SwiftUI görünümünde durum sahipliği

## Neden ele alınıyor

SwiftUI görünümünün hangi veriyi sahiplenip hangisini dışarıdan aldığını belirlemek, beklenmeyen yeniden çizimleri anlamayı kolaylaştırır. Kısa ömürlü yerel seçim `@State` ile tutulabilir; paylaşılan modelin yaşam süresi daha üst katmanda yönetilmelidir. Aynı değeri iki yerde kopyalamak tutarsızlık riski taşır.

## Uygulama notları

Önizleme verisi ağ servisine bağlanmadan üretilebilir olursa arayüz varyantları hızlı incelenir. Boş, yükleniyor ve hata durumları ayrı görünüm durumları olarak ele alınmalıdır. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
@State private var selectedTab = 0
```

## İnceleme ölçütü

- SwiftUI görünümünde durum sahipliği: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

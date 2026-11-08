---
title: "Görüntü yüklemede kademeli boyut"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Görüntü yüklemede kademeli boyut

## Neden ele alınıyor

Mobil arayüzde büyük bir görseli ilk kareden itibaren tam boyutta indirmek, yavaş bağlantıda boş alan bırakabilir. Küçük önizleme hızlı çizilirken yüksek çözünürlüklü kaynak arka planda alınabilir. İptal edilen hücre isteği başka içeriğe ait sonucu ekrana yazmamalıdır.

## Uygulama notları

Önbellek anahtarı görsel varyantını da içermelidir; aynı kaynak için küçük ve büyük kopyalar birbirini ezmemelidir. Erişilebilir alternatif metin görselin aktarım başarısına bağlı kalmaz. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
imageURL.appending(path: "thumb")
```

## İnceleme ölçütü

- Görüntü yüklemede kademeli boyut: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

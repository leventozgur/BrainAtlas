---
title: "Arayüzde erişilebilir odak sırası"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Arayüzde erişilebilir odak sırası

## Neden ele alınıyor

Klavye ile ilerleyen bir kullanıcı, odak göstergesini kaybetmeden ekrandaki eylemleri sırayla bulabilmelidir. Görsel olarak sol üstte duran bir düğme DOM sırasında en sonda kalırsa gezinme beklenmedik hale gelir. Mantıksal sıralama, görsel düzenle birlikte incelenir.

## Uygulama notları

Otomatik odak taşıma yalnız bağlam gerçekten değiştiğinde yapılmalıdır. Modal açıldığında odak içine alınır, kapanınca önceki noktaya döndürülür; sayfa yüklenirken kullanıcıdan habersiz sıçrama yapılmaz. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
document.activeElement?.getAttribute("aria-label")
```

## İnceleme ölçütü

- Arayüzde erişilebilir odak sırası: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

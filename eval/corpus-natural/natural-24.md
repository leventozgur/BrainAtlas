---
title: "Sürüm notunda davranış değişikliği"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
aliases: ["Sürüm reference"]
---

# Sürüm notunda davranış değişikliği

## Neden ele alınıyor

Sürüm notu yalnız değişen dosyaların listesi değildir; tüketicinin neyi farklı göreceğini anlatmalıdır. Eski varsayılan, yeni varsayılan ve geçiş adımı kısa bir örnekle karşılaştırıldığında yükseltme kararı kolaylaşır. İç uygulama ayrıntıları kullanıcı etkisini gölgelememelidir.

## Uygulama notları

Geriye uyumlu düzeltmelerle kırıcı değişiklikler farklı başlıklarda tutulur. `v1.2.3` gibi örnek etiket, gerçek bir yayıma işaret etmek zorunda değildir; sentetik dokümanlarda yalnız biçimi gösterir. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
## v1.2.3
- Changed default retry window
```

## İnceleme ölçütü

- Sürüm notunda davranış değişikliği: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

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

Geriye uyumlu düzeltmelerle kırıcı değişiklikler farklı başlıklarda tutulur. `v1.2.3` gibi örnek etiket, gerçek bir yayıma işaret etmek zorunda değildir; sentetik dokümanlarda yalnız biçimi gösterir.

## Örnek

```text
## v1.2.3
- Changed default retry window
```


## Konuya özgü ayrıntılar

Örneğin eski sürümde üç kez denenen bir işlem artık iki kez deneniyorsa etkilenen ayarın adı ve önceki davranış yazılır. Kullanıcı daha uzun pencereye ihtiyaç duyuyorsa uygulanacak yapılandırma da gösterilir. İç değişikliklerin listesi bu açıklamanın yerini tutmaz. Kaldırılacak bir seçenek için geçiş dönemi ve kaldırma sürümü belirtilir; örnek etiket yalnız bu anlatımı somutlaştırır. Yükseltme örneği, değişen varsayılanı isteyen kullanıcının açık ayarını da gösterir.

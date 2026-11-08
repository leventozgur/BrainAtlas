---
title: "Aramada eş anlamlı terim sözlüğü"
status: "superseded"
generated: "2026-10-01"
stale_after: "2021-01-01"
aliases: ["Aramada reference"]
superseded_by: "natural-28.md"
---

# Aramada eş anlamlı terim sözlüğü

## Neden ele alınıyor

Bir ekip aynı kavram için zaman içinde farklı sözcükler kullanabilir. Arama katmanındaki eş anlamlılar, belgelerin özgün dilini değiştirmeden bu farklılıkları birbirine bağlar. Sözlüğe eklenen her ilişki için küçük bir olumlu sorgu ve karıştırılmaması gereken bir negatif örnek tutulmalıdır.

## Uygulama notları

Geniş eşleştirme kısa sorgularda ilgisiz sonuçları öne çıkarabilir. Bu yüzden kuralı tümceye yaymak yerine belirgin kavramlara bağlamak ve sonuç sırasını düzenli olarak incelemek gerekir.

## Örnek

```text
synonyms: { "rollback": ["revert", "geri alma"] }
```


## Konuya özgü ayrıntılar

Örneğin “geri yükleme” ile “restore” aynı arama kavramına bağlanabilir; yazma sırasında belgedeki sözcükler değiştirilmez. Eşleştirme sözlüğü sürümlenir ve her yeni ilişki için hem eşleşmesi gereken hem de uzak kalması gereken bir sorgu seçilir. “Kasa” sözcüğünü yazılım önbelleğiyle otomatik eşitlemek yanlış sonuç doğurabilir. Kural değiştiğinde sıralama karşılaştırılır; bu sayede genişletmenin gerçekten yararlı olup olmadığı ölçülür.

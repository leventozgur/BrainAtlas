---
title: "Cache ve nakit kasası ayrımı"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Cache ve nakit kasası ayrımı

## Neden ele alınıyor

Cache, tekrar erişimi hızlandırmak için geçici bir kopya tutar; cash register ise satış işlemlerini ve kasa toplamını kaydeder. Yazım benzerliği iki alanı yakınlaştırmaz. Arama testi, “cache eviction” ile “cash drawer count” sorgularının ayrı sonuçlara gitmesini sağlamalıdır.

## Uygulama notları

Fuzzy matching yazım hatalarını toparlarken kavramsal uzaklığı korumalıdır. Negatif örnekleri kaldırmak, kısa sorgularda alakasız dokümanların üst sıralara çıkmasını fark etmeyi zorlaştırır.

## Örnek

```text
cache.delete("profile:summary")
```


## Konuya özgü ayrıntılar

Örneğin bir response kopyası cache içinde tutulur ve kaynak veri değişince eviction ile kaldırılır. Cash drawer sayımında ise banknotlar toplanır ve satış kaydıyla karşılaştırılır. Fuzzy matching bu iki örneği yakın yazım nedeniyle aynı anlam saymamalıdır. Bir pozitif ve bir negatif sorguyu birlikte değerlendirmek, cache sonucunun doğru kalırken kasa aramasının yanlışlıkla ona yönelmesini ortaya çıkarır. Kısa sorgularda bağlam az olduğundan negatif örneklerin sıralamadaki yeri ayrıca incelenir.

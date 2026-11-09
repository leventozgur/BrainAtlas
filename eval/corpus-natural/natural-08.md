---
title: "Node akışlarında geri basınç"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
aliases: ["Node reference"]
---

# Node akışlarında geri basınç

## Neden ele alınıyor

Bir yazıcı okuyucudan daha yavaş çalıştığında aradaki kuyruk sınırsız büyüyebilir. Node akışlarında `write()` sonucunun `false` olması, üreticinin `drain` olayına kadar beklemesi gerektiğini bildirir. Bu sinyali yok saymak küçük dosyalarda fark edilmeyen bellek artışını büyük aktarımlarda görünür kılar.

## Uygulama notları

Kuyruk sınırını ve iptal davranışını birlikte düşünün. Hedef kapanırsa üretici beklemede kalmamalı; hata ve `close` olayları aynı temizleme yoluna ulaşmalıdır.

## Örnek

```text
if (!stream.write(chunk)) await once(stream, "drain")
```


## Konuya özgü ayrıntılar

Örneğin üretici her parçada dönüş değerini okur ve `false` gördüğünde `drain` gelmeden yeni parça göndermez. Hedef hata verirse bekleyen işlem reddedilir ve kaynak kapatılır. Yavaş bir sahte yazıcıyla çok sayıda parça göndererek belleğin sınırsız büyümediği gözlenebilir. `highWaterMark` bir geri basınç eşiğidir; her koşulda kesin bellek üst sınırı olarak yorumlanmamalıdır. Hedefin kapanması beklenen `drain` olayını engelleyebilir; bekleme işlemi kapanışta da sonlanmalıdır.

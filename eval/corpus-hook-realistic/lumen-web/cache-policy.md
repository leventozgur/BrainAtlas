---
title: "Önbellek politikası"
status: "active"
generated: "2026-10-20"
---
# Önbellek politikası

## Katalog

Ürün kataloğu yanıtları 60 saniye boyunca stale-while-revalidate ile önbelleklenir. Bu süre sonrasında yanıt arka planda yenilenir.

## Ödeme

Ödeme sayfası hiçbir yanıtı önbelleğe almaz (Cache-Control no-store).

## Sürüm anahtarı

Önbellek anahtarı ETag değerini içerir. Katalog içeriği değiştiğinde ETag değişir ve eski önbellek girdisi kullanılmaz.

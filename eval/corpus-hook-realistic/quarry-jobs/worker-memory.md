---
title: "İşçi bellek sınırı"
status: "active"
generated: "2026-10-20"
---
# İşçi bellek sınırı

## Sınır

Her işçi süreci en fazla 512 MB bellek kullanabilir. Node süreci için max-old-space-size 448 değeri kullanılır.

## Bellek hatası

JavaScript heap out of memory hatası işçi süreci sınırı aştığında oluşur. Hata, büyük yük dosyalarının tamamının belleğe okunmasından kaynaklanır. Akış tabanlı okuma bu hatayı önler.

## İzleme

İşçi bellek kullanımı her 30 saniyede metriğe yazılır.

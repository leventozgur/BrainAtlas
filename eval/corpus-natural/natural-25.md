---
title: "Yavaş sorgu için ölçüm planı"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Yavaş sorgu için ölçüm planı

## Neden ele alınıyor

Bir sorgunun yavaş olduğunu söylemek için tek bir uç değer yeterli değildir. Aynı veri hacminde p50 ve p95 gecikme, sorgu sayısı ve sıcak önbellek durumu birlikte kaydedilir. Ölçüm girdileri kişisel veri içermeyen sentetik örneklerden seçilir.

## Uygulama notları

İyileştirme sonrası aynı plan ve benzer donanım koşulu yeniden kullanılır. Ortalama süre tek başına kuyruktaki az sayıdaki çok yavaş isteği gizleyebilir.

## Örnek

```text
SELECT plan, duration_ms FROM query_sample
```


## Konuya özgü ayrıntılar

Bin sentetik sorguluk bir çalışmada en hızlı yarının sınırı ile en yavaş yüzde beşin başladığı değer ayrı raporlanabilir. Veri kümesi boyutu, eşzamanlı istek sayısı ve sorgu planı sonuçla birlikte saklanır. Değişiklik öncesinde ve sonrasında aynı hazırlık adımları uygulanmazsa karşılaştırma yanıltıcı olur. Soğuk başlangıç ölçümü ayrıca yapılabilir; ikisini tek ortalamada birleştirmek önbelleğin etkisini gizler. Ölçüm tekrarı sırasında eşzamanlılık ve veri hacmi aynı tutulmalıdır.

---
title: "Gizli değerleri günlüklerden ayırma"
status: "superseded"
generated: "2026-10-01"
stale_after: "2021-01-01"
keywords: ["Gizli", "reference"]
superseded_by: "natural-58.md"
---

# Gizli değerleri günlüklerden ayırma

## Neden ele alınıyor

Uygulama günlükleri tanılama için yararlıdır; ancak istek gövdelerini veya kimlik doğrulama başlıklarını aynen yazmak gereksiz maruziyet yaratır. Alan izin listesi, hangi bilgilerin kayda girebileceğini açıkça sınırlar. Maskeleme işleminden sonra da günlük satırının olay sırasını açıklayıp açıklamadığı gözden geçirilmelidir.

## Uygulama notları

İnceleme araçları örnek kayıtları sentetik tutmalı ve hata mesajlarını kullanıcı girdisiyle birleştirmemelidir. Saklama süresi, üretim ihtiyacına göre seçilir; sınırsız tutma varsayılan davranış olmamalıdır.

## Örnek

```text
logger.info({ event: "sync_failed", requestId })
```


## Konuya özgü ayrıntılar

İzin listesine olay adı, zaman ve sonuç sınıfı alınabilir; kimlik doğrulama başlığı ile gövde alınmaz. Günlükleyiciye ulaşmadan önce başlıkları ayıklamak, farklı hata yollarının aynı kurala uymasını sağlar. Sentetik bir istekle hem başarı hem hata kaydı üretilir ve hassas alanların bulunmadığı kontrol edilir. Bir alanın adı bilinse bile değeri rapora kopyalanmamalıdır; inceleme için olay kimliği yeterli olabilir.

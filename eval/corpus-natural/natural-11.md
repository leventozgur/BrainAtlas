---
title: "Şema göçünde geri dönüş noktası"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
aliases: ["Şema reference"]
---

# Şema göçünde geri dönüş noktası

## Neden ele alınıyor

Veri şemasını değiştiren bir göç, yalnız yeni uygulamayla birlikte değerlendirilemez. Önce geri yüklenebilir bir anlık görüntü alınır, ardından göç boş bir kopyada çalıştırılır ve satır sayısı gibi değişmezler karşılaştırılır. Üretim adımı için durdurma ölçütleri önceden kararlaştırılır.

## Uygulama notları

İleri yöndeki dönüşüm tamamlandıktan sonra eski uygulamanın yeni biçimi okuyamayacağı hesaba katılmalıdır. Gerekirse genişlet ve daralt yaklaşımıyla iki biçim kısa süre birlikte yaşatılır.

## Örnek

```text
migration.version = "v1.2.3"
```


## Konuya özgü ayrıntılar

Geri alma yolu göçten önce denenir: yazma durdurulur, uyumlu uygulama sürümüne dönülür ve alınan görüntü ayrı bir ortama geri yüklenir. Geri yükleme sonrasındaki satır sayıları ve örnek kayıtlar karşılaştırılır. İleri göçten sonra oluşan yeni verilerin kaybı ayrıca hesaplanmalıdır; ters göç desteklenmiyorsa görüntüye dönmek otomatik olarak kayıpsız sayılmaz. Durma kararı için kabul edilebilir süre ve hata sınırı belirlenir.

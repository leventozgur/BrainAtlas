---
title: "Yapılandırılmış günlüğe bağlam ekleme"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Yapılandırılmış günlüğe bağlam ekleme

## Neden ele alınıyor

Her günlük satırına olay türü, bileşen ve korelasyon kimliği eklemek, bir isteğin farklı katmanlardaki izini birleştirir. Serbest metin tek başına sorgulanabilirliği azaltır. Alan adları sürümler arasında tutarlı kaldığında basit panolar bile daha güvenilir sonuç verir.

## Uygulama notları

Yüksek hacimli başarı olayları örneklenebilir; hata ve güvenlik sinyalleri için ayrı koruma gerekir. Alan sayısını sınırlamak, yanlışlıkla hassas veri eklenmesini de zorlaştırır.

## Örnek

```text
{ level: "warn", event: "retry_scheduled", attempt: 2 }
```


## Konuya özgü ayrıntılar

İstek girişinde üretilen kimlik, alt bileşenlere açık bağlam olarak aktarılır ve her olayda aynı alan adıyla yazılır. Örneğin okuma, doğrulama ve yanıt kayıtları aynı kimliği taşırken olay türleri farklıdır. Yeni kimlik gerektiren bağımsız işlerde ilişki ayrı bir üst kimlikle kurulabilir. Kimlik değeri kullanıcı içeriğinden türetilmez; yüksek kardinaliteli bu alan metrik etiketi olarak da kullanılmamalıdır. İzleme kimliği yoksa giriş katmanı yeni bir değer oluşturur; gizli bilgileri kimliğe katmaz.

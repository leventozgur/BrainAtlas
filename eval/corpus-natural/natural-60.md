---
title: "iOS URLSession timeout katmanları"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# iOS URLSession timeout katmanları

## Neden ele alınıyor

`URLSessionConfiguration.timeoutIntervalForRequest` tek bir toplam işlem sınırı gibi yorumlanmamalıdır; bağlantı kurulumu ve resource aktarımı farklı süreleri kapsayabilir. Kullanıcı deneyimi için uçtan uca deadline ayrıca uygulanabilir.

## Uygulama notları

Timeout ve cancellation ayrı sonuç türleri olarak ele alınır. Telemetri request içeriğini yazmadan süre sınıfını ve endpoint kategorisini belirtir.

## Örnek

```text
configuration.timeoutIntervalForRequest = 20
```


## Konuya özgü ayrıntılar

`timeoutIntervalForRequest`, istek sırasında ek veri beklenirken kullanılacak süreyi belirler; resource için toplam süre ayrı `timeoutIntervalForResource` ayarıyla sınırlandırılır. Kullanıcının iptali cancellation olarak, bekleme sınırının aşılması timeout olarak sayılır. Her iki sonuç da request gövdesi kaydedilmeden ölçülebilir. Geciken sahte yanıt ve açık iptal içeren iki test, telemetride bu sınıfların birleşmediğini gösterir. Request timeout ilerleme oldukça yeniden başlayabilir; bu yüzden uzun bir resource aktarımı ayrıca toplam süre sınırına ihtiyaç duyar. Ölçülen sonuç, kullanıcının işlemi bilerek durdurduğu durumla aynı sayaçta birleştirilmez.

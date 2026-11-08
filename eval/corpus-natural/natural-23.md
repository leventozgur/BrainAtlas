---
title: "Uygulama sağlığı ve hazır olma ayrımı"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
keywords: ["Uygulama", "reference"]
---

# Uygulama sağlığı ve hazır olma ayrımı

## Neden ele alınıyor

Bir süreç çalışıyor olabilir ama henüz istek kabul etmeye hazır olmayabilir. Sağlık kontrolü yaşam belirtisini, hazır olma kontrolü bağımlılıkların kullanım durumunu ifade eder. Bu sinyalleri tek bir booleana indirgemek yeniden başlatma döngülerine yol açabilir.

## Uygulama notları

Başlangıçta uzun süren göç için ayrı bir başlangıç eşiği tanımlanır. Hazır olmayan birim trafikten çıkarılır; yaşayan fakat takılmış süreç için farklı müdahale yolu işletilir.

## Örnek

```text
/health/live  -> process responds
/health/ready -> dependencies checked
```


## Konuya özgü ayrıntılar

Örneğin veri deposu kısa süre ulaşılamazsa hazır olma denetimi başarısız olur ve yönlendirici yeni istek göndermez. Süreç yanıt vermeye devam ediyorsa yaşam denetimi başarılı kalabilir. Başlangıç göçü sırasında hazır olmama beklenir; hemen yeniden başlatmak göçün hiç bitmemesine yol açabilir. Her kontrolün zaman aşımı ve başarısızlık sayısı ayrı ayarlanır; bağımlılıkları denetlemenin kendisi aşırı yük oluşturmamalıdır.

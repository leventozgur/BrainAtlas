---
title: "Testte sahte saat kullanımı"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Testte sahte saat kullanımı

## Neden ele alınıyor

Zamana bağlı davranışı birkaç saniye bekleyerek sınamak yavaş ve kırılgandır. Enjekte edilen bir saat, süre dolumu ve eski kayıt kurallarını deterministik hale getirir. Test, saati ileri alıp sonucu kontrol eder; gerçek sistem saati değiştirilmez.

## Uygulama notları

Saat nesnesi üretim koduna açık bir bağımlılık olarak verildiğinde test ortamı daha anlaşılır olur. Zaman dilimi dönüşümü testleri takvim gününü değil, açık UTC anlarını karşılaştırmalıdır.

## Örnek

```text
const clock = { now: () => new Date("2030-04-05T00:00:00Z") }
```


## Konuya özgü ayrıntılar

Örneğin saat başlangıçta sıfırken kayda on dakikalık ömür verilir; test saati dokuzuncu dakikaya alındığında kayıt bulunur, on birinci dakikada bulunmaz. Aynı düzenek sınır anındaki karşılaştırmanın kapsayıcı olup olmadığını da gösterebilir. Üretimde gerçek saati sağlayan nesne kullanılır. Testler birbirinin saatini değiştirmemeli; her senaryo kendi saat örneğini oluşturmalıdır. Sınır anında kaydın geçerli sayılıp sayılmadığı iş kuralına göre açıkça seçilir.

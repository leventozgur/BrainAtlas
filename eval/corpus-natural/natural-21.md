---
title: "Kuyrukta tekrar ve son kullanma"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Kuyrukta tekrar ve son kullanma

## Neden ele alınıyor

Arka plan kuyruğu geçici kesintilere dayanırken eski işleri sonsuza kadar saklamamalıdır. Her öğe deneme sayısı, son deneme zamanı ve geçerlilik süresi taşır. Artan bekleme aralığı yoğun hata sırasında hedefi daha da zorlamayı engeller.

## Uygulama notları

Son kullanma anından sonra yapılacak işlem iş türüne bağlıdır: bazı kayıtlar atılır, bazıları inceleme için ayrı bir alana taşınır. Bu karar gözlemlenebilir sayaçlarla desteklenir.

## Örnek

```text
retryAfterMs = Math.min(base * 2 ** attempt, ceiling)
```


## Konuya özgü ayrıntılar

Örnek politikada ilk başarısızlıktan sonra iki saniye, ikinci denemeden önce dört saniye beklenir; küçük rastgele sapma eşzamanlı yükü dağıtır. Deneme sayısı beşe ulaşınca iş inceleme kuyruğuna taşınır. Süresi dolmuş bir işi tekrar göndermek iş kuralına aykırı olabilir, bu yüzden son kullanma zamanı her denemeden önce değerlendirilir. Kalıcı doğrulama hataları geçici kesinti gibi tekrar edilmez. Kalıcı hataya sahip öğeler bekletilmek yerine ayrı inceleme akışına alınabilir.

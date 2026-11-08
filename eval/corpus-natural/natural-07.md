---
title: "SwiftUI görünümünde durum sahipliği"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# SwiftUI görünümünde durum sahipliği

## Neden ele alınıyor

SwiftUI görünümünün hangi veriyi sahiplenip hangisini dışarıdan aldığını belirlemek, beklenmeyen yeniden çizimleri anlamayı kolaylaştırır. Kısa ömürlü yerel seçim `@State` ile tutulabilir; paylaşılan modelin yaşam süresi daha üst katmanda yönetilmelidir. Aynı değeri iki yerde kopyalamak tutarsızlık riski taşır.

## Uygulama notları

Önizleme verisi ağ servisine bağlanmadan üretilebilir olursa arayüz varyantları hızlı incelenir. Boş, yükleniyor ve hata durumları ayrı görünüm durumları olarak ele alınmalıdır.

## Örnek

```text
@State private var selectedTab = 0
```


## Konuya özgü ayrıntılar

Sekme seçimi yalnız bir görünümün içindeyse başlangıç değeriyle birlikte orada tutulabilir. Üst görünüm de aynı seçimi okumalıysa değerin sahibi yukarı taşınır ve alt görünüm bağlama üzerinden değiştirir. Örneğin ilk sekmeden ikinciye geçildiğinde yalnız tek kaynak değişmelidir. Görünüm kimliği değişirse yerel durumun sıfırlanabileceği de hesaba katılmalı; kalıcı seçim gerekiyorsa ayrı bir saklama kararı verilmelidir. Sekme kimlikleri yeniden sıralama sonrasında da aynı seçimi göstermelidir; yalnız dizi konumuna güvenmeyin.

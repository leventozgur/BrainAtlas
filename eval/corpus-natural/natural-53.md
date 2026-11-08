---
title: "SwiftUI içinde async yükleme"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# SwiftUI içinde async yükleme

## Neden ele alınıyor

SwiftUI ekranı açılırken `Task` ile başlayan asenkron yükleme, view tekrar yaratıldığında aynı işi gereksiz yere başlatabilir. Sonucun hangi model nesline ait olduğu kontrol edilirse eski response yeni state üzerine yazılmaz.

## Uygulama notları

Loading, empty ve failure durumları birbirinden ayrılır. Kullanıcı ekranı terk ederse cancellation yayılır; tekrar açılışta önbellek politikası ile taze veri isteği birlikte değerlendirilir.

## Örnek

```text
.task(id: recordID) { await model.load(recordID) }
```


## Konuya özgü ayrıntılar

`.task(id: recordID)` ekran görünür olduğunda ilgili kayıt için load başlatır; kimlik değişirse önceki task iptal edilip yeni kimlikle yeniden çalışır. Tekrar açılışta görünümün task yaşam döngüsü yeniden başlar; cache politikası ağ isteği gerekip gerekmediğini belirler. Her response işlenmeden önce kimliğin hâlâ geçerli olduğundan emin olun. Geciktirilmiş iki yanıtı ters sırada bırakan test, eski verinin yeni state değerini ezmediğini gösterir. Aynı recordID ile gereksiz yinelenen load istekleri model katmanında birleştirilebilir.

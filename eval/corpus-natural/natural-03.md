---
title: "Hata ayıklamada ilk gözlem"
status: "superseded"
generated: "2026-10-01"
stale_after: "2025-01-01"
superseded_by: "natural-27.md"
---

# Hata ayıklamada ilk gözlem

## Neden ele alınıyor

Bir hata raporuna hemen çözüm eklemek, belirtinin hangi koşulda ortaya çıktığını belirsiz bırakır. Önce en küçük yeniden üretim adımı, beklenen davranış ve gözlenen fark not edilir. Saat, saat dilimi ve çalıştırma bağlamı kaydedilince benzer görünen iki olayın ayrılması kolaylaşır.

## Uygulama notları

Tekrarlanamayan sorunlarda negatif gözlem de değerlidir: belirli girdiyle hata oluşmadığını yazmak, sonraki denemelerin kapsamını daraltır. Günlüklerde hassas değerler yerine kararlı bir olay kimliği kullanılabilir.

## Örnek

```text
case = { input: "empty", expected: "safe", observed: "panic" }
```


## Konuya özgü ayrıntılar

Örneğin üç adımlı bir senaryoda ilk iki adım başarıyla tamamlanıyor, üçüncü adımda boş sonuç dönüyorsa bunu doğrudan kaydedin. Uygulama sürümü, kullanılan sentetik girdi ve tekrar sayısı aynı notta bulunsun. Beklenen sonuç ile gözlenen sonucu ayrı satırlara yazmak, çözüm önerisinin bulguya karışmasını önler. Başka bir ortamda sonuç değişirse ortam farkını ekleyin; ilk gözlemi silmek yerine tarihli bir düzeltme yapın.

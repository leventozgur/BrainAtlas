---
title: "Tokenization for Turkish search"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
aliases: ["Tokenization reference"]
---

# Tokenization for Turkish search

## Neden ele alınıyor

Türkçe sözcüklerde ekler ve büyük harf dönüşümü arama eşleşmesini etkiler. Unicode normalizasyonu `İ` ile `ı` biçimlerini düşünmeden küçültürse bazı sorgular kaybolabilir. Tokenizer, görünür metni korurken indeks anahtarlarını tutarlı hale getirmelidir.

## Uygulama notları

Stemmer kuralları kısa sözcükleri aşırı kesmemeli; “dosya” ve “dosyalar” aynı kavrama yaklaşırken ayrı kökleri olan teknik tanımlayıcılar bozulmamalıdır. Örnek kümeye hem doğal cümle hem kod adı eklenir.

## Örnek

```text
normalizeText("İndeks") === "indeks"
```


## Konuya özgü ayrıntılar

Örneğin `İSTEK` küçültülürken Türkçe locale kullanımı ile varsayılan dönüşüm farklı sonuç verebilir. Aynı normalizasyon zinciri hem indeksleme hem sorgu aşamasında çalışmalıdır; aksi halde aynı görünen sözcük bulunmayabilir. `I`, `ı`, `İ` ve `i` için ayrı test girdileri tutun ve hangi çiftlerin eşleşeceğini açıkça belirleyin. Kaynak metin gösterimde korunur; yalnız arama anahtarı dönüştürülür. Aynı dönüşüm sürümü kullanıldığında index yeniden oluşturulduktan sonra testler tekrar çalıştırılır.

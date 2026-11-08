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

Stemmer kuralları kısa sözcükleri aşırı kesmemeli; “dosya” ve “dosyalar” aynı kavrama yaklaşırken ayrı kökleri olan teknik tanımlayıcılar bozulmamalıdır. Örnek kümeye hem doğal cümle hem kod adı eklenir. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
normalizeText("İndeks") === "indeks"
```

## İnceleme ölçütü

- Tokenization for Turkish search: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

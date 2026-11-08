---
title: "Aramada eş anlamlı terim sözlüğü"
status: "superseded"
generated: "2026-10-01"
stale_after: "2021-01-01"
aliases: ["Aramada reference"]
superseded_by: "natural-28.md"
---

# Aramada eş anlamlı terim sözlüğü

## Neden ele alınıyor

Bir ekip aynı kavram için zaman içinde farklı sözcükler kullanabilir. Arama katmanındaki eş anlamlılar, belgelerin özgün dilini değiştirmeden bu farklılıkları birbirine bağlar. Sözlüğe eklenen her ilişki için küçük bir olumlu sorgu ve karıştırılmaması gereken bir negatif örnek tutulmalıdır.

## Uygulama notları

Geniş eşleştirme kısa sorgularda ilgisiz sonuçları öne çıkarabilir. Bu yüzden kuralı tümceye yaymak yerine belirgin kavramlara bağlamak ve sonuç sırasını düzenli olarak incelemek gerekir. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
synonyms: { "rollback": ["revert", "geri alma"] }
```

## İnceleme ölçütü

- Aramada eş anlamlı terim sözlüğü: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

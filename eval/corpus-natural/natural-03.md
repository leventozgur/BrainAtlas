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

Tekrarlanamayan sorunlarda negatif gözlem de değerlidir: belirli girdiyle hata oluşmadığını yazmak, sonraki denemelerin kapsamını daraltır. Günlüklerde hassas değerler yerine kararlı bir olay kimliği kullanılabilir. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
case = { input: "empty", expected: "safe", observed: "panic" }
```

## İnceleme ölçütü

- Hata ayıklamada ilk gözlem: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

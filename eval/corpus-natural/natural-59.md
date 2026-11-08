---
title: "Search near miss için excluded belge"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Search near miss için excluded belge

## Neden ele alınıyor

Bir sorgu doğru anahtar sözcüğü içerse bile yanlış konuya ait olabilir. “process” araması için işletim sistemi process sayfası uygundur; adım adım procedure checklist sayfası benzer sözcük yüzünden sonuç olmamalıdır.

## Uygulama notları

Değerlendirme örneği hem `relevant` hem `excluded` yol içerir. Böylece yalnız recall değil, özellikle dikkat edilmesi istenen negatif adayın ilk sonuçlarda yer alıp almadığı da görülebilir. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
excluded: ["natural-052-process-procedure.md"]
```

## İnceleme ölçütü

- Search near miss için excluded belge: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

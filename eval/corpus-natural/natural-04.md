---
title: "Gizli değerleri günlüklerden ayırma"
status: "superseded"
generated: "2026-10-01"
stale_after: "2021-01-01"
keywords: ["Gizli", "reference"]
superseded_by: "natural-58.md"
---

# Gizli değerleri günlüklerden ayırma

## Neden ele alınıyor

Uygulama günlükleri tanılama için yararlıdır; ancak istek gövdelerini veya kimlik doğrulama başlıklarını aynen yazmak gereksiz maruziyet yaratır. Alan izin listesi, hangi bilgilerin kayda girebileceğini açıkça sınırlar. Maskeleme işleminden sonra da günlük satırının olay sırasını açıklayıp açıklamadığı gözden geçirilmelidir.

## Uygulama notları

İnceleme araçları örnek kayıtları sentetik tutmalı ve hata mesajlarını kullanıcı girdisiyle birleştirmemelidir. Saklama süresi, üretim ihtiyacına göre seçilir; sınırsız tutma varsayılan davranış olmamalıdır. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
logger.info({ event: "sync_failed", requestId })
```

## İnceleme ölçütü

- Gizli değerleri günlüklerden ayırma: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

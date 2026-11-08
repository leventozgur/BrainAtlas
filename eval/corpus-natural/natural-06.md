---
title: "iOS isteklerinde iptal davranışı"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# iOS isteklerinde iptal davranışı

## Neden ele alınıyor

Ekran kapanırken devam eden ağ isteğini iptal etmek, gereksiz işi ve eski yanıtın yeni duruma yazılmasını önler. URLSession görevini bir yaşam döngüsü sahibiyle ilişkilendirmek, iptal noktasını görünür kılar. İptal edilen işlem hata günlüğünde beklenmeyen arıza gibi sayılmamalıdır.

## Uygulama notları

Yeniden deneme politikası yalnız geçici ağ sorunlarını hedeflemelidir. Aynı isteğin iki kez uygulanması yan etki üretiyorsa idempotency anahtarı veya sunucu tarafında tekilleştirme düşünülür. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
let task = URLSession.shared.dataTask(with: request)
```

## İnceleme ölçütü

- iOS isteklerinde iptal davranışı: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

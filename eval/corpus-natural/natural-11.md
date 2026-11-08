---
title: "Şema göçünde geri dönüş noktası"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
aliases: ["Şema reference"]
---

# Şema göçünde geri dönüş noktası

## Neden ele alınıyor

Veri şemasını değiştiren bir göç, yalnız yeni uygulamayla birlikte değerlendirilemez. Önce geri yüklenebilir bir anlık görüntü alınır, ardından göç boş bir kopyada çalıştırılır ve satır sayısı gibi değişmezler karşılaştırılır. Üretim adımı için durdurma ölçütleri önceden kararlaştırılır.

## Uygulama notları

İleri yöndeki dönüşüm tamamlandıktan sonra eski uygulamanın yeni biçimi okuyamayacağı hesaba katılmalıdır. Gerekirse genişlet ve daralt yaklaşımıyla iki biçim kısa süre birlikte yaşatılır. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
migration.version = "v1.2.3"
```

## İnceleme ölçütü

- Şema göçünde geri dönüş noktası: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

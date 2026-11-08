---
title: "Dağıtımda canary health eşikleri"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Dağıtımda canary health eşikleri

## Neden ele alınıyor

Canary dağıtımında küçük trafik oranı, yeni sürümün gerçek istek biçimleriyle karşılaşmasını sağlar. Başarı eşiği yalnız HTTP 200 oranı değildir; latency ve kaynak baskısı da izlenir. `v1.2.3` etiketi örnek bir revision olarak kalır.

## Uygulama notları

Eşikler deneme öncesi yazılırsa operatör kötü sinyali görmezden gelmekte daha az serbest kalır. Otomatik rollback sonrası eski sürümün yeniden hazır olduğu da doğrulanmalıdır. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
canary.setWeight(5); await health.check()
```

## İnceleme ölçütü

- Dağıtımda canary health eşikleri: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

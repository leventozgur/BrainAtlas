---
title: "Güvenli geçici dizin kullanımı"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Güvenli geçici dizin kullanımı

## Neden ele alınıyor

Test sırasında oluşturulan dosyalar sabit bir çalışma dizinine bırakılmamalıdır. İşletim sisteminin geçici alanında benzersiz bir klasör açılır ve test bitince özyinelemeli temizlenir. Temizleme, hata yolunda da çalışacak bir `finally` bloğuna bağlanır.

## Uygulama notları

Gerçek kullanıcı ana dizinini okumak testleri kişisel yapılandırmaya bağımlı kılar. `HOME` ve XDG yolları izole bir geçici konuma yönlendirilirse aynı test yerel ve sürekli entegrasyon ortamında benzer davranır. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
const temp = await mkdtemp(join(tmpdir(), "fixture-"))
```

## İnceleme ölçütü

- Güvenli geçici dizin kullanımı: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

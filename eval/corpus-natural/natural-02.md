---
title: "Dağıtımda kademeli trafik aktarımı"
status: "superseded"
generated: "2026-10-01"
stale_after: "2021-01-01"
aliases: ["Dağıtımda reference"]
superseded_by: "natural-56.md"
---

# Dağıtımda kademeli trafik aktarımı

## Neden ele alınıyor

Yeni sürümün bütün istekleri aynı anda alması, geri dönüş kararını pahalılaştırabilir. Önce küçük bir trafik dilimi yeni sürüme yönlendirilir; gecikme, hata oranı ve kaynak kullanımı önceden belirlenen aralıkta izlenir. Ölçüm penceresi yeterince uzun değilse kısa süreli sessizlik başarı kanıtı sayılmaz.

## Uygulama notları

İlerleme adımı, gözlenen sonuca göre büyür. Eşik aşıldığında otomasyon trafiği durdurur ve eski hedefi tekrar seçer; operatörün ezberden komut çalıştırması beklenmez. Bir değişiklikten sonra beklenen davranışı küçük bir örnekle doğrulayın; yalnız başarılı komut çıkışına güvenmeyin. Kayıt, sonucu ve sınır koşulunu birlikte anlattığında sonraki bakım daha az varsayıma dayanır.

## Örnek

Bu kısa örnek kavramın kullanım biçimini gösterir; gerçek bir sisteme veya kullanıcı verisine bağlı değildir. Önce girdiyi doğrulayın, ardından sonucu gözlenen bir koşulla karşılaştırın.

```text
route --revision v1.2.3 --weight 10
```

## İnceleme ölçütü

- Dağıtımda kademeli trafik aktarımı: kapsam ve varsayımlar açıkça yazılmış olmalı.
- Sonuç, sentetik bir örnek üzerinde yeniden üretilebilmeli.
- Belirsizlik varsa kayıt kesin hüküm vermek yerine doğrulama adımını belirtmeli.

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

İlerleme adımı, gözlenen sonuca göre büyür. Eşik aşıldığında otomasyon trafiği durdurur ve eski hedefi tekrar seçer; operatörün ezberden komut çalıştırması beklenmez.

## Örnek

```text
route --revision v1.2.3 --weight 10
```


## Konuya özgü ayrıntılar

Örnek bir geçişte önce yüzde beşlik dilim on dakika izlenir; hata oranı önceki sürümün iki katına çıkarsa aktarım durdurulur. Eski hedefin kapasitesi geri dönüş boyunca korunur. İstek sayısı çok azsa süre uzatılır, çünkü birkaç başarılı yanıt tüm trafiği temsil etmez. Geri dönüş tamamlandıktan sonra hata oranının normale dönmesi ve bekleyen bağlantıların boşalması kontrol edilir. Bu eşikler uygulamanın olağan yüküne göre ayrıca belirlenmelidir.

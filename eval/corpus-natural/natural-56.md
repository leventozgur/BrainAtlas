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

Eşikler deneme öncesi yazılırsa operatör kötü sinyali görmezden gelmekte daha az serbest kalır. Otomatik rollback sonrası eski sürümün yeniden hazır olduğu da doğrulanmalıdır.

## Örnek

```text
canary.setWeight(5); await health.check()
```


## Konuya özgü ayrıntılar

Örnek rollout yüzde beş trafikle başlar ve on dakika boyunca hata oranı, p95 latency ve kaynak kullanımı izlenir. Hata oranı eski revision değerinin iki katına çıkarsa veya latency belirlenen bütçeyi aşarsa ilerleme durur ve rollback tetiklenir. Düşük istek hacminde pencere uzatılır. Eski hedefin hazır olduğu görüldükten sonra trafik geri verilir; eşikler gerçek iş yüküne göre önceden seçilmelidir. Rollback tamamlandığında yeni revision tekrar denenmeden önce gözlenen sinyaller incelenir.

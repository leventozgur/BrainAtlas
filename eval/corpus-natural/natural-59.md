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

Değerlendirme örneği hem `relevant` hem `excluded` yol içerir. Böylece yalnız recall değil, özellikle dikkat edilmesi istenen negatif adayın ilk sonuçlarda yer alıp almadığı da görülebilir.

## Örnek

```text
excluded: ["natural-052-process-procedure.md"]
```


## Konuya özgü ayrıntılar

Örnekte işletim sistemi process belgesi pozitif, fixture yenileme procedure belgesi negatif adaydır. Her ikisinde benzer sözcükler bulunabilir; PID ve scheduler gibi bağlamlar ilk anlamı güçlendirir. Sonuç listesinde pozitif adayın bulunması recall için önemlidir, fakat negatif adayın yüksek sıraya çıkması ayrıca incelenmelidir. Etiketler sorgunun tam niyetini yansıtmalı; yalnız ortak terime göre verilmemelidir. Negatif adayın belgede bulunması beklenir; yalnız alakasız bir belge seçmek yakın anlam sınamasını zayıflatır.

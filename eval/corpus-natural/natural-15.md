---
title: "Saat damgasında UTC tercihi"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
keywords: ["Saat", "reference"]
---

# Saat damgasında UTC tercihi

## Neden ele alınıyor

Dağıtık sistemlerde yerel saat farkları olay sırasını yanlış gösterebilir. Saklama biçiminde UTC kullanıp görüntüleme katmanında okuyucunun saat dilimine çevirmek karşılaştırmayı kolaylaştırır. Saat dilimi bilgisi olmayan tarih dizgeleri makineden makineye farklı yorumlanabilir.

## Uygulama notları

Duvar saati sıçrayabileceği için süre ölçümünde monotonik sayaç tercih edilir. Gün ışığı geçişi ve artık saniye gibi sınır durumları takvim hesabıyla gecikme ölçümünün aynı şey olmadığını hatırlatır.

## Örnek

```text
timestamp = new Date().toISOString()
```


## Konuya özgü ayrıntılar

Örneğin `2026-10-01T09:30:00Z` açık bir UTC anıdır; arayüz bunu kullanıcının seçtiği bölgede gösterebilir. Saklanan değeri yerel saat metniyle değiştirmek yerine dönüşüm yalnız gösterimde yapılır. İki olay arasındaki geçen süre için monotonik saat kullanılır; sistem saatinin düzeltilmesi süreyi negatife çevirmemelidir. Saat dilimi olmayan eski kayıtlar dönüştürülürken varsayım ayrıca belgelenir. Yaz saati geçişindeki tekrarlanan yerel saatler, saklanan UTC anlarıyla birbirinden ayrılabilir.

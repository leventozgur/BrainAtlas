---
title: "Eşzamanlı yazımda atomik dosya değişimi"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Eşzamanlı yazımda atomik dosya değişimi

## Neden ele alınıyor

Bir yapılandırma dosyası doğrudan üzerine yazılırken işlem kesilirse okuyucu yarım içerik görebilir. Güvenli yaklaşım, aynı dizinde geçici dosya oluşturmak, içeriği tamamlamak ve son adımda atomik yeniden adlandırma yapmaktır. Dizin sınırı, dosya sisteminin atomiklik koşulu açısından önemlidir.

## Uygulama notları

Yazma izni olmayan bir hedefte hata kontrollü biçimde ele alınır. Geçici dosya adı sabit olmamalı; paralel süreçlerin birbirinin hazırlığını ezmesine izin verilmemelidir.

## Örnek

```text
rename("settings.tmp-42", "settings.json")
```


## Konuya özgü ayrıntılar

Geçici dosya tamamlandıktan sonra kapatılır ve hedefin bulunduğu dizinde yeniden adlandırılır. Kalıcılık gereksinimi varsa dosyanın ve uygun durumlarda dizinin diske aktarılması ayrıca ele alınır. Okuyucu denemelerinde eski veya yeni içeriğin tamamı görülmeli, kesilmiş bir JSON parçası görülmemelidir. Yazma başarısız olursa geçici dosya temizlenir ve önceki ayar korunur; farklı dosya sistemleri arasında atomiklik varsayılmaz. Paralel yazıcılar ayrı geçici adlar kullanmalı ve son güncelleme politikası belirlenmelidir.

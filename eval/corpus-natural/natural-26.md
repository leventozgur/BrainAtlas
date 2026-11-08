---
title: "Görüntü yüklemede kademeli boyut"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Görüntü yüklemede kademeli boyut

## Neden ele alınıyor

Mobil arayüzde büyük bir görseli ilk kareden itibaren tam boyutta indirmek, yavaş bağlantıda boş alan bırakabilir. Küçük önizleme hızlı çizilirken yüksek çözünürlüklü kaynak arka planda alınabilir. İptal edilen hücre isteği başka içeriğe ait sonucu ekrana yazmamalıdır.

## Uygulama notları

Önbellek anahtarı görsel varyantını da içermelidir; aynı kaynak için küçük ve büyük kopyalar birbirini ezmemelidir. Erişilebilir alternatif metin görselin aktarım başarısına bağlı kalmaz.

## Örnek

```text
imageURL.appending(path: "thumb")
```


## Konuya özgü ayrıntılar

Liste hücresi başka bir kayda dönüştürüldüğünde önceki isteğin sonucu görsel kimliğiyle karşılaştırılır. Küçük önizleme ile büyük kaynak farklı boyut anahtarları altında tutulur. İndirme başarısızsa boş bir alan yerine erişilebilir açıklama ve yeniden deneme durumu gösterilebilir. Ölçümde ilk görselin görünme süresi ile tam çözünürlüğün tamamlanma süresi ayrı ele alınır; ikisini karıştırmak algılanan iyileşmeyi gizler. Ekran yoğunluğuna uygun görsel boyutu seçmek gereksiz aktarımı azaltabilir.

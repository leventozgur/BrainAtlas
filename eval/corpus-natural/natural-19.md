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

Gerçek kullanıcı ana dizinini okumak testleri kişisel yapılandırmaya bağımlı kılar. `HOME` ve XDG yolları izole bir geçici konuma yönlendirilirse aynı test yerel ve sürekli entegrasyon ortamında benzer davranır.

## Örnek

```text
const temp = await mkdtemp(join(tmpdir(), "fixture-"))
```


## Konuya özgü ayrıntılar

Her test benzersiz bir geçici dizin açar, çocuk sürecin ortam değişkenlerini bu dizine yönlendirir ve sonunda tüm içeriği siler. Örneğin isteğe bağlı ayar dosyası aranırken gerçek kullanıcı profilinde dosya olup olmaması sonucu değiştirmemelidir. Temizlik başarısızlık durumunda da çalışır. İki test paralel yürüdüğünde aynı sabit dosya adını paylaşmamaları, birbirlerinin çıktısını silmelerini önler. Geçici dizinin boş bırakılıp bırakılmadığı süreç çıkışından sonra ayrıca kontrol edilebilir.

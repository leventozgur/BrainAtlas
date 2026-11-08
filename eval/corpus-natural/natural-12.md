---
title: "Yapılandırmada varsayılan değerler"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Yapılandırmada varsayılan değerler

## Neden ele alınıyor

Eksik yapılandırma alanına güvenli bir varsayılan vermek ilk kurulumu kolaylaştırır, fakat varsayılan sessizce tehlikeli bir davranış açmamalıdır. Zorunlu değerlerle isteğe bağlı ayarlar ayrılır; hata mesajı alan adını söyler, değer içeriğini tekrar etmez.

## Uygulama notları

Yükleme sırasında doğrulama yapmak hatayı erken ve tek yerde bildirir. Ortam değişkenleri testte açıkça sağlanmalı, gerçek makinenin kullanıcı ayarları davranışa sızmamalıdır.

## Örnek

```text
const timeoutMs = config.timeoutMs ?? 5000
```


## Konuya özgü ayrıntılar

Örneğin isteğe bağlı bağlantı sayısı verilmezse sınırlı bir değer seçilebilir; gerekli depo yolu eksikse işlem başlamadan alan adıyla hata verilir. Negatif sayı veya beklenmeyen metin de varsayılanmış gibi kabul edilmez. Hata çıktısında yalnız ayarın adı ve beklenen tür yer alır. Testte eksik, geçerli ve yanlış türdeki üç durum ayrı ayrı çalıştırılarak davranışın kararlı kaldığı görülür. Varsayılan değerin uygulama davranışına etkisi yapılandırma açıklamasında belirtilir. Hatalı değer işlemin başlamasını engeller.

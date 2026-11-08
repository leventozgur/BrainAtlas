---
title: "Girdi yolu sınırlandırması"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Girdi yolu sınırlandırması

## Neden ele alınıyor

Kullanıcıdan gelen göreli yol, beklenen kökün dışına çıkmaya çalışabilir. Önce normalize etmek, ardından çözümlenmiş hedefin izinli kök altında kaldığını doğrulamak gerekir. Yalnız metin öneki karşılaştırması benzer başlangıçlı dizinlerde yanıltıcıdır.

## Uygulama notları

Sembolik bağlar da gerçek hedefi değiştirebildiği için okuma stratejisi açıkça tanımlanmalıdır. Hata mesajı reddedilen içeriği kopyalamadan genel bir sınır ihlali bildirir.

## Örnek

```text
const target = resolve(root, requestPath)
```


## Konuya özgü ayrıntılar

Örneğin `../` içeren bir girdi reddedilir; `docs-old` klasörünün `docs` ile aynı öneki taşıması yetki vermez. Çözümlenmiş göreli yolun üst dizine çıkıp çıkmadığı yol bileşenleri üzerinden kontrol edilir. Sembolik bağlara izin verilecekse gerçek hedef de aynı sınır içinde olmalıdır. Yazma işlemlerinde kontrol ile açma arasındaki yarış ayrıca değerlendirilir; yalnız dizge temizleme her platformda yeterli değildir. Mutlak yol girişlerini reddetmek, göreli yol doğrulamasından önce uygulanabilecek ek bir sınırdır. Bağların hedefi de izinli kökte kalmalıdır.

---
title: Basil installation
status: active
generated: "2026-03-27"
---
# Basil installation

Basil kurulumu, paketi indirip kurulum betiğini çalıştırmakla tamamlanır. Kurulum yalnızca kullanıcı dizinine yazar ve sistem genelinde bir servis tanımlamaz. Kurulumdan sonra komut satırında sürümü kontrol etmek yeterlidir.

## Adımlar
Önce paket özetinin doğru olduğunu kontrol edin. Ardından kurulum betiğini tek seferde çalıştırın; betik eksik bağımlılık gördüğünde durur ve hangi bağımlılığın eksik olduğunu yazar. Kurulum tamamlandıktan sonra doctor komutunu bir kez çalıştırmak, yerel kilit dosyalarında sorun olmadığını gösterir.

## Platform notları
macOS ve Linux üzerinde kurulum test edilmiştir. Windows kurulumu şu an desteklenmiyor; bu platform için ayrı bir paket planlanıyor ama tarih verilmedi. Eski sürüm kalıntıları kaldırılırken yapılandırma dosyası korunur.

## Sorun giderme
Kurulum sonrası hata alan kullanıcılar [[errors/basil-errors]] sayfasındaki kilit hatalarını ve [[cli/basil-flags]] sayfasındaki seçenekleri inceleyebilir.

## Güncelleme
Güncelleme, mevcut yapılandırmayı silmeden yeni paketi üzerine kurar. Güncelleme sonrasında sürüm kontrolü ve doctor komutu birlikte çalıştırılmalıdır. Eski sürüme dönmek için önceki paket özeti saklanır.

## Kaldırma
Kaldırma komutu paketi ve kullanıcı dizinindeki kurulum kayıtlarını siler. Yapılandırma dosyası ayrıca onay istenmedikçe silinmez. Kaldırma sonrasında kilit dosyası kalmadığını doğrulamak için doctor komutu bir kez çalıştırılabilir.

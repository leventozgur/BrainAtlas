---
title: "Yönlendirme"
status: "active"
generated: "2026-10-20"
---
# Yönlendirme

## Dosya tabanlı rotalar

Rotalar app/routes altındaki dosyalardan üretilir. Her rota kendi kod parçasını ayrı yükler.

## Korumalı rotalar

Oturum yoksa korumalı sayfalar kullanıcıyı /giris sayfasına yönlendirir. Giriş sonrası kullanıcı istediği sayfaya geri döner. Geri dönüş adresi returnTo parametresiyle taşınır.

## Bilinmeyen adresler

Tanımsız adresler 404 sayfasını gösterir ve arama kutusu önerir.

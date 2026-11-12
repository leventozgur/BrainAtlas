---
title: "Uçtan uca testler"
status: "active"
generated: "2026-10-20"
---
# Uçtan uca testler

## Çalıştırma

npm run e2e komutu Playwright testlerini çalıştırır. Testler yerel sunucuyu kendisi başlatır.

## Giriş testi karantinası

Giriş akışı testi 2026-09-08'den beri kararsız çalışıyordu: yanıt gecikince düğme görünmeden tıklanıyordu. Test karantinaya alındı ve LMN-4 kaydı açıldı.

## Seçiciler

Seçiciler data-testid özniteliğiyle yazılır. Metin tabanlı seçiciler kullanılmaz.

## Başarısız bir testi düzeltme

Önce testin hangi adımda düştüğü raporda kontrol edilir. Seçici değiştiyse data-testid güncellenir; zamanlama sorunuysa bekleme koşulu eklenir, sabit süre beklemesi eklenmez.

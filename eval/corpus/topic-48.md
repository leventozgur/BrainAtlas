---
title: Concurrent workers
status: active
---
# Concurrent workers

## Uygulama
Bu sayfa concurrent workers için ekip uygulamasını açıklar. İşlem başlamadan önce sorumlu kişi bağımlılıkları ve mevcut durumu kontrol eder. Beklenmeyen bir sonuç görülürse değişiklik durdurulur ve olay kaydı açılır.

## Kontrol
İngilizce operasyon notu: protect shared state with a transaction or lock. Ekip sonucu gözden geçirir ve doğrulama kanıtını kayıt altında tutar. Bir sonraki bakım döneminde bu karar tekrar değerlendirilir.

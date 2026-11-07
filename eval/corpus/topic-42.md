---
title: Retry strategy
status: active
---
# Retry strategy

## Uygulama
Bu sayfa retry strategy için ekip uygulamasını açıklar. İşlem başlamadan önce sorumlu kişi bağımlılıkları ve mevcut durumu kontrol eder. Beklenmeyen bir sonuç görülürse değişiklik durdurulur ve olay kaydı açılır.

## Kontrol
İngilizce operasyon notu: use bounded exponential backoff with jitter. Ekip sonucu gözden geçirir ve doğrulama kanıtını kayıt altında tutar. Bir sonraki bakım döneminde bu karar tekrar değerlendirilir.

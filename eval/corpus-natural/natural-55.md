---
title: "CI job süresinde cache etkisi"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
keywords: ["CI", "reference"]
---

# CI job süresinde cache etkisi

## Neden ele alınıyor

CI job süresi yalnız komutun çalışma zamanı değildir; queue beklemesi ve cache restore adımları da toplam geri bildirimi etkiler. Cache hit görülse bile doğruluk, temiz ortamda yapılan periyodik derlemeye bağlı kalmalıdır.

## Uygulama notları

Ölçüm raporunda p50 ile p95 ayrı verilir. `packages/core/src/x.mjs` değişikliğinin hangi iş zincirini tetiklediği kaydedilirse gereksiz matris genişlemesi ayırt edilebilir.

## Örnek

```text
job: { timeout-minutes: 12 }
```


## Konuya özgü ayrıntılar

Bu örnek CI politikası clean build işini her gece ve her release adayı için çalıştırır; normal commit işlerinde cache kullanılabilir. Risk yükselirse ekip sıklığı artırabilir, ancak her gece karşılaştırması eksik cache key etkisini erken ortaya çıkarır. Clean job önce cache restore adımını atlar ve bağımlılıkları kilit dosyasından kurar. Cache'li job ile çıktı farklıysa key girdileri ve üretilen dosyalar incelenir. Release job çıktısı aynı revision için cache kullanılan job çıktısıyla karşılaştırılır.

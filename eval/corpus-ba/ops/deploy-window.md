---
title: Deploy penceresi
status: active
generated: "2026-06-11"
aliases: [deploy penceresi, dağıtım saatleri]
---
# Deploy penceresi

Üretim deploy işlemleri hafta içi 10:00 ile 16:00 arasında yapılır. Cuma günleri ve resmi tatilden önceki iş günleri üretim deploy'u yapılmaz; yalnızca güvenlik düzeltmeleri bu kuralın dışında tutulabilir ve güvenlik lideri onayı gerektirir.

## Nöbet değişimi
Nöbet değişimi ile çakışan deploy'lar gelen birincil nöbetçinin onayını almalıdır. Onay olmadan başlayan bir deploy, nöbet ekibi tarafından durdurulabilir. Nöbet düzeni ayrıntıları için [[ops/oncall]] sayfasına bakın.

## Deploy sırasında izleme
Deploy sırasında geri alma kriterleri [[release/rollout-policy]] sayfasında tanımlıdır. Backlog ve hata oranı panelleri [[ops/monitoring]] içinde açıklanmıştır.

## İstisnalar
Acil müşteri etkisi olan durumlarda deploy penceresi dışında işlem yapılabilir. Bu durumda olay kaydına gerekçe ve onaylayan kişi yazılır.

## Geri alma
Deploy sonrasında hata oranı artarsa geri alma kararı, sürüm sahibi ve nöbetçi tarafından birlikte verilir. Geri alma paketi bir önceki sürüm olduğundan yeniden derleme gerekmez. Geri alma sonrası kısa bir olay notu yazılır.

## Dokümantasyon
Deploy sırasında değişen bir işletim adımı varsa ilgili runbook sayfası aynı değişiklikle güncellenir. Güncelleme yapılmadan deploy penceresi kapatılmaz; bu kural ekip inceleme sürecinin bir parçasıdır.

---
title: "Dağıtım runbook"
status: "active"
generated: "2026-10-20"
---
# Dağıtım runbook

## Canary

Yeni sürüm önce trafiğin yüzde 5'ine açılır. Hata oranı 15 dakika boyunca binde beşin altında kalırsa trafik yüzde 50'ye çıkarılır.

## Geri alma

Canary başarısız olursa kestrel rollback komutu hedef sürümle çalıştırılır. Geri alma veritabanı şemasını değiştirmez; şema geçişleri ileri yönlüdür.

## Migrasyonlar

Şema geçişleri dağıtımdan önce tek seferde uygulanır.

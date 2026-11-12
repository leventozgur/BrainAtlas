---
title: "Olay raporu 2026-09 zaman aşımı"
status: "active"
generated: "2026-10-20"
---
# Olay raporu: 2026-09 zaman aşımı

## Özet

2026-09-03 tarihinde QUARRY_JOB_TIMEOUT değeri 60 saniyeye düşürüldü. Uzun süren yedekleme işleri zaman aşımına uğradı.

## Kök neden

Zaman aşımı değeri ortam değişkeninde yanlış birimle girilmişti: saniye yerine dakika beklenirken saniye yazılmıştı.

## Düzeltme

Değer 900 saniyeye çıkarıldı ve ortam değişkeni şablonu birim adını içerecek şekilde güncellendi.

---
title: "Backup arşivinde bütünlük manifesti"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
---

# Backup arşivinde bütünlük manifesti

## Neden ele alınıyor

Yedek arşivine dosya boyutu ve kriptografik checksum içeren manifest eklemek, aktarım bozulmasını geri yüklemeden önce yakalayabilir. Manifestin kendisi de arşivle birlikte imzalanmalı ya da güvenilir ayrı kanalda doğrulanmalıdır.

## Uygulama notları

Bütünlük kontrolü erişilebilirlik kontrolü değildir; şifre çözme ve uygulama düzeyinde okuma ayrıca prova edilir. Küçük bir sentetik fixture üzerinde beklenen checksum sabitlenebilir.

## Örnek

```text
sha256: 8f3a... (illustrative only)
```


## Konuya özgü ayrıntılar

Manifest, her dosyanın boyutunu ve checksum değerini listeler; doğrulamada yeniden hesaplanan değer beklenen değerle karşılaştırılır. Eşleşme, güvenilir manifestle karşılaştırılan baytların değişmediğine dair kanıttır; arşivin eksiksiz ya da içeriğin uygulama açısından doğru olduğunu tek başına kanıtlamaz. İmzalı manifestin doğrulanması ve ayrı bir restore provası gerekir. Eksik dosya ile yanlış checksum ayrı sonuçlar olarak raporlanır. Manifest başka bir kanaldan doğrulanmazsa saldırgan hem dosyayı hem beklenen checksum değerini değiştirebilir. Restore denemesi checksum kontrolünden ayrı tutulur.

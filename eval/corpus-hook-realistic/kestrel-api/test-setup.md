---
title: "Test kurulumu"
status: "active"
generated: "2026-10-20"
---
# Test kurulumu

## Birim testleri

npm test komutu birim testlerini çalıştırır. Dış servis gerekmez.

## Entegrasyon testleri

Entegrasyon testleri yerel PostgreSQL'i 127.0.0.1:5544 portunda bekler. Port kapalıysa docker compose up -d db komutu veritabanını başlatır.

## Karantina

Kararsız testler quarantine etiketiyle işaretlenir ve CI'da çalıştırılmaz. Etiketli testler haftalık raporda listelenir.

## Test düzeltme

Başarısız bir testi düzeltmeden önce yerel veritabanının sıfırlandığından emin olun; testler paylaşılan veri üzerinde çalışmamalıdır. Kararsız testte önce hangi adımın düştüğü kontrol edilir.

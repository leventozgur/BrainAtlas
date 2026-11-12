---
title: "Bağlantı havuzu"
status: "active"
generated: "2026-10-20"
---
# Bağlantı havuzu

## Ayarlar

Havuzun en fazla 20 bağlantısı vardır. Bağlantı alma (acquire) zaman aşımı 3000 milisaniyedir.

## Zaman aşımı hatası

Timeout acquiring connection from pool hatası, havuzdaki tüm bağlantılar meşgulken 3000 ms içinde boş bağlantı bulunamazsa oluşur. Önce uzun süren sorgular kontrol edilmeli, ardından havuz boyutu artırılmalıdır. Havuz boyutu 40'ı geçmemelidir.

## Sızıntı tespiti

Bağlantısını serbest bırakmadan dönen işlemler, havuz metriklerinde kullanım oranının yüzde 100'de sabit kalmasıyla görünür.

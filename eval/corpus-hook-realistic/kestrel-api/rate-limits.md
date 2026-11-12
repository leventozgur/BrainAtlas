---
title: "Hız sınırları"
status: "active"
generated: "2026-10-20"
---
# Hız sınırları

## Kiracı başına kota

Her kiracı için dakikada 1200 istek sınırı uygulanır. Sınır kiracı kimliğine göre sayılır; aynı kiracının birden çok anahtarı aynı kotayı paylaşır.

## 429 yanıtı

Sınır aşıldığında API 429 Too Many Requests döndürür. Retry-After başlığı bekleme süresini saniye olarak verir. İstemci bu süreden önce yeniden denememelidir.

## Toplu uç noktalar

Toplu içe aktarma uç noktalarında sınır dakikada 60 istektir ve ayrıca günlük 50.000 kayıt tavanı vardır.

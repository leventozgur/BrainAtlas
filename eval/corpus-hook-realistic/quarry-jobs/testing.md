---
title: "Quarry testleri"
status: "active"
generated: "2026-10-20"
---
# Quarry testleri

## Birim testleri

Birim testleri sahte veritabanıyla çalışır ve npm test ile koşar.

## Zamanlayıcı testi

Zamanlayıcı testi gerçek saat yerine sahte saat kullanır. Testin kararsızlığı çoğunlukla sahte saatin ilerletilmemesinden kaynaklanır; advanceTimersByTime çağrısı eklenmelidir.

## Test verisi

Her test kendi şemasını oluşturur ve bitince temizler.

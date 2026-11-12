---
title: "Zamanlayıcı"
status: "active"
generated: "2026-10-20"
---
# Zamanlayıcı

## Çalışma aralığı

Zamanlayıcı her 5 dakikada bir çalışır ve vadesi gelen işleri kuyruğa alır.

## Lider seçimi

Birden fazla zamanlayıcı örneği çalışsa da yalnızca advisory lock tutan örnek iş alır. Kilit quarry:scheduler adıyla tutulur.

## Çakışma kuralı

Bir iş hâlâ çalışıyorsa zamanlayıcı aynı işi ikinci kez başlatmaz; iş atlanır ve metrik sayacı artırılır.

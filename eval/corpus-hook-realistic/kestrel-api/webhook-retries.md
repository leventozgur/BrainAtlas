---
title: "Webhook yeniden denemesi"
status: "active"
generated: "2026-10-20"
---
# Webhook yeniden denemesi

## Deneme politikası

Başarısız webhook teslimi en fazla 6 kez denenir. İlk deneme hemen yapılır; sonraki aralıklar 30 saniye tabanıyla iki katına çıkar.

## Kabul edilen yanıtlar

2xx yanıtı teslim başarılı sayılır. 4xx yanıtları (410 hariç) yeniden denenmez; 5xx yanıtları ve zaman aşımları yeniden denenir. 410 yanıtında teslim kalıcı olarak durdurulur.

## İmza

Her istek X-Kestrel-Signature başlığı taşır. İmza HMAC-SHA256 ile hesaplanır ve gövde üzerinden doğrulanır.

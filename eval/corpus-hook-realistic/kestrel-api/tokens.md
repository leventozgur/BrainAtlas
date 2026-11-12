---
title: "Erişim belirteçleri"
status: "active"
generated: "2026-10-20"
---
# Erişim belirteçleri

## Erişim belirteci ömrü

Erişim belirteci 15 dakika geçerlidir. Süre dolunca istemci yenileme isteği göndermelidir.

## Döndürme penceresi

Belirteç döndürüldüğünde eski belirteç 10 dakika daha geçerli kalır. Bu süre döndürme penceresi olarak adlandırılır. Pencere kapandıktan sonra eski belirteçle yapılan istekler 401 döner.

## Yenileme isteği

POST /v2/auth/refresh uç noktası yeni bir erişim belirteci üretir. Yenileme belirteci 14 gün geçerlidir. 2026-10-20 güncellemesiyle geçersiz yenileme belirteci artık AUTH_REFRESH_INVALID kodu döndürür.

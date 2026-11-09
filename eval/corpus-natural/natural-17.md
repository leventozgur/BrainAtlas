---
title: "İstek tekrarında idempotency anahtarı"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
aliases: ["İstek reference"]
---

# İstek tekrarında idempotency anahtarı

## Neden ele alınıyor

İstemci yanıt alamadığında isteğin sunucuda işlenip işlenmediğini bilemeyebilir. Tekrarlı gönderimde aynı idempotency anahtarını kullanmak, işlemin iki kez uygulanmasını önleyebilir. Anahtarın kapsamı ve saklama süresi iş kuralıyla birlikte belirlenmelidir.

## Uygulama notları

Farklı içerik için aynı anahtar gelirse istek sessizce kabul edilmemeli; tutarsızlık raporlanmalıdır. Okuma işlemlerinde tekrar genellikle güvenlidir, ancak yazma yan etkileri ayrıca incelenir.

## Örnek

```text
headers.set("Idempotency-Key", operationToken)
```


## Konuya özgü ayrıntılar

İlk gönderim için oluşturulan anahtar, bağlantı kesilse bile aynı mantıksal işlemin sonraki denemelerinde korunur. Sunucu anahtarı istek özeti ve sonuçla birlikte saklar; aynı içerik tekrar geldiğinde önceki sonucu döndürür. Farklı içerik aynı anahtarla gelirse çatışma bildirir. Saklama süresi sona erdiğinde eski anahtarın yeniden işlenebileceği kabul edilir; bu nedenle süre istemcinin yeniden deneme penceresini kapsamalıdır. Aynı anahtarın farklı kullanıcı kapsamlarında nasıl ayrılacağı da sunucu sözleşmesinde belirtilir.

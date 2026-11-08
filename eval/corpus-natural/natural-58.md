---
title: "Güvenlik raporunda redaction"
status: "active"
generated: "2026-10-01"
stale_after: "2025-01-01"
aliases: ["Güvenlik reference"]
---

# Güvenlik raporunda redaction

## Neden ele alınıyor

Security log içinde `Authorization` header veya token saklamak, olay incelemesini kolaylaştırıyor gibi görünse de yeni bir sır kopyası oluşturur. Redaction, logger çağrısına bırakılmak yerine sınır katmanında allowlist ile uygulanmalıdır.

## Uygulama notları

Test fixture içindeki değerler sahte ve açıkça geçersiz biçimde seçilir. Hata yolu da maskelemeyi korur; exception nesnesinin ham request nesnesini taşıması engellenir.

## Örnek

```text
safeHeaders = redact(headers, ["authorization", "cookie"])
```


## Konuya özgü ayrıntılar

Redaction istek sınırında, herhangi bir logger çağrısından önce uygulanır; `Authorization` header değeri olay nesnesine hiç aktarılmaz. Allowlist yalnız yöntem, sonuç sınıfı ve güvenli korelasyon alanı gibi gerekli bilgileri seçer. Sentetik fixture ile hem başarılı yanıt hem exception yolu sınanır. Exception ham request nesnesini taşıyorsa yalnız üst düzey mesajı maskelemek yeterli değildir; tüm serileştirme yolu incelenir. Allowlist dışında kalan alanlar varsayılan olarak log içine alınmaz; yeni alanlar ayrıca gözden geçirilir.

---
title: "Yedekleme için geri yükleme provası"
status: "superseded"
generated: "2026-10-01"
stale_after: "2021-01-01"
superseded_by: "natural-57.md"
---

# Yedekleme için geri yükleme provası

## Neden ele alınıyor

Yedekleme planının işe yaradığı, dosyaların yazıldığı gün değil geri yükleme sırasında anlaşılır. Küçük bir deneme ortamı seçip envanter, şifre çözme anahtarı ve beklenen sonuçları önceden kaydetmek, sessiz bozulmayı görünür kılar. Prova takvimini saklama süresine bağlamak yerine değişiklik riskine göre sıklaştırmak daha anlamlıdır.

## Uygulama notları

Bir arşiv okunabiliyor diye içindeki her kaydın tutarlı olduğu varsayılmaz; örnekleme ve bütünlük özeti ayrı kontrollerdir.

## Örnek

```text
restore --source snapshot-17 --target scratch-vault
```


## Konuya özgü ayrıntılar

Aylık bir prova için rastgele iki arşiv seçilir ve ayrı bir deneme deposuna yüklenir. Dosya sayısı envanterle karşılaştırılır; örnek kayıtların uygulama tarafından açılması da kontrol edilir. Bozuk ya da eksik bir dosya bulunursa arşiv tarihi, beklenen sayı ve gözlenen fark kayda geçirilir. Anahtarın varlığı tek başına çözme yetkisinin çalıştığını göstermez; prova sırasında çözme adımı da tamamlanmalıdır. Başarısız deneme, sonraki yedek alınana kadar açık bir sorun olarak izlenir.

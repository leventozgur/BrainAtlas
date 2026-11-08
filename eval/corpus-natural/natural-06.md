---
title: "iOS isteklerinde iptal davranışı"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# iOS isteklerinde iptal davranışı

## Neden ele alınıyor

Ekran kapanırken devam eden ağ isteğini iptal etmek, gereksiz işi ve eski yanıtın yeni duruma yazılmasını önler. URLSession görevini bir yaşam döngüsü sahibiyle ilişkilendirmek, iptal noktasını görünür kılar. İptal edilen işlem hata günlüğünde beklenmeyen arıza gibi sayılmamalıdır.

## Uygulama notları

Yeniden deneme politikası yalnız geçici ağ sorunlarını hedeflemelidir. Aynı isteğin iki kez uygulanması yan etki üretiyorsa idempotency anahtarı veya sunucu tarafında tekilleştirme düşünülür.

## Örnek

```text
let task = URLSession.shared.dataTask(with: request)
```


## Konuya özgü ayrıntılar

Görünüm isteği başlatırken görev başvurusunu saklar ve kapanma olayında `cancel()` çağırır. Ardından iptal hatası kullanıcıya bağlantı arızası olarak gösterilmez. Deneme için yanıtı geciktiren sahte bir servis kullanın: ekran kapandıktan sonra yanıt serbest bırakıldığında modelin güncellenmediğini sınayın. Tekrar açılış yeni bir görev oluşturabilir; eski görevin tamamlanması bu yeni görevin durumunu değiştirmemelidir. İptalin sunucu tarafındaki işlemi geri aldığı varsayılmamalı; yan etki ayrı olarak ele alınmalıdır.

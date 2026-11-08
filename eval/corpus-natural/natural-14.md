---
title: "Arayüzde erişilebilir odak sırası"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Arayüzde erişilebilir odak sırası

## Neden ele alınıyor

Klavye ile ilerleyen bir kullanıcı, odak göstergesini kaybetmeden ekrandaki eylemleri sırayla bulabilmelidir. Görsel olarak sol üstte duran bir düğme DOM sırasında en sonda kalırsa gezinme beklenmedik hale gelir. Mantıksal sıralama, görsel düzenle birlikte incelenir.

## Uygulama notları

Otomatik odak taşıma yalnız bağlam gerçekten değiştiğinde yapılmalıdır. Modal açıldığında odak içine alınır, kapanınca önceki noktaya döndürülür; sayfa yüklenirken kullanıcıdan habersiz sıçrama yapılmaz.

## Örnek

```text
document.activeElement?.getAttribute("aria-label")
```


## Konuya özgü ayrıntılar

Yalnız Tab ve Shift-Tab kullanarak bağlantılar, form alanları ve düğmeler dolaşılır. Görünür odak halkası her adımda seçili öğeyi göstermeli, gizli bir denetime odak düşmemelidir. Bir modal açıldığında ilk anlamlı denetime geçiş ve kapatıldığında tetikleyiciye dönüş denenir. Örneğin üç alanlı formda görsel sıra ile klavye sırası uyuşmuyorsa önce belge sırası düzeltilir. Form doğrulama hatasında ilgili alana geçiş yapılırken hata açıklaması da erişilebilir olmalıdır.

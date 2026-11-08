---
title: "Şifreli arşiv anahtarını yenileme"
status: "confirmed"
generated: "2026-10-01"
stale_after: "2031-12-31"
---

# Şifreli arşiv anahtarını yenileme

## Neden ele alınıyor

Uzun süre saklanan şifreli yedeklerde anahtar yenileme süreci geri yükleme planının parçası olmalıdır. Yeni anahtar erişilebilir hale gelmeden eski anahtarı kaldırmak arşivi kullanılamaz kılar. Geçiş sırasında küçük bir dosya seçilerek çözme ve yeniden şifreleme doğrulanır.

## Uygulama notları

Anahtar materyali günlük veya test raporuna yazılmaz. Sorumluluk devri ve erişim kurtarma adımları belgeye işlevsel roller üzerinden eklenir; kişisel hesap adı örneği kullanılmaz.

## Örnek

```text
keyVersion = "k3"
```


## Konuya özgü ayrıntılar

Arşiv envanterinde yalnız anahtar sürümü ve dönüşüm durumu tutulur. Önce yeni sürümle şifrelenen küçük örnek geri açılır, ardından eski arşivler kontrollü gruplar halinde dönüştürülür. İş yarıda kesilirse tamamlanmış ve bekleyen gruplar ayrılabilmelidir. Eski sürüm, onunla açılması gereken son arşiv de doğrulanana kadar erişilebilir kalır. Erişim sınaması rol üzerinden yapılır; anahtar içeriği rapora girmez. Yeni anahtarla açma başarısız olursa eski arşiv silinmez ve geçiş durdurulur.

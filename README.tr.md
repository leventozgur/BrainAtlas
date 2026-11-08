# BrainAtlas

**Kodlama ajanları için kanıt öncelikli bellek.** BrainAtlas proje bilgisini yerel bir Markdown Wiki'de tutar, MCP ve desteklenen hook'lar üzerinden ilgili kanıtı getirir ve ajanların kaynaklandırılmış bağlamla çalışmasına yardımcı olur.

## Nedir?

- Sayfalar, indeks, günlük ve isteğe bağlı metadata kontrolleri içeren yerel bilgi kasası.
- Sınırlı okuma ve retrieval araçları, durum ve lint kontrolleri ve salt okunur mod kapalıyken kontrollü yazma sunan MCP sunucusu.
- Yalnızca kendi yönettiği yapılandırmayı önizleyip uygulayan, güven inceleme adımları olan ajan adaptörleri.

BrainAtlas barındırılan bir bilgi servisi veya ajanın kanıtı izleyeceği garantisi değildir. Telemetri göndermez. Gizli bilgi filtresi daima açıktır ve devre dışı bırakılamaz. Güvenlik modeli için [Security](SECURITY.md) belgesine bakın.

## Profiller

| Profil | İçerik | Notlar |
|---|---|---|
| Lite | Yalnızca çekirdek; isteğe bağlı modül yok | Gizli bilgi filtresi açık, telemetri kapalı. Başlangıç için önerilir. |
| Full | Seçilen sürümde Full için işaretli modüller ve çekirdek | İsteğe bağlı modüller senkronizasyon, semantik retrieval, makbuzlar ve sıkı OKF esinli kontrolleri içerir. Kullanılabilirlik sürüme bağlıdır. |

Semantik retrieval deneysel olup değerlendirme kapısının arkasında varsayılan olarak kapalıdır. Klasör senkronizasyonu deneysel durumdadır.

## Desteklenen ajanlar

| Ajan | Bu depodaki entegrasyon | Güven incelemesi |
|---|---|---|
| Claude Code | MCP, prompt ve oturum başlangıç hook'ları, yönetilen `CLAUDE.md` işaretçisi | Planlanan MCP, hook ve talimat değişikliklerini inceleyin. |
| GitHub Copilot in VS Code | MCP, oturum başlangıç hook'u, yönetilen talimatlar | Prompt başına hook desteklenmiyor; oturum başlangıcı ve pull-mode MCP kullanılır. Global talimat yolu doğrulanmamıştır. |
| Kiro | MCP, steering dosyası, prompt hook'u | Prompt tetikleyicisinin adı ve uyumluluğu doğrulanmamıştır. |
| Codex CLI | MCP ve yönetilen talimat işaretçisi; hook desteği adaptöre bağlıdır | MCP ve talimat yapılandırmasını inceleyin. |
| Gemini CLI | MCP, yönetilen talimat işaretçisi, `BeforeAgent` ve `SessionStart` hook'ları | Gerekirse Gemini `/hooks` panelinden etkinleştirin. |

## Hızlı başlangıç

### Çevrimiçi

GitHub Releases planlanan çevrimiçi kanaldır; henüz yayın yoktur. **Yayımlamadan önce doğrulayın:** bugün kullanılabilir yayın indirme adresi bulunmuyor. Şimdilik güvenilir kaynaktan alınan çevrimdışı dağıtım klasörünü kullanın. Node.js 20+ ve `ssh-keygen` gerekir.

### Çevrimdışı

Güvendiğiniz kaynaktan Lite dağıtım klasörünün tamamını alın. Klasör arşivi, imzalı checksum dosyalarını ve allowed-signers dosyasını içerir. Sürüm yer tutucusunu gerçek sürümle değiştirin.

```sh
sh install.sh --from brainatlas-<v>-lite.tgz --allowed-signers release/allowed_signers --yes
brainatlas init --profile lite --agents claude-code,copilot-vscode,kiro
brainatlas doctor
```

Ajan güven istemlerini inceleyin ve MCP ile talimatların yüklendiğini doğrulayın. Ayrıntılar için [kurulum kılavuzuna](docs/user/install.md) bakın.

## Güncelleme, geri alma ve kaldırma

Doğrulanmış arşivden `brainatlas update --from <archive>` ile güncelleyin. Yeni sürüm sağlık kontrolünden geçemezse önceki sürüm geri yüklenir. `brainatlas rollback` önceki sürüme döner. `brainatlas uninstall` BrainAtlas tarafından yönetilen kurulumu ve adaptör değişikliklerini kaldırır; yapılandırılmış kasa korunur.

## Gizlilik ve güvenlik

Kasa ve durum verileri yereldir. Telemetri yoktur. Desteklenen yazmalardan önce içerik gizli bilgi filtresinden geçer; filtre kapatılamaz. İsteğe bağlı senkronizasyon yalnızca yapılandırıldığında veri aktarır. Ayrıntılar: [SECURITY.md](SECURITY.md), [senkronizasyon kılavuzu](docs/user/sync.md).

## Karşılaştırma (2026-11 itibarıyla)

Bu tablo genel yaklaşımı karşılaştırır, performans ölçümü değildir. Yayınlamadan önce ürünlerin güncel özelliklerini ve kaynaklarını doğrulayın.

| Araç/tür | Genel yaklaşım | BrainAtlas farkı |
|---|---|---|
| claude-mem | Claude Code için kalıcı bellek/bağlam | BrainAtlas çoklu ajan, yerel Markdown kanıt kasası ve MCP retrieval odaklıdır. Güncel özellikleri yayın öncesi doğrulayın. |
| basic-memory | Ajan entegrasyonlu Markdown bilgi yönetimi | BrainAtlas kodlama ajanları için kanıt retrieval'ı, kontrollü yazma ve gizlilik filtrelerine odaklanır. Güncel özellikleri yayın öncesi doğrulayın. |
| Karpathy tarzı LLM Wiki kurulumları | Betik ve promptlarla yönetilen Wiki/notlar | BrainAtlas yapılandırılmış yerel Wiki, retrieval arayüzleri, güvenlik kontrolleri ve sürüm araçları sunar. Kurulumlar farklılık gösterir; yayın öncesi doğrulayın. |
| avenoxbeyin | Geliştirme brief'inde anılan referans | Kimliği ve yetenekleri çevrimdışı depodan doğrulanamıyor. Yayın öncesi doğrulayın; karşılaştırmalı iddia yoktur. |

# BrainAtlas

**Kodlama ajanları için kanıt öncelikli bellek.** BrainAtlas proje bilgisini yerel bir Markdown Wiki'de tutar, MCP ve desteklenen hook'lar üzerinden ilgili kanıtı getirir ve ajanların kaynaklandırılmış bağlamla çalışmasına yardımcı olur.

## Nedir?

- Sayfalar, indeks, günlük ve isteğe bağlı metadata kontrolleri içeren yerel bilgi kasası.
- Sınırlı okuma ve retrieval araçları, durum ve lint kontrolleri ve salt okunur mod kapalıyken kontrollü yazma sunan MCP sunucusu.
- Yalnızca kendi yönettiği yapılandırmayı önizleyip uygulayan, güven inceleme adımları olan ajan adaptörleri.

BrainAtlas kodlama ajanları için tasarlanmıştır, ancak kasa içerik türünü kısıtlamaz: proje dışı notlar da çalışır.

BrainAtlas barındırılan bir bilgi servisi veya ajanın kanıtı izleyeceği garantisi değildir. Telemetri göndermez. Gizli bilgi filtresi varsayılan olarak açıktır ve Lite ile Full profillerinde kilitlidir; yalnızca custom profil yazma retlerini kapatabilir. Güvenlik modeli için [Security](SECURITY.md) belgesine bakın.

## Profiller

| Profil | İçerik | Notlar |
|---|---|---|
| Lite | Yalnızca çekirdek; isteğe bağlı modül yok | Gizli bilgi filtresi açık, telemetri kapalı. Başlangıç için önerilir. |
| Full | Seçilen sürümde Full için işaretli modüller ve çekirdek | İsteğe bağlı modüller senkronizasyon, semantik retrieval, makbuzlar ve sıkı OKF esinli kontrolleri içerir. Kullanılabilirlik sürüme bağlıdır. |

Semantik retrieval deneysel, isteğe bağlı, yerel Ollama kullanır ve varsayılan olarak kapalıdır; bağımsız semantik holdout v2'de (`wiki_query`, EmbeddingGemma) TR→EN 0/10'dan 8/10'a, EN→TR 2/10'dan 8/10'a yükselmiş, zor yakın konulu negatiflerde iyileşme olmamıştır (önce ve sonra 2/10 çekimser). Ayrıntılar: [Retrieval](docs/user/retrieval.md) ve [Semantik retrieval](docs/user/semantic.md). Klasör senkronizasyonu deneysel durumdadır.

## Desteklenen ajanlar

| Ajan | Bu depodaki entegrasyon | Güven incelemesi |
|---|---|---|
| Claude Code | MCP, prompt ve oturum başlangıç hook'ları, yönetilen `CLAUDE.md` işaretçisi | Planlanan MCP, hook ve talimat değişikliklerini inceleyin. |
| GitHub Copilot in VS Code | MCP, oturum başlangıç hook'u, yönetilen talimatlar | Prompt başına hook desteklenmiyor; oturum başlangıcı ve pull-mode MCP kullanılır. Global talimat yolu doğrulanmamıştır. |
| Kiro | MCP, steering dosyası, prompt hook'u | Prompt tetikleyicisinin adı ve uyumluluğu doğrulanmamıştır. |
| Codex CLI | MCP ve yönetilen talimat işaretçisi; hook desteği adaptöre bağlıdır | MCP ve talimat yapılandırmasını inceleyin. |
| Gemini CLI | MCP, yönetilen talimat işaretçisi, `BeforeAgent` ve `SessionStart` hook'ları | Gerekirse Gemini `/hooks` panelinden etkinleştirin. |

## Özellikler ve açma/kapama

Ayarlar BrainAtlas yapılandırma dosyasındadır (macOS'ta `~/Library/Application Support/BrainAtlas/config.json`; diğer yollar [config sözleşmesinde](docs/contracts/config.md)). `brainatlas config get [ANAHTAR]` ile okur, `brainatlas config set ANAHTAR DEĞER [--plan]` ile değiştirir, `brainatlas config unset ANAHTAR [--plan]` ile isteğe bağlı bir anahtarı silersiniz; `--plan` değişikliği yazmadan önizler.

| Özellik | Varsayılan | Açma / kapama | Ayrıntı |
|---|---|---|---|
| Prompt hook enjeksiyonu | açık (`hooks.mode normal`) | `brainatlas config set hooks.mode economic` yalnızca soru benzeri prompt'larda veya `/sb`, `@sb` ile enjekte eder; `manual` yalnızca `/sb` veya `@sb` ile enjekte eder ve oturum başı özetini de kapatır; `normal` geri açar | [Ajan kurulumu](docs/user/agents.md) |
| Aşamalı açıklama | kapalı (`hooks.disclosure` yok = `full`) | `brainatlas config set hooks.disclosure progressive`; `brainatlas config unset hooks.disclosure` `full` değerini geri getirir | [Retrieval](docs/user/retrieval.md) |
| Anlamsal retrieval (Full, deneysel) | kapalı | `brainatlas config set semantic.enabled true` / `false`; yerel Ollama gerekir | [Anlamsal retrieval](docs/user/semantic.md) |
| Arama kapsamı | varsa `wiki/`; kök gezinme sayfaları hariç | `brainatlas config set retrieval.exclude '["drafts/**"]'`; `[]` hiçbir şeyi hariç tutmaz; `brainatlas config unset retrieval.exclude` varsayılana döner | [Retrieval](docs/user/retrieval.md) |
| MCP yazma araçları | açık | `brainatlas config set readOnly true` yalnızca okuma araçlarını bırakır; `false` yazmayı geri açar | [Sözleşmeler](docs/contracts/) |
| MCP ve hook yerine kabuk | kapalı (varsayılan kanal MCP) | `brainatlas init --channel cli` veya ajan başına `--channel claude-code=cli,kiro=mcp`; kurulu bir ajanın kanalını sonradan değiştirmek için `brainatlas agent set <ajan> --channel mcp\|cli` | [CLI kanalı](docs/user/cli-channel.md) |
| Tek bir ajanı ekle, kaldır veya kanalını değiştir | `init --agents` ile | `brainatlas agent list` (algılanan ajanları gösterir); `brainatlas agent add <ajan> [--channel mcp\|cli] [--plan]`; `brainatlas agent remove <ajan> [--plan]` | [Ajan kurulumu](docs/user/agents.md) |
| Klasör veya Git senkronu (Full, deneysel) | kapalı | `sync.transport` ile yapılandırılır; açmadan önce rehbere bakın | [Sync](docs/user/sync.md) |
| Telemetri ve gizli bilgi filtresi | kapalı / açık, kilitli | Değiştirilemez (`E_LOCKED_KEY`) | [Güvenlik](SECURITY.md) |

BrainAtlas'ı tamamen durdurmak için `brainatlas uninstall` çalıştırın (kasa korunur).

### Komutlar

| Komut | Amaç | Yazar mı? |
|---|---|---|
| `brainatlas wiki query\|read\|index\|list\|status\|lint` | Kabuktan salt okunur Wiki araçları; MCP okuma araçlarıyla aynı sonuç | hayır |
| `brainatlas maintain [--repo DIR]` | Eski, kırık, yetim ve büyük sayfaları raporlar | hayır (`--queue` hariç) |
| `brainatlas compact --page wiki/<sayfa>.md --plan\|--apply` | Uzun sayfanın eski tarihli bölümlerini satır kaybetmeden `wiki/archive/` altına taşır | yalnızca `--apply` |
| `brainatlas usage [--days N]` | İçeriksiz hook metriklerini özetler | hayır |
| `brainatlas ui [--no-open] [--json]` | Durum, ajan kanalları ve ayarlar için deneysel yerel panel (yalnızca 127.0.0.1) | yalnızca panelde apply |
| `brainatlas doctor`, `status` | Kurulum sağlığını denetler | hayır |

Rehberler: [Wiki CLI](docs/user/wiki-cli.md), [Bakım raporu](docs/user/maintain.md), [Compact](docs/user/compact.md), [Kullanım](docs/user/usage.md).

## Hızlı başlangıç

### Çevrimiçi

Sürümler GitHub Releases'ta yayımlanır: https://github.com/leventozgur/BrainAtlas/releases. Her sürüm tam dağıtım klasörünü içerir (Lite ve Full arşivleri, `install.sh`, `release/`, `SHA256SUMS`, `SHA256SUMS.sig`). Bir sürümün tüm dosyalarını boş bir klasöre indirin ve aşağıdaki çevrimdışı adımlarla devam edin. Bakımcı imza anahtarının parmak izi `SHA256:PPcml0QiRHQJrtPnqWMXF77PgJhPT27GOHboOMJCw40`; kurmadan önce `release/allowed_signers` ile karşılaştırın.

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

Kasa ve durum verileri yereldir. Telemetri yoktur. Desteklenen yazmalardan önce içerik gizli bilgi filtresinden geçer; filtre Lite ve Full profillerinde kapatılamaz. Custom profilde `brainatlas config set safety.secretFilter false` gizli bilgi benzeri içerik içeren yazmaların reddini kaldırır; çıktı maskeleme, yol engelleme kuralları ve senkronizasyon taramaları açık kalır. İsteğe bağlı senkronizasyon yalnızca yapılandırıldığında veri aktarır. Ayrıntılar: [SECURITY.md](SECURITY.md), [senkronizasyon kılavuzu](docs/user/sync.md).

## Karşılaştırma ve ilgili çalışmalar

BrainAtlas, diğer araçların özellikleri değiştiği ve bağımsız olarak doğrulanmadığı için özellik karşılaştırması yayımlamaz.

- Andrej Karpathy'nin popülerleştirdiği LLM Wiki yaklaşımı: LLM tarafından bakımı yapılan bir Wiki veya not koleksiyonu fikri; bu çalışmadan kod kullanılmamıştır.
- Microsoft llmwiki core (bu depoda vendor'lanmış, MIT; bkz. [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)).
- avenoxbeyin (https://github.com/avenoxai/avenoxbeyin): yalnızca tasarım desenleri (BM25 `k1=1.5` ve `b=0.75`, vault-id hash deseni, sürüm ve kurulum desenleri), MIT, kod kopyalanmamıştır; bkz. [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

## Kullanıcı rehberleri

- [Sürümleri kurma ve doğrulama](docs/user/install.md)
- [Ajan entegrasyonları ve güven incelemesi](docs/user/agents.md)
- [Retrieval davranışı ve ölçülen kalite](docs/user/retrieval.md)
- [OKF esinli metadata](docs/user/okf.md)
- [Senkronizasyon davranışı](docs/user/sync.md)
- [Bakım raporu](docs/user/maintain.md)
- [Salt okunur Wiki CLI (`brainatlas wiki`)](docs/user/wiki-cli.md)
- [CLI kanalı (MCP ve hook yerine talimatlar)](docs/user/cli-channel.md)
- [Uzun sayfaları sıkıştırma](docs/user/compact.md)
- [Kullanım özeti ve geri bildirim](docs/user/usage.md)
- [Anlamsal retrieval (deneysel)](docs/user/semantic.md)
- [Sorun giderme](docs/user/troubleshooting.md)

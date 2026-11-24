# BrainAtlas

**Kodlama ajanları için kanıt öncelikli bellek.** BrainAtlas proje bilgisini yerel bir Markdown Wiki'de tutar, MCP ve desteklenen hook'lar üzerinden ilgili kanıtı getirir ve ajanların kaynaklandırılmış bağlamla çalışmasına yardımcı olur.

[English](README.md) | Türkçe

## Nedir?

- Sayfalar, indeks, günlük ve isteğe bağlı metadata kontrolleri içeren yerel bilgi kasası.
- Sınırlı okuma ve retrieval araçları, durum ve lint kontrolleri ve salt okunur mod kapalıyken kontrollü yazma sunan MCP sunucusu.
- Yalnızca kendi yönettiği yapılandırmayı önizleyip uygulayan, güven inceleme adımları olan ajan adaptörleri.

BrainAtlas kodlama ajanları için tasarlanmıştır, ancak kasa içerik türünü kısıtlamaz: proje dışı notlar da çalışır.

BrainAtlas barındırılan bir bilgi servisi, genel amaçlı bir ajan veya ajanın getirilen kanıtı izleyeceği garantisi değildir. Telemetri göndermez. Gizli bilgi filtresi varsayılan olarak açıktır ve Lite ile Full profillerinde kilitlidir; yalnızca custom profil yazma retlerini kapatabilir. Çekirdek yapılandırma telemetriyi false olarak ayarlar. Güvenlik modeli için [Güvenlik](SECURITY.md) belgesine bakın.

## Gereksinimler

- Sürüm yükleyicisi için macOS veya Linux.
- Node.js 20 veya üzeri.
- Sürüm imzası doğrulaması için `ssh-keygen`.

Semantik arama ayrıca yerel bir Ollama kurulumu gerektirir.

## Kurulum (Hızlı başlangıç)

### Çevrimiçi

Sürümler GitHub Releases'ta yayımlanır: https://github.com/leventozgur/BrainAtlas/releases. Bir sürümden `brainatlas-0.1.0-distribution.tar.gz` dosyasını indirin, boş bir klasöre çıkarın ve yükleyiciyi o klasörden çalıştırın. Dağıtım `brainatlas-0.1.0-lite.tgz`, `brainatlas-0.1.0-full.tgz`, `install.sh`, `release/`, `SHA256SUMS` ve `SHA256SUMS.sig` dosyalarını içerir. Bakımcı imza anahtarının parmak izi `SHA256:PPcml0QiRHQJrtPnqWMXF77PgJhPT27GOHboOMJCw40`; kurmadan önce `release/allowed_signers` ile karşılaştırın.

```sh
sh install.sh --from brainatlas-0.1.0-lite.tgz --allowed-signers release/allowed_signers --yes
brainatlas init --profile lite --agents claude-code,copilot-vscode,kiro
brainatlas doctor
```

Full profilini kurmak için `brainatlas-0.1.0-lite.tgz` yerine `brainatlas-0.1.0-full.tgz` kullanın. Ajan güven istemlerini inceleyin ve entegrasyonu her ajan içinde doğrulayın. İmza ve doğrulama ayrıntıları için [kurulum kılavuzuna](docs/user/install.md) bakın.

### Çevrimdışı

Güvendiğiniz bir kaynaktan dağıtım klasörünün tamamını alın. Klasör `brainatlas-0.1.0-lite.tgz`, `brainatlas-0.1.0-full.tgz`, `install.sh`, `release/` ile imzalı `SHA256SUMS` ve `SHA256SUMS.sig` dosyalarını içerir. Arşivi aldıysanız `brainatlas-0.1.0-distribution.tar.gz` dosyasını boş bir klasöre çıkarın, ardından aynı yükleyici komutunu o klasörden çalıştırın:

```sh
sh install.sh --from brainatlas-0.1.0-lite.tgz --allowed-signers release/allowed_signers --yes
brainatlas init --profile lite --agents claude-code,copilot-vscode,kiro
brainatlas doctor
```

## Doğrulama

`install.sh`, `SHA256SUMS.sig` dosyasını `brainatlas-release` kimliği ve ad alanıyla `release/allowed_signers` dosyasına karşı `ssh-keygen -Y verify` ile otomatik olarak doğrular, ardından arşivi çıkarmadan önce her dosyanın SHA-256 değerini denetler. `--insecure-skip-signature` imza kontrolünü atlar ve yalnızca bu riski açıkça kabul ettiğinizde kullanılmalıdır.

Bir dağıtımı elle doğrulamak için çıkarılan klasörde şu komutları çalıştırın:

```sh
ssh-keygen -Y verify -f release/allowed_signers -I brainatlas-release -n brainatlas-release -s SHA256SUMS.sig < SHA256SUMS
shasum -a 256 -c SHA256SUMS
```

Bakımcı imza anahtarının parmak izi `SHA256:PPcml0QiRHQJrtPnqWMXF77PgJhPT27GOHboOMJCw40`; `release/allowed_signers` ile karşılaştırın.

## Desteklenen ajanlar

| Ajan | Bu depodaki entegrasyon | Güven incelemesi |
|---|---|---|
| Claude Code | MCP, prompt ve oturum başlangıç hook'ları, yönetilen `CLAUDE.md` işaretçisi | Planlanan MCP, hook ve talimat değişikliklerini inceleyin. |
| GitHub Copilot in VS Code | MCP, oturum başlangıç hook'u, yönetilen talimatlar | Prompt başına hook desteklenmiyor; oturum başlangıcı ve pull-mode MCP kullanılır. Global talimat yolu doğrulanmamıştır. |
| Kiro | MCP, steering dosyası, prompt hook'u | Prompt tetikleyicisinin adı ve uyumluluğu doğrulanmamıştır; güvenmeden önce inceleyin. |
| Codex CLI | MCP ve yönetilen talimat işaretçisi; hook desteği adaptöre bağlıdır | MCP ve talimat yapılandırmasını inceleyin. |
| Gemini CLI | MCP, yönetilen talimat işaretçisi, `BeforeAgent` ve `SessionStart` hook'ları | Gerekirse Gemini `/hooks` panelinden etkinleştirin. |

Adaptörler ajan yapılandırmasını oluşturabilir veya değiştirebilir. Planı ve güven incelemesini inceleyin, ardından ajanın MCP sunucusunu ve talimatları yüklediğini doğrulayın. Bkz. [Ajan kurulumu](docs/user/agents.md).

## Profiller

| Profil | İçerik | Notlar |
|---|---|---|
| Lite | Yalnızca çekirdek; isteğe bağlı modül yok | Gizli bilgi filtresi açık, telemetri kapalı. Başlangıç için önerilir. |
| Full | Seçilen sürümde Full için işaretli modüller ve çekirdek | İsteğe bağlı modüller senkronizasyon, semantik arama, makbuzlar ve sıkı OKF esinli kontrolleri içerir. Kullanılabilirlik sürüme bağlıdır. |

Semantik arama isteğe bağlıdır, yerel Ollama kullanır ve varsayılan olarak kapalıdır; bağımsız semantik holdout v2'de (`wiki_query`, EmbeddingGemma) TR→EN 0/10'dan 8/10'a, EN→TR 2/10'dan 8/10'a yükselmiş, zor yakın konulu negatiflerde iyileşme olmamıştır (önce ve sonra 2/10 çekimser). İsteğe bağlı işlevleri açmadan önce modül durumunu inceleyin.

0.1.0'da deneysel: semantik arama, Git/klasör/Dropbox senkronizasyonu, yerel panel (`brainatlas ui`) ve `maintain-schedule` modülü. Bu işlevler sürümler arasında değişebilir. Ayrıntılar için [Retrieval](docs/user/retrieval.md) ve [Semantik arama](docs/user/semantic.md) belgelerine bakın.

## Komutlar

| Komut | Amaç | Yazar mı? |
|---|---|---|
| `brainatlas wiki query\|read\|index\|list\|status\|lint` | Kabuktan salt okunur Wiki araçları; MCP okuma araçlarıyla aynı sonuç | hayır |
| `brainatlas status [--summary]` | Kurulum durumunu gösterir; `--summary` kısa biçimi yazdırır | hayır |
| `brainatlas doctor` | Kurulum sağlığını denetler | hayır |
| `brainatlas maintain [--repo DIR]` | Eski, kırık, yetim ve büyük sayfaları raporlar | hayır (`--queue` hariç) |
| `brainatlas maintain --fix (--plan\|--apply)` | İndeks satırlarını, arşiv bağlantılarını ve kaynak listelerini onarır; `--sources` kaynak kontrollerini ekler | yalnızca `--apply` |
| `brainatlas maintain --weekly` | Salt okunur bakım anlık görüntüsü yazar | yalnızca anlık görüntü |
| `brainatlas maintain --proposals list\|show <id>\|accept <id>\|reject <id>` | Saklanan güncel durum önerilerini inceler | yalnızca `accept` |
| `brainatlas compact --page wiki/<sayfa>.md --plan\|--apply` | Uzun sayfanın eski tarihli bölümlerini satır kaybetmeden `wiki/archive/` altına taşır | yalnızca `--apply` |
| `brainatlas usage [--days N]` | İçeriksiz hook metriklerini özetler | hayır |
| `brainatlas ui [--no-open] [--json]` | Durum, ajan kanalları ve ayarlar için deneysel yerel panel (yalnızca 127.0.0.1) | yalnızca panelde apply |
| `brainatlas update --from <archive>` | Doğrulanmış sürüm arşivinden güncelleme kurar | yalnızca kurulum |
| `brainatlas update --check --from <archive>` | Sürüm arşivini kurmadan inceler | hayır |
| `brainatlas rollback [--to VERSION]` | Önceki sürüme veya kurulu belirli bir sürüme döner | yalnızca kurulum |
| `brainatlas module list\|add\|remove` | Kurulu modülleri listeler, ekler veya kaldırır | yalnızca `add` ve `remove` |
| `brainatlas safety allow\|list\|revoke` | Parmak izli güvenlik izinlerini inceler ve yönetir | yalnızca `allow` ve `revoke` |
| `brainatlas adopt --plan` | Mevcut ajan kurulumunu inceleyip benimseme önerir | hayır |
| `brainatlas eval [--cases FILE] [--corpus DIR]` | Yerel retrieval değerlendirmesini çalıştırır | hayır |
| `brainatlas maintain-schedule install\|status\|remove` | Full veya custom profil, deneysel: haftalık bakım zamanlayıcısını kurar, inceler veya kaldırır | yalnızca `install` ve `remove` |

Rehberler: [Wiki CLI](docs/user/wiki-cli.md), [Bakım raporu](docs/user/maintain.md), [Compact](docs/user/compact.md), [Kullanım](docs/user/usage.md).

## Yapılandırma ve özellikler

Ayarlar BrainAtlas yapılandırma dosyasındadır (macOS'ta `~/Library/Application Support/BrainAtlas/config.json`; diğer yollar [config sözleşmesinde](docs/contracts/config.md)). `brainatlas config get [ANAHTAR]` ile okur, `brainatlas config set ANAHTAR DEĞER [--plan]` ile değiştirir, `brainatlas config unset ANAHTAR [--plan]` ile isteğe bağlı bir anahtarı silersiniz; `--plan` değişikliği yazmadan önizler.

| Özellik | Varsayılan | Açma / kapama | Ayrıntı |
|---|---|---|---|
| Prompt hook enjeksiyonu | açık (`hooks.mode normal`) | `brainatlas config set hooks.mode economic` yalnızca soru benzeri prompt'larda veya `/sb`, `@sb` ile enjekte eder; `manual` yalnızca `/sb` veya `@sb` ile enjekte eder ve oturum başı özetini de kapatır; `normal` geri açar | [Ajan kurulumu](docs/user/agents.md) |
| Aşamalı açıklama | kapalı (`hooks.disclosure` yok = `full`) | `brainatlas config set hooks.disclosure progressive`; `brainatlas config unset hooks.disclosure` `full` değerini geri getirir | [Retrieval](docs/user/retrieval.md) |
| Semantik arama (Full, deneysel) | kapalı | `brainatlas config set semantic.enabled true` / `false`; yerel Ollama gerekir | [Semantik arama](docs/user/semantic.md) |
| Arama kapsamı | varsa `wiki/`; kök gezinme sayfaları hariç | `brainatlas config set retrieval.exclude '["drafts/**"]'`; `[]` hiçbir şeyi hariç tutmaz; `brainatlas config unset retrieval.exclude` varsayılana döner | [Retrieval](docs/user/retrieval.md) |
| MCP yazma araçları | açık | `brainatlas config set readOnly true` yalnızca okuma araçlarını bırakır; `false` yazmayı geri açar | [Sözleşmeler](docs/contracts/) |
| MCP ve hook yerine kabuk | kapalı (varsayılan kanal MCP) | `brainatlas init --channel cli` veya ajan başına `--channel claude-code=cli,kiro=mcp`; kurulu bir ajanın kanalını sonradan değiştirmek için `brainatlas agent set <ajan> --channel mcp\|cli` | [CLI kanalı](docs/user/cli-channel.md) |
| Tek bir ajanı ekle, kaldır veya kanalını değiştir | `init --agents` ile | `brainatlas agent list` (algılanan ajanları gösterir); `brainatlas agent add <ajan> [--channel mcp\|cli] [--plan]`; `brainatlas agent remove <ajan> [--plan]` | [Ajan kurulumu](docs/user/agents.md) |
| Klasör, Git veya Dropbox senkronu (Full, deneysel) | kapalı | `sync.transport` ile yapılandırılır; açmadan önce rehbere bakın | [Sync](docs/user/sync.md) |
| Telemetri ve gizli bilgi filtresi | telemetri kapalı ve kilitli; gizli bilgi filtresi varsayılan olarak açık | Telemetri değiştirilemez (`E_LOCKED_KEY`). Gizli bilgi filtresi Lite ve Full profillerinde kilitlidir; yalnızca custom profil `safety.secretFilter false` ayarlayabilir; bu yalnızca yazma retlerini kaldırır, çıktı maskeleme, yol engelleme kuralları ve senkronizasyon taramaları açık kalır | [Güvenlik](SECURITY.md) |

BrainAtlas'ı tamamen durdurmak için `brainatlas uninstall` çalıştırın (kasa korunur).

## Gizlilik ve güvenlik

Kasa ve durum verileri yereldir. BrainAtlas'ta telemetri yoktur ve çekirdek yapılandırma telemetriyi false olarak ayarlar. Desteklenen yazmalardan önce içerik gizli bilgi filtresinden geçer; filtre Lite ve Full profillerinde kapatılamaz. Custom profilde `brainatlas config set safety.secretFilter false` gizli bilgi benzeri içerik içeren yazmaların reddini kaldırır; çıktı maskeleme, yol engelleme kuralları ve senkronizasyon taramaları açık kalır. Varsayılan yol engelleme kuralları hassas konumları ve dosyaları da engeller. Hook'lar sınırlı bağlam döndürür ve metrikleri prompt metnini, sayfa içeriğini, yolları ve ham oturum kimliklerini içermez. İsteğe bağlı senkronizasyon aktarımları kasa verisini yalnızca yapılandırıldığında taşır; açmadan önce seçilen aktarımı ve kimlik bilgilerini anlayın.

Bkz. [Güvenlik](SECURITY.md), [Sync](docs/user/sync.md) ve [sözleşmeler](docs/contracts/).

## Güncelleme, geri alma ve kaldırma

Doğrulanmış bir sürüm arşivinden `brainatlas update --from <archive>` ile güncelleyin. CLI sürüm sağlığını denetler ve yeni sürüm sağlık kontrolünden geçemezse önceki sürümü geri yükler. Önceki sürüme dönmek için `brainatlas rollback`, kurulu belirli bir sürüm için `brainatlas rollback --to VERSION` kullanın. `brainatlas uninstall` BrainAtlas tarafından yönetilen kurulumu ve adaptör değişikliklerini kaldırır; yapılandırılmış kasa korunur. Uygulamadan önce desteklenen yerlerde `--plan` çıktısını inceleyin.

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
- [Yerel panel (`brainatlas ui`, deneysel)](docs/user/ui.md)
- [Semantik arama (deneysel)](docs/user/semantic.md)
- [Sorun giderme](docs/user/troubleshooting.md)

## Sürüm notları ve katkı

- [Sürüm notları](CHANGELOG.md)
- [Katkı](CONTRIBUTING.md)

## Lisans

MIT. Bkz. [LICENSE](LICENSE).

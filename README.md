# Xudbin

Sunucularını tek panelden yönet. Dokploy ve Coolify'dan ilham alan, self-hosted bir sunucu yönetim paneli.
Bu panellerde eksik kalan üç şeyi baştan çözüyor:

- **Domain almadan çalışan adres:** Her uygulamaya otomatik olarak `uygulama-x7k2.1-2-3-4.sslip.io` gibi bir adres verilir. DNS ayarı gerekmez.
- **Ücretsiz, otomatik HTTPS:** Caddy, Let's Encrypt sertifikalarını hem otomatik adreslerde hem kendi alan adlarında alır ve yeniler.
- **Yerleşik saldırı koruması:** WAF (Coraza + OWASP Core Rule Set), IP başına hız sınırı, otomatik IP banı, güvenlik başlıkları, şifre koruması, IP izin/engel listeleri ve canlı saldırı ekranı.

## Özellikler

**Sunucular**
- Panelin kendi sunucusu ve SSH ile bağlanan sınırsız uzak sunucu
- Sunucu eklerken ed25519 SSH anahtarı otomatik üretilir; Docker yoksa kurulur, Caddy hazırlanır
- Tüm sunucuların canlı CPU, bellek ve disk kullanımı (uzak sunucular dahil)
- Tek tıkla sıkılaştırma: UFW güvenlik duvarı ve SSH için fail2ban
- Erişilemeyen sunucu için bildirim

**Uygulamalar**
- Kaynak: Git reposu (özel repolar için token), sürükle-bırak dosya yükleme (klasör veya zip), Docker imajı veya Docker Compose
- Framework'e göre deploy: uygulama eklerken repo taranır, uygun framework önerilir; her framework'ün ayarları, gereken ortam değişkenleri ve "deploy'da ne olacak" adımları gösterilir
- Kodda okunan ortam değişkenleri ve `.env.example` tek tıkla eklenir; gizli anahtar, alan adı gibi değerler otomatik üretilir
- Kesintisiz deploy: trafik, yeni sürüm gerçek alan adıyla yapılan HTTP isteğine sağlıklı yanıt verince geçer; 400/5xx dönerse eski sürüm yayında kalır
- **Deploy Doktoru:** başarısız deploy'larda loglardaki bilinen hataları (Django ALLOWED_HOSTS, CSRF, eksik gizli anahtar, veritabanı bağlantısı, migration, eksik paket veya ortam değişkeni, bellek yetmezliği) açıklar, uygun olanları tek tıkla düzeltip yeniden deploy eder
- Framework'ün istediği zorunlu ve alan adına bağlı ortam değişkenleri eksikse deploy sırasında eklenir; Django'da settings.py'nin hangi değişken adını okuduğu bulunur
- Uygulama başına bellek/CPU sınırı; çalışan deploy iptal edilebilir, 30 dakikada biten zaman aşımı
- Her deploy'dan sonra imaj Trivy ile bilinen güvenlik açıklarına karşı taranır
- Tek tıkla önceki sürüme dönüş, canlı deploy ve uygulama logları
- Git push webhook'u ile otomatik deploy (GitHub, GitLab, Gitea...), HMAC imza doğrulamalı
- Şifreli ortam değişkenleri, kalıcı depolama klasörleri, CPU/bellek izleme

**Veritabanları**
- PostgreSQL, MySQL, MariaDB, MongoDB, Redis; kullanıcı ve şifre otomatik üretilir
- Elle veya zamanlanmış yedekleme, saklama sayısı, indirme ve geri yükleme
- Yedekler S3 uyumlu uzak depolamaya da yüklenir (AWS S3, Cloudflare R2, Backblaze B2, MinIO)
- **Doğrulanmış yedek:** yedekler düzenli olarak ağsız geçici bir veritabanına geri yüklenip denenir ("son yedek doğrulandı, 12 tablo")
- **Panel yedeği:** panelin kendi verisi ve şifreleme anahtarı şifreli olarak yedeklenir; sunucu giderse yeni kurulumda `xudbin restore` ile geri gelir

**Güvenlik**
- **Güvenlik puanı:** panel, sunucular ve uygulamalar için kontroller (2FA, yedekler, güvenlik duvarı, fail2ban, SSH ayarları, otomatik güncellemeler, WAF, debug modu, imaj açıkları...) ve tek tıkla düzeltmeler
- Docker'ın güvenlik duvarını atlaması engellenir: dışarıdan konteynerlere yalnız 80/443 ve panelden açılan veritabanı portları ulaşır
- Üye rolü compose dosyasında sunucuya erişim (privileged, sunucu klasörü bağlama, host ağı) kullanamaz; bunu yalnız yönetici açabilir
- Uygulama başına WAF, hız sınırı, güvenlik başlıkları, şifre koruması, IP listeleri
- Tüm sunuculardaki Caddy loglarından saldırı ekranı: zaman çizelgesi, en çok saldıran IP'ler, hedeflenen adresler
- Eşiği aşan IP'ler tüm sunucularda otomatik banlanır
- Panel: kurulum anahtarı, iki adımlı doğrulama (TOTP), giriş hız sınırı, CSRF koruması, oturum yönetimi
- SSH anahtarları, git token'ları, ortam değişkenleri ve veritabanı şifreleri AES-256-GCM ile şifrelenir

**Bildirimler:** Discord, Telegram, Slack, genel webhook. Olaylar: deploy sonucu, banlanan IP, başarısız yedek, erişilemeyen sunucu.

**Kullanıcılar:** Yönetici ve üye rolleri. Üyeler proje, uygulama ve veritabanlarını yönetir; sunuculara, güvenliğe ve ayarlara erişemez. Yeni kullanıcı geçici şifreyle eklenir, ilk girişte kendi şifresini belirler.

**Arayüz:** Türkçe ve İngilizce, açık ve koyu tema.

## Desteklenen frameworkler

Dockerfile'ı olmayan projeler için Xudbin şu türleri tanır ve Dockerfile'ı kendisi üretir (üretilen Dockerfile deploy logunda görünür):

| Dil | Frameworkler |
|---|---|
| Python | Django (Gunicorn + WhiteNoise, başlangıçta collectstatic/migrate), Flask, FastAPI, genel Python |
| JavaScript / TypeScript | Next.js (standalone dahil), Nuxt, SvelteKit, Astro, Remix / React Router, NestJS, React/Vue/Angular SPA, Express/Fastify/Hono, Bun, Deno |
| PHP | Laravel, genel PHP ve WordPress (FrankenPHP, Nginx gerekmez) |
| .NET | ASP.NET Core |
| Go, Rust, Java | Go, Rust, Spring Boot (Maven/Gradle) |
| Ruby | Rails |
| Diğer | Statik site, kendi Dockerfile'ın |

Bunlar dışındaki projeler repodaki Dockerfile ile deploy edilir.

## Kurulum

Ubuntu, Debian veya AlmaLinux/Rocky bir sunucuda, 80 ve 443 portları boşken tek komut:

```bash
curl -fsSL https://raw.githubusercontent.com/Furkan1116/XudbinPanel/main/install.sh | sudo bash
```

Betik şunları yapar ve her adımı terminalde gösterir:
1. Sistemi kontrol eder; RAM 3 GB'tan azsa 2 GB swap açar.
2. Docker kurulu değilse kurar.
3. Xudbin'i indirir ve `xudbin` komutunu kurar.
4. Güvenlik duvarında yalnız SSH, 80 ve 443'ü açar, SSH için fail2ban kurar (`XUDBIN_HARDEN=0` ile atlanır).
5. Paneli başlatır: hazır imaj varsa indirir, yoksa kaynaktan derler.
6. Sunucunun IP'sinden bir panel adresi üretir (`xudbin.1-2-3-4.sslip.io`) ve HTTPS sertifikasını alır.
7. **Kurulum linkini** çerçeve içinde ve telefondan okutulabilir QR kodla gösterir. Yönetici hesabı yalnız bu linkle oluşturulabilir; böylece panel internete açıldığı anda başkası kurulumu senden önce ele geçiremez.

## Sunucudaki `xudbin` komutu

```bash
xudbin link                           # panel adresi (ilk kurulumda kurulum linki), QR kodla
xudbin status                         # özet durum
xudbin user list                      # kullanıcılar
xudbin user create ali@ornek.com Ali --member   # kullanıcı ekler, geçici şifre verir
xudbin user reset-password ali@ornek.com
xudbin user disable-2fa ali@ornek.com # telefon kaybolduysa
xudbin unban 203.0.113.7
sudo xudbin restore /root/xudbin-panel-....xbk   # panel yedeğini geri yükler (s3://bucket/anahtar da olur)
sudo xudbin update                    # Xudbin'i günceller, verilere dokunmaz
xudbin logs                           # panel logları
```

Kendi alan adınla (A kaydı sunucuya yönlendirilmiş olmalı):

```bash
sudo XUDBIN_DOMAIN=panel.ornek.com ACME_EMAIL=sen@ornek.com ./install.sh
```

Dış IP'si olmayan bir yerel ağ sunucusunda (ev sunucusu, test makinesi) Let's Encrypt sertifika veremez; HTTPS'i kapatarak kur:

```bash
sudo XUDBIN_HTTPS=0 ./install.sh
```

Sertifika denemelerinde Let's Encrypt limitlerine takılmamak için staging ortamını kullanabilirsin (tarayıcılar bu sertifikalara güvenmez, yalnız deneme içindir):

```bash
echo 'XUDBIN_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory' | sudo tee -a /opt/xudbin/.env
cd /opt/xudbin && sudo docker compose up -d
```

Kurulum linkini kaçırırsan `xudbin link` komutunu çalıştır.

## Bilmen gerekenler

- **Let's Encrypt:** Xudbin HTTPS sertifikalarını Caddy aracılığıyla Let's Encrypt'ten alır. Bu sırada Caddy, paneli kuran kişi adına [Let's Encrypt Abonelik Sözleşmesi](https://letsencrypt.org/repository/)'ni kabul eder.
- **Otomatik adresler (sslip.io):** Domain almadan verilen `uygulama.1-2-3-4.sslip.io` adresleri ücretsiz, üçüncü taraf bir DNS hizmetine dayanır. Let's Encrypt bu hizmetin tüm kullanıcıları için ortak bir haftalık sertifika kotası uygular; kota dolarsa yeni otomatik adreslere bir süre sertifika alınamayabilir. Canlı siteler için kendi alan adını kullan.
- **Kişisel veriler (KVKK/GDPR):** Panel, saldırı tespiti ve trafik analitiği için uygulamalarına gelen isteklerin IP adresi, adresi, tarayıcı bilgisi ve yönlendiren sayfasını kendi sunucunda tutar (saldırı kayıtları 30 gün, analitik özetleri 400 gün; ziyaretçi sayımı için IP'ler günlük değişen bir anahtarla tek yönlü özetlenir, saklanmaz). Bu verilerin sorumlusu paneli kuran kişidir. Panel hiçbir yere telemetri göndermez; derlenen Next.js, Nuxt ve Astro projelerinin telemetrisi de kapatılır.
- **Logolar:** Framework logoları ve adları sahiplerinin markasıdır; Xudbin'in bu projelerle bir bağlantısı yoktur. Ayrıntılar: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Güvenlik:** Açık bildirmek için [SECURITY.md](SECURITY.md).

## Hazır imajlar

Repo GitHub'a gönderildiğinde `.github/workflows/images.yml` panel ve Caddy imajlarını (amd64 + arm64) `ghcr.io/<sahip>/xudbin` ve `ghcr.io/<sahip>/xudbin-caddy` olarak yayınlar. İlk yayından sonra GitHub > Packages'ta iki paketi de **Public** yap; kurulumlar derleme yapmadan bu imajları kullanır.

## Uzak sunucu eklemek

1. Panelde **Sunucular > Sunucu ekle**. Panel bu sunucu için bir SSH anahtarı üretir.
2. Gösterilen komutu sunucuda çalıştırarak açık anahtarı `authorized_keys` dosyasına ekle.
3. **Bağlantıyı dene**, ardından **Kurulumu başlat**. Docker ve Caddy otomatik kurulur.

Kullanıcı root değilse şifresiz sudo yetkisine sahip olmalı.

## Geliştirme

Node.js 22 veya üstü ve çalışan bir Docker gerekir (Mac'te [OrbStack](https://orbstack.dev) önerilir).

```bash
npm install
npm run dev
```

- Arayüz: http://localhost:5173 (Vite, `/api` isteklerini backend'e yönlendirir)
- API: http://localhost:3000
- İlk açılışta kurulum anahtarı terminale yazılır ve `apps/server/data/setup-token` dosyasında durur.
- Geliştirmede yerel sunucu HTTPS kapalı başlar ve uygulama adresleri `*.127-0-0-1.sslip.io` olur; Caddy Mac'te 80 portunu dinler.

## Mimari

```
apps/server   Hono API (Node.js, node:sqlite, dockerode, ssh2)
apps/web      React arayüzü (Vite, Tailwind, TanStack Query)
install.sh    Tek komutla sunucu kurulumu
```

- Panel her sunucuya Docker API üzerinden bağlanır: kendi sunucusunda soketle, uzak sunucularda SSH tüneliyle (`docker system dial-stdio`).
- Her sunucuda `xudbin` adlı bir Docker ağı ve `xudbin-caddy` konteyneri bulunur. Panel Caddy yapılandırmasını JSON olarak üretip konteynere yazar ve `caddy reload` ile uygular.
- Caddy erişim logları 20 saniyede bir okunur; WAF (403), hız sınırı (429), banlı IP ve hatalı şifre (401) olayları saldırı ekranına düşer.
- Git uygulamaları panelin sunucusunda klonlanır, derleme bağlamı hedef sunucunun Docker'ına gönderilip orada derlenir.

## Sınırlar

- Büyük hacimli (L3/L4) DDoS saldırıları sunucu seviyesinde durdurulamaz; bunun için hosting firmasının koruması veya Cloudflare gibi bir katman gerekir.
- Compose uygulamalarında göreli dosya bağlamaları (`./data:/data`) desteklenmez; adlandırılmış volume kullan.

## Lisans

MIT

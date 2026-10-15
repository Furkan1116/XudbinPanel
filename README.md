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
- Kesintisiz deploy: trafik, yeni sürüm portunu gerçekten dinlemeye başlayınca geçer; başlamazsa eski sürüm yayında kalır
- Tek tıkla önceki sürüme dönüş, canlı deploy ve uygulama logları
- Git push webhook'u ile otomatik deploy (GitHub, GitLab, Gitea...)
- Şifreli ortam değişkenleri, kalıcı depolama klasörleri, CPU/bellek izleme

**Veritabanları**
- PostgreSQL, MySQL, MariaDB, MongoDB, Redis; kullanıcı ve şifre otomatik üretilir
- Elle veya zamanlanmış yedekleme, saklama sayısı, indirme ve geri yükleme

**Güvenlik**
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
curl -fsSL https://raw.githubusercontent.com/furkan1116/xudbin/main/install.sh | sudo bash
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

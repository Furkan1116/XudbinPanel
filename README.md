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
- Kaynak: Git reposu (özel repolar için token), Docker imajı veya Docker Compose
- Dockerfile yoksa proje türünü tanır: Node.js, Next.js, Vite/statik derleme, Django, Flask, FastAPI, Go, statik site
- Kesintisiz deploy: yeni konteyner sağlıklı başlayınca trafik ona geçer, başarısızsa eski sürüm yayında kalır
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

## Kurulum

Ubuntu veya Debian bir sunucuda, 80 ve 443 portları boşken:

```bash
git clone <repo-adresi> xudbin && cd xudbin
sudo ./install.sh
```

Script şunları yapar:
1. Docker kurulu değilse kurar.
2. UFW ile yalnız SSH, 80 ve 443 portlarını açar; SSH için fail2ban kurar (`XUDBIN_HARDEN=0` ile atlanır).
3. Sunucunun IP'sinden bir panel adresi üretir (`xudbin.1-2-3-4.sslip.io`).
4. Paneli başlatır. Panel, Caddy'yi WAF modülleriyle derler ve HTTPS sertifikasını alır (ilk seferde 3-6 dakika).
5. Ekrana **kurulum linkini** yazar. Yönetici hesabı yalnız bu linkle oluşturulabilir; böylece panel internete açıldığı anda başkası kurulumu senden önce ele geçiremez.

Kendi alan adınla (A kaydı sunucuya yönlendirilmiş olmalı):

```bash
sudo XUDBIN_DOMAIN=panel.ornek.com ACME_EMAIL=sen@ornek.com ./install.sh
```

Kurulum linkini kaçırırsan:

```bash
docker exec xudbin cat /data/setup-token
```

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

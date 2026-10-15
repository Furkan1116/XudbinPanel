# Xudbin

Kendi sunucunu kendin yönet. Dokploy ve Coolify'dan ilham alan, self-hosted bir sunucu yönetim paneli.
Bu panellerde eksik kalan üç şeyi baştan çözmeyi hedefliyor:

- **Domain almadan adres:** Her uygulamaya otomatik olarak `uygulama.1-2-3-4.sslip.io` gibi çalışan bir adres verilir.
- **Ücretsiz, otomatik HTTPS:** Caddy, Let's Encrypt sertifikalarını hem otomatik adreslerde hem senin domainlerinde kendisi alır ve yeniler.
- **Yerleşik saldırı koruması:** Rate limit, WAF (Coraza + OWASP CRS), CrowdSec ve canlı saldırı ekranı *(yol haritasında)*.

## Kurulum

Ubuntu veya Debian bir sunucuda, 80 ve 443 portları boşken:

```bash
git clone <repo-adresi> xudbin && cd xudbin
sudo ./install.sh
```

Script şunları yapar:
1. Docker kurulu değilse kurar.
2. Sunucunun IP'sinden bir panel adresi üretir (`xudbin.1-2-3-4.sslip.io`).
3. Paneli ve Caddy'yi başlatır, HTTPS sertifikasını alır.
4. Ekrana **kurulum linkini** yazar. Yönetici hesabı sadece bu linkle oluşturulabilir, böylece panel internete açıldığı anda başkası kurulumu senden önce ele geçiremez.

Kendi domainini kullanmak için (domainin A kaydı sunucuya yönlendirilmiş olmalı):

```bash
sudo XUDBIN_DOMAIN=panel.ornek.com ACME_EMAIL=sen@ornek.com ./install.sh
```

## Geliştirme

Node.js 22 veya üstü gerekir.

```bash
npm install
npm run dev
```

- Arayüz: http://localhost:5173 (Vite, `/api` isteklerini backend'e yönlendirir)
- API: http://localhost:3000
- İlk açılışta kurulum anahtarı terminale yazılır ve `apps/server/data/setup-token` dosyasında durur.

Docker özelliklerini lokalde denemek için Mac'te [OrbStack](https://orbstack.dev) ya da Docker Desktop kurman yeterli.

## Yapı

```
apps/server   Hono API (Node.js, node:sqlite, dockerode)
apps/web      React arayüzü (Vite, Tailwind, TanStack Query)
deploy/       Caddy yapılandırması
install.sh    Tek komutla sunucu kurulumu
```

## Yol haritası

- [x] Kurulum scripti, yönetici hesabı, sunucu durumu
- [ ] Uygulama deploy (Git + Dockerfile/Nixpacks, Docker imajı, Compose) ve canlı loglar
- [ ] Her uygulamaya otomatik sslip.io adresi, özel domain ve otomatik HTTPS
- [ ] Güvenlik katmanı: rate limit, WAF, CrowdSec, firewall/SSH sıkılaştırma, saldırı ekranı
- [ ] Veritabanları, yedekleme, bildirimler
- [ ] Çoklu sunucu

## Lisans

MIT

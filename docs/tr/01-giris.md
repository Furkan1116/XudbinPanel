# Giriş

Xudbin, uygulamalarını, veritabanlarını ve sunucularını tek bir web panelinden yönetmeni sağlayan, kendi sunucuna kurduğun açık kaynaklı bir paneldir.

## Xudbin nedir?

Xudbin, Dokploy ve Coolify gibi self-hosted panellerden ilham alır. Bir Git reposunu, yüklediğin bir klasörü, bir Docker imajını veya bir Docker Compose dosyasını alır; derler, çalıştırır, bir adrese bağlar ve HTTPS sertifikasını alır. Panelin kendi sunucusunun yanında SSH ile bağlanan istediğin kadar uzak sunucuyu da yönetebilirsin.

Kaynak kod: [github.com/Furkan1116/XudbinPanel](https://github.com/Furkan1116/XudbinPanel) (MIT lisansı). Bu belgeler 1.3.0 sürümünü anlatır.

## Diğer panellerden farkı

- **Domain almadan çalışan adres.** Her uygulama otomatik olarak `uygulama-x7k2.1-2-3-4.sslip.io` gibi bir adres alır. DNS ayarı yapman gerekmez; sunucunun IP adresi adrese gömülüdür.
- **Otomatik HTTPS.** Caddy, Let's Encrypt sertifikalarını hem otomatik adresler hem kendi alan adların için alır ve yeniler.
- **Yerleşik saldırı koruması.** Her uygulamada WAF (Coraza + OWASP Core Rule Set), IP başına hız sınırı ve güvenlik başlıkları varsayılan olarak açıktır. Çok fazla engellenen IP'ler tüm sunucularda otomatik banlanır; saldırıları **Güvenlik** sayfasında canlı izlersin.
- **Deploy Doktoru.** Başarısız deploy'larda loglardaki bilinen hataları (Django ALLOWED_HOSTS, eksik gizli anahtar, veritabanı bağlantısı, bellek yetmezliği...) açıklar, uygun olanları tek tıkla düzeltir.
- **Kesintisiz deploy.** Yeni sürüm gerçek alan adıyla yapılan isteğe sağlıklı yanıt verene kadar trafik eski sürümde kalır.

## Neler yapabilirsin?

- Git, dosya yükleme, Docker imajı veya Compose ile uygulama yayınlamak; Django, Next.js, Laravel, Rails, Go, Spring Boot gibi frameworkleri Dockerfile yazmadan deploy etmek
- PostgreSQL, MySQL, MariaDB, MongoDB ve Redis kurmak, zamanlanmış ve doğrulanmış yedek almak
- Erişilebilirlik izleme, çerezsiz trafik analitiği ve e-posta/Discord/Telegram/Slack bildirimleri
- Ekip üyelerini projelere rol vererek eklemek, SSO ile giriş, API anahtarları ve `xb` komut satırı aracı

Arayüz Türkçe ve İngilizce, açık ve koyu temalıdır.

## Gereksinimler

- Ubuntu, Debian veya AlmaLinux/Rocky çalışan bir Linux sunucu
- En az 2 GB RAM (3 GB'tan azsa kurulum betiği 2 GB swap açar; deploy sonrası imaj taraması yaklaşık 1 GB bellek kullanır)
- Boş 80 ve 443 portları (nginx, Apache gibi bir web sunucusu çalışıyorsa önce durdur)
- Root yetkisi (`sudo`)
- Otomatik HTTPS için sunucunun internetten erişilebilir bir dış IP'si. Dış IP'si olmayan sunucular için [Cloudflare Tunnel](04-alan-adi-ve-https.md) veya HTTPS kapalı kurulum kullanılabilir.

Kurulum için: [Kurulum](02-kurulum.md).

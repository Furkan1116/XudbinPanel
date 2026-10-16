# Sık sorulan sorular ve sorun giderme

En sık karşılaşılan sorunların nedenlerini ve nasıl çözeceğini bu sayfada bulursun.

## Django uygulamam 400 Bad Request veriyor

Django tanımadığı alan adlarından gelen istekleri reddeder (`Invalid HTTP_HOST header`). Xudbin, yeni sürüme trafik geçirmeden önce gerçek alan adıyla istek attığı için bu durumda deploy başarısız sayılır ve eski sürüm yayında kalır.

Çözüm:

1. `settings.py`, izinli adresleri bir ortam değişkeninden okumalı:

   ```python
   import os
   ALLOWED_HOSTS = os.environ["DJANGO_ALLOWED_HOSTS"].split(",")
   CSRF_TRUSTED_ORIGINS = os.environ.get("CSRF_TRUSTED_ORIGINS", "").split(",")
   ```

2. Uygulamanın **Ortam değişkenleri** sekmesine ekle; değerler her deploy'da güncel alan adlarıyla doldurulur:

   ```env
   DJANGO_ALLOWED_HOSTS={{XUDBIN_DOMAINS}}
   CSRF_TRUSTED_ORIGINS={{XUDBIN_ORIGINS}}
   ```

3. Yeniden deploy et.

Kısa yol: **Genel** sekmesindeki **Deploy Doktoru** bu hatayı tanır ve `settings.py`'nin okuduğu değişkeni tek tıkla doldurup yeniden deploy eder. Form gönderiminde "CSRF verification failed" alıyorsan da aynı yöntem geçerlidir. Vite, Nuxt (`allowedHosts`) ve Rails (`config.hosts`) için de alan adını izinli adreslere eklemen gerekir.

## Kurulum "80 portu kullanımda" diyor

Sunucuda nginx, Apache veya başka bir panel 80/443 portlarını kullanıyor. O servisi durdur ve devre dışı bırak, sonra kurulumu tekrar çalıştır:

```bash
sudo systemctl disable --now nginx   # veya apache2
```

## Uygulama açılmıyor, port hatası

- Uygulamanın **Ayarlar** sekmesindeki **Port**, uygulamanın konteyner içinde dinlediği portla aynı olmalı. Xudbin uygulamaya `PORT` değişkenini verir; uygulama tek bir başka portu dinliyorsa deploy sırasında ayarı kendisi düzeltir.
- Uygulama `127.0.0.1` yerine `0.0.0.0` adresini dinlemeli; aksi halde deploy logunda bir uyarı görürsün.
- "Port zaten kullanımda" (`EADDRINUSE`) hatası genellikle başlatma komutunun sunucuyu iki kez başlattığı anlamına gelir.
- Compose'taki `ports:` dışarı açılmaz; dışarıdan yalnız 80/443 ve panelden açılan veritabanı portları erişilebilir. Web trafiği için alan adı kullan.

## Bellek yetmiyor (exit code 137)

Konteyner 137 koduyla kapanıyorsa ya da logda `JavaScript heap out of memory`, `MemoryError` görüyorsan bellek yetmiyordur.

- Uygulamanın **Ayarlar** sekmesinde **Bellek sınırı (MB)**'nı artır veya boş bırak.
- Derleme sırasında bellek yetmiyorsa ayrı bir **Derleme sunucusu** kullan ya da sunucunun RAM'ini artır. Kurulum betiği 3 GB'tan az RAM'li sunucularda 2 GB swap açar.
- İmaj taraması yaklaşık 1 GB bellek kullanır; küçük sunucularda **Güvenlik > Puan** sekmesinden **Deploy sonrası imaj taraması**'nı kapatabilirsin.

## HTTPS sertifikası alınamıyor

- Alan adının A kaydı sunucunun IP'sini göstermeli. **Domainler** sekmesi DNS'in doğru olup olmadığını söyler.
- 80 ve 443 portları internete açık olmalı (sağlayıcının güvenlik grubu/firewall'u dahil).
- Alan adı Cloudflare proxy'si arkasındaysa SSL modunu **Full (strict)** yap ya da proxy'yi kapat.
- Otomatik sslip.io adreslerinde Let's Encrypt'in ortak haftalık kotası dolmuş olabilir; kendi alan adını kullan.
- Dış IP'si olmayan sunucuda Let's Encrypt sertifika veremez: **Cloudflare Tunnel** kullan ya da HTTPS'i kapat.
- Sorunu görmek için: `docker logs xudbin-caddy`.

## Şifremi unuttum

Sunucuda geçici bir şifre üret; ilk girişte yenisini belirlersin:

```bash
xudbin user reset-password sen@ornek.com
```

Telefonunu kaybettiysen iki adımlı doğrulamayı kapat:

```bash
xudbin user disable-2fa sen@ornek.com
```

## Kendimi banladım

```bash
xudbin unban <ip-adresin>
```

## Kurulum linkini kaybettim

```bash
xudbin link
```

## Panel açılmıyor

```bash
xudbin status
xudbin logs
xudbin restart
```

## Compose'ta `./data:/data` çalışmıyor

Compose uygulamalarında göreli dosya bağlamaları desteklenmez; adlandırılmış volume kullan.

## Büyük DDoS saldırılarına karşı korunuyor muyum?

WAF ve hız sınırı uygulama seviyesindeki saldırıları durdurur. Büyük hacimli (L3/L4) DDoS saldırıları sunucu seviyesinde durdurulamaz; bunun için hosting firmanın koruması veya Cloudflare gibi bir katman gerekir.

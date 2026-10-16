# Alan adı ve HTTPS

Uygulamaların otomatik bir sslip.io adresiyle hemen yayına girer; istersen kendi alan adını bağlar, sunucuya wildcard alan adı verir veya Cloudflare Tunnel kullanırsın.

## Otomatik adres

Her yeni web uygulaması `uygulama-x7k2.1-2-3-4.sslip.io` biçiminde bir adres alır. sslip.io, adresin içindeki IP'yi döndüren ücretsiz bir DNS hizmetidir; bu yüzden DNS ayarı gerekmez ve HTTPS sertifikası otomatik alınır.

Otomatik adresler sunucunun **Dış IP adresi**'nden üretilir (**Sunucular > sunucu > Ayarlar**). Uygulamanın **Domainler** sekmesinde **Otomatik adres üret** ile yeni bir adres alabilirsin.

Let's Encrypt, sslip.io'nun tüm kullanıcıları için ortak bir haftalık sertifika kotası uygular. Kota dolarsa yeni otomatik adreslere bir süre sertifika alınamayabilir; canlı siteler için kendi alan adını kullan.

## Kendi alan adını bağlamak

1. Alan adı sağlayıcının DNS ayarlarında, alan adın için sunucunun IP'sine bir **A kaydı** oluştur:

   ```text
   blog.ornek.com.   A   203.0.113.10
   ```

2. Uygulamanın **Domainler** sekmesinde **Alan adı bağla** bölümüne alan adını yaz, HTTPS anahtarını açık bırak ve **Ekle**'ye bas.
3. Panel DNS kaydını herkese açık çözücülerle denetler. Kayıt doğruysa listede "DNS bu sunucuyu gösteriyor" yazar; değilse kaydın neyi göstermesi gerektiği söylenir.

Sertifika ilk ziyarette otomatik alınır ve yenilenir. Alan adı Cloudflare proxy'si (turuncu bulut) arkasındaysa Cloudflare'de SSL modunu **Full (strict)** yap ya da proxy'yi kapat.

Django, Rails veya Vite gibi uygulamalar tanımadıkları alan adlarını reddedebilir. İzinli adresleri `{{XUDBIN_DOMAINS}}` ile doldurursan yeni alan adları her deploy'da otomatik eklenir (bkz. [SSS](12-sss.md)).

## Wildcard uygulama alan adı

Yeni uygulamaların sslip.io yerine kendi alan adının altında adres almasını istiyorsan:

1. DNS'te sunucunun IP'sine bir wildcard A kaydı ekle: `*.apps.ornek.com → 203.0.113.10`.
2. **Sunucular > sunucu > Ayarlar** sekmesinde **Otomatik adresler için kendi alan adın** alanına `apps.ornek.com` yaz.
3. **Dene**'ye bas; panel wildcard kaydının sunucuyu gösterip göstermediğini kontrol eder. Sonra **Kaydet**.

Yeni uygulamalar `uygulama.apps.ornek.com` adresini alır; mevcut adresler değişmez.

## HTTPS modları

Her sunucunun **Ayarlar** sekmesindeki **HTTPS** seçeneği üç değer alır:

| Mod | Ne zaman |
|---|---|
| **Let's Encrypt ile otomatik (önerilen)** | İnternetten erişilebilen sunucular |
| **Kendi imzalı sertifika (iç ağ, test)** | İç ağ ve test ortamları; tarayıcı uyarı gösterir |
| **Kapalı, yalnız HTTP** | HTTPS'i başka bir katmanın (ör. Cloudflare Tunnel) sağladığı durumlar |

**Sertifika e-postası** isteğe bağlıdır; Let's Encrypt sertifika sorunlarında buraya yazar.

## Panelin alan adı

Paneli kendi alan adında açmak için alan adını sunucunun IP'sine yönlendir, sonra **Ayarlar > Panel** sekmesinde **Panelin alan adı** alanına yaz ve **Kaydet**. Boş bırakırsan kurulumdaki sslip.io adresi kullanılmaya devam eder.

## Cloudflare Tunnel

Dış IP'si olmayan ya da port açamayan sunucular (ev sunucusu, NAT arkası) için:

1. Cloudflare Zero Trust > Networks > Tunnels'tan bir tunnel oluştur ve token'ını kopyala.
2. **Sunucular > sunucu > Ayarlar** sekmesindeki **Cloudflare Tunnel** bölümüne token'ı yapıştır ve **Tunnel'ı aç**'a bas.
3. Cloudflare'de her alan adı için bir "Public hostname" ekle, servis olarak `http://xudbin-caddy:80` yaz.
4. HTTPS'i Cloudflare sağladığı için bu sunucuda HTTPS'i **Kapalı, yalnız HTTP** yap.

Tunnel durumu ve son loglar aynı bölümde görünür.

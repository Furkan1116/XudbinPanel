# Güvenlik

Uygulamalarını WAF, hız sınırı ve IP listeleriyle korur, saldırıları izler, güvenlik puanındaki eksikleri tek tıkla kapatır ve panel hesabını iki adımlı doğrulamayla güvenceye alırsın.

## Uygulama başına koruma

Uygulamanın **Güvenlik** sekmesinde şu ayarlar bulunur; değiştirdikten sonra **Kaydet ve uygula**'ya bas:

- **Web uygulama güvenlik duvarı (WAF):** OWASP Core Rule Set ile SQL injection, XSS, dosya yolu saldırıları ve kötü niyetli tarayıcılar engellenir. Yeni uygulamalarda açıktır.
- **Hız sınırı:** Aynı IP'den dakikada gelebilecek istek sayısı. Varsayılan 600 istek / dakika / IP.
- **Güvenlik başlıkları:** Clickjacking ve MIME türü tahminine karşı başlıklar eklenir, sunucu bilgisi gizlenir.
- **Şifre koruması:** Siteyi açmak için kullanıcı adı ve şifre (en az 8 karakter) istenir. Test ortamları için kullanışlıdır.
- **Yalnız bu IP'lere izin ver:** Boşsa herkes erişebilir. Satır başına bir IP veya CIDR (ör. `10.0.0.0/8`).
- **Bu IP'leri engelle:** Bu uygulama için engellenecek IP'ler.

## Saldırı ekranı ve IP banları

**Güvenlik** sayfası (yalnız yöneticiler) tüm sunuculardaki Caddy loglarını 20 saniyede bir okur:

- **Saldırılar:** engellenen isteklerin zaman çizelgesi, en çok engellenen IP'ler, en çok hedeflenen adresler ve siteler. Bir IP'nin yanındaki **Banla** ile onu hemen banlarsın.
- **Panelin WAF'ı:** panelin kendi adresi de aynı kurallarla (paranoya 1) denetlenir. Varsayılan mod **Yalnız tespit**'tir, istekleri kesmez; panelin sorunsuz çalıştığını gördükten sonra **Ayarlar > Panel WAF**'tan **Engelle**'ye al. Panel API'sinin JSON gövdeleri (Compose dosyaları, ortam değişkenleri) yanlış alarm vermesin diye `/api/` isteklerinde gövde denetlenmez.
- **Otomatik ban:** yalnız WAF'ın engellediği istekler ve panel girişindeki hatalı denemeler sayılır; uygulamanın kendi 401/403/429 yanıtları saymaz. İzin listesindeki IP asla banlanmaz. Engel ve izin listeleri tek IP ve CIDR (IPv4/IPv6) kabul eder.
- **Olaylar:** WAF, hız sınırı, banlı IP, IP kuralı, hatalı şifre ve panel girişi olaylarının listesi.
- **Banlı IP'ler:** **IP banla** ile bir IP veya CIDR'yi isteğe bağlı bir süreyle banla; **Banı kaldır** ile kaldır. Banlı IP'ler hiçbir sunucudaki uygulamaya ve panele erişemez.

**Otomatik ban** varsayılan olarak açıktır: 10 dakika içinde 30 engellenen istek yapan IP, tüm sunucularda 24 saat banlanır. Değerleri aynı sekmeden değiştirebilirsin.

Kendini yanlışlıkla banladıysan sunucuda:

```bash
xudbin unban 203.0.113.7
```

## Güvenlik puanı

**Güvenlik > Puan** sekmesi panel, sunucular ve uygulamalar için kontrolleri listeler: yöneticilerde 2FA, panel yedeği, yedeklerin sunucu dışında olması, veritabanı yedekleri, güvenlik duvarı, fail2ban, Docker portlarının güvenlik duvarına bağlı olması, SSH ayarları, otomatik güvenlik güncellemeleri, WAF, hız sınırı, bellek sınırı, webhook imzası, hata ayıklama modu ve imajdaki kritik açıklar.

Düzeltilebilen kontrollerin yanında tek tıklık düğmeler bulunur; ör. **WAF'ı aç**, **Başlıkları aç**, **Dakikada 600 istekle sınırla**, **Otomatik güncellemeyi aç**, **Kuralları uygula** veya `DEBUG`'u kapatıp yeniden deploy eden düğme. Diğerleri seni ilgili ayara götürür. **Yeniden denetle** kontrolleri yeniler.

## İmaj taraması

**Güvenlik > Puan** sekmesindeki **Deploy sonrası imaj taraması** açıksa her başarılı deploy'dan sonra imaj Trivy ile bilinen açıklara (CVE) karşı taranır (tarama sırasında yaklaşık 1 GB bellek kullanır). Sonuç uygulamanın **Genel** sekmesindeki **Güvenlik taraması** kartında görünür:

- Açıklar **Temel imaj** ve **Uygulama** bağımlılıkları olarak ayrılır.
- **Ne yapmalısın?** bölümü adım adım ne yapacağını söyler (temel imajı güncelle, belirli paketi yükselt...).
- **Tara** / **Yeniden tara** ile elle tarama başlatırsın.

## Sunucu güvenlik duvarı

Kurulum betiği güvenlik duvarında yalnız SSH, 80, 443 ve panelin IP girişi için 8443'ü açar ve fail2ban kurar (10 dakikada 5 hatalı SSH girişi 1 saat ban). Ayrıca Docker'ın güvenlik duvarını atlaması engellenir: dışarıdan konteynerlere yalnız 80/443, panelin IP girişi (8443; Ayarlar → Panel'den kapatılınca bu port da kapanır) ve panelden açılan veritabanı portları ulaşır.

Her sunucunun durumunu **Sunucular > sunucu > Durum** sekmesindeki **Sunucu güvenliği** bölümünde görürsün; **Sıkılaştır** güvenlik duvarını ve fail2ban'ı kurar.

## Panel hesabı ve 2FA

**Ayarlar > Hesap** sekmesinde:

- **İki adımlı doğrulama** bölümünde **Aç**'a bas, QR kodu Google Authenticator, 1Password veya Bitwarden gibi bir uygulamayla okut, 6 haneli kodu girip **Doğrula ve aç**.
- **Açık oturumlar** listesinden diğer cihazlardaki oturumları kapatabilirsin.

Panelde yönetici olan biri sunucularda root yetkisine sahiptir; yönetici hesaplarında 2FA'yı mutlaka aç. Telefonunu kaybedersen sunucuda `xudbin user disable-2fa <e-posta>` çalıştır.

## Panelin dışarıya attığı istekler

Üyelerin verdiği adreslere (git repo adresi, uygulamanın alan adı) panel sunucusu istek atar. Bu adresler iç ağa çözülüyorsa (`127.x`, `10.x`, `172.16-31.x`, `192.168.x`, `169.254.x` bulut metadata dahil, `100.64/10`, IPv6 yerel/link-local adresleri, IPv4-mapped biçimleri) istek yapılmaz. Uptime izleyici bağlantıyı doğrulanmış IP'ye kurar ve yönlendirmeleri izlemez. Git klonlamada adres önceden denetlenir, yönlendirmeler kapatılır ve yalnız `https` kullanılır; ancak git adresi kendisi çözdüğü için bu **tam bir koruma değildir** (DNS yanıtı denetim ile bağlantı arasında değişebilir). Panel sunucusunun giden trafiğini güvenlik duvarıyla kısıtlamak ek güvence verir.

İç ağdaki bir Gitea/GitLab gibi meşru hedefler için sunucuda `XUDBIN_SSRF_ALLOW=git.sirket.local,10.0.0.5` (virgülle ayrılmış ana bilgisayar adı veya IP) ayarla. Yönetici ayarları (bildirim webhook'u, S3, OIDC) bu süzgeçten geçmez; yerel MinIO gibi kullanımlar için bilerek serbesttir ve yalnız yönetici değiştirebilir.
Panel konteyneri sunucunun dosya sistemini görmez (yalnızca kendi `/data` klasörünü ve güncelleme durumu dosyasını salt okunur görür), `no-new-privileges` ile çalışır ve Linux yetkilerinin (capabilities) çoğu düşürülmüştür. Yine de Docker soketine eriştiği için panel konteynerinin ele geçirilmesi sunucunun ele geçirilmesi demektir; bu, kapsam dışı bir mimari sınırdır (bkz. SECURITY.md).

Bir güvenlik açığı bulursan herkese açık issue açma; GitHub'daki **Security > Report a vulnerability** bağlantısını kullan.

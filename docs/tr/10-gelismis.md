# Gelişmiş kullanım

Zamanlanmış görevler, arka plan işçileri, kopya sayısı, çok sunuculu yük dağıtımı, ayrı derleme sunucusu ve hazır şablonlarla Xudbin'den daha fazlasını alırsın.

## Zamanlanmış görevler (cron)

Uygulamanın **Zamanlanmış görevler** sekmesinde **Görev ekle**'ye bas:

- **Ad:** ör. Gece temizliği
- **Ne zaman:** cron biçimi (`dakika saat gün ay haftanın-günü`), panelin saat dilimine göre çalışır
- **Komut:** ör. `python manage.py clearsessions` veya `php artisan schedule:run`
- **Zaman aşımı (dk)** ve **Etkin**

Komut, uygulamanın son imajıyla, aynı ortam değişkenleri ve kalıcı klasörlerle ayrı bir konteynerde çalışır. **Şimdi çalıştır** ile elle başlatırsın; **Çıktılar** her çalışmanın çıktısını, süresini ve çıkış kodunu gösterir. Tüm görevler **Zamanlanmış görevler** sayfasında listelenir. Başarısız görevler için bildirim alabilirsin.

```text
0 3 * * *     her gece 03:00
*/15 * * * *  15 dakikada bir
```

Zamanlanmış görevler Compose uygulamalarında desteklenmez; Compose dosyana ayrı bir servis ekle. Saat dilimini **Ayarlar > Panel > Saat dilimi**'nden değiştirirsin.

## Arka plan işçileri

Celery, Sidekiq veya `queue:work` gibi web sunucusu olmayan süreçler için uygulamanın **Ayarlar** sekmesinde **Uygulama türü**'nü **Arka plan işçisi** yap. İşçilere alan adı verilmez ve deploy'da HTTP kontrolü yapılmaz. Genellikle aynı repodan ikinci bir uygulama oluşturup başlatma komutunu değiştirirsin.

## Kopya sayısı (replica)

Uygulamanın **Ayarlar** sekmesindeki **Kopya sayısı** 1–10 arasında olabilir. Web uygulamalarında Caddy trafiği kopyalara dağıtır ve çöken kopyayı devre dışı bırakır. Değişiklik bir sonraki deploy'da geçerli olur.

**Bellek sınırı (MB)** ve **CPU sınırı (çekirdek)** ile bir uygulamanın tüm sunucuyu etkilemesini önleyebilirsin; sınır aşılırsa yalnız o uygulama yeniden başlatılır. Bellek sınırı varsayılan olarak boştur (doğru değer uygulamaya göre değişir; boş uygulamalar güvenlik puanında uyarı alır). Süreç sayısı ise her uygulama konteynerinde 512 ile sınırlıdır; fork bombası tüm sunucuyu kilitlemesin diye.

## Çok sunuculu yük dağıtımı

Uygulamanın **Ayarlar** sekmesindeki **Ek sunucular (yük dağıtımı)** bölümünde ek sunucular seç. Uygulama bu sunucularda da çalışır; ziyaretçiler ana sunucuya gelir ve istekler tüm kopyalara dağıtılır, ulaşılamayan sunucu atlanır. Sunucular arası trafik TLS ile şifrelidir. Ayar bir sonraki deploy'da uygulanır.

Sınırlar:

- Durumsuz (stateless) uygulamalar içindir. Kalıcı klasörlü uygulamalar ve Compose uygulamaları dağıtılamaz.
- Ek sunuculardaki kopyalar ana sunucunun iç ağındaki veritabanlarına ulaşamaz. Veritabanını dış erişime açıp bağlantı adresini ona göre ver.
- Ziyaretçiler her zaman ana sunucuya gelir; ana sunucu çökerse site de erişilemez olur. DNS düzeyinde yedeklilik kapsam dışındadır.

## Ayrı derleme sunucusu

Ağır derlemeler canlı uygulamaları yavaşlatmasın diye uygulamanın **Ayarlar** sekmesinde **Derleme sunucusu** seç (Git veya dosya yüklemeyle oluşturulan uygulamalarda, birden çok hazır sunucu varsa görünür). Derleme o sunucuda yapılır, hazır imaj uygulamanın sunucusuna aktarılır. İki sunucu aynı işlemci mimarisinde (ör. ikisi de amd64) olmalıdır.

## Şablonlar

**Şablonlar** sayfasından hazır uygulamaları tek tıkla kurarsın: WordPress, Ghost, n8n, Uptime Kuma, Vaultwarden, Gitea, Nextcloud, Metabase, NocoDB, Adminer, Matomo, Directus, Grafana ve listmonk.

1. Bir şablon seç.
2. **Proje**, **Ad** ve **Sunucu** belirle.
3. **Kur**'a bas.

Şifreler otomatik üretilir, alan adı ve HTTPS hazır gelir. Üretilen değerler uygulamanın **Ortam değişkenleri** sekmesinde görünür; kurulumdan sonra her şeyi değiştirebilirsin.

## Web terminali

Uygulama sayfasındaki **Terminal** sekmesi, uygulamanın çalışan konteynerinde bir komut satırı açar (`bash` varsa `bash`, yoksa `sh`). Migration çalıştırmak, dosyalara bakmak ya da hata ayıklamak içindir. Compose uygulamalarında ve birden çok kopyada hangi konteynere bağlanacağını seçersin.

- Yalnız **yönetici** ve projenin **geliştiricileri** kullanabilir; izleyiciler ve API anahtarları kullanamaz. Terminal, konteynerdeki tüm ortam değişkenlerini ve dosyaları okuyabilir.
- Terminal açmak işlem kaydına yazılır; yazdıkların ve çıktılar kaydedilmez.
- 15 dakika girdi gelmezse ya da sekmeyi kapatırsan terminal kapanır ve konteynerdeki kabuk sonlandırılır. Kullanıcı başına aynı anda en fazla 3 terminal açılabilir.
- Konteynerde yaptığın değişiklikler bir sonraki deploy'da kaybolur; kalıcı olması gerekenler kalıcı klasörde (volume) durmalı.

## Ortak ortam değişkenleri

Proje sayfasındaki **Ortak ortam değişkenleri** bölümüne yazdığın değişkenler o projedeki tüm uygulamalara verilir (ortak bir API anahtarı, SMTP ayarı gibi). Bir uygulama aynı adla kendi değerini tanımlarsa onunki geçerli olur. PR önizlemelerine verilmez; onlar yalnız kendi "önizleme ortam değişkenleri" alanını kullanır. Değişiklik, uygulamalar yeniden deploy edilince geçerli olur.

## Uygulamayı kopyalama

Uygulamanın **Ayarlar** sekmesindeki **Uygulamayı kopyala**, aynı ayarlarla yeni bir uygulama oluşturur: kaynak, derleme ayarları, ortam değişkenleri, güvenlik ayarları ve zamanlanmış görevler kopyalanır. Alan adları, kalıcı klasörlerin içeriği, webhook anahtarları ve "sunucu erişimi" onayı kopyalanmaz. Kopya sen deploy edene kadar çalışmaz; otomatik deploy kapalı başlar.

## Sunucu bakımı

Sunucu sayfasının **Konteynerler** sekmesinde:

- Her konteynerin son logları görülebilir.
- Xudbin dışında oluşturulmuş konteynerler başlatılıp durdurulabilir. Xudbin'in yönettiği konteynerler (uygulamalar, veritabanları, Caddy) kendi sayfalarından yönetilir.
- **Docker disk kullanımı** imajların, derleme önbelleğinin ve kalıcı klasörlerin kapladığı yeri gösterir. **Temizle** yalnız derleme önbelleğini ve sahipsiz imajları siler; uygulamalara, geri dönüş imajlarına ve kalıcı klasörlere dokunmaz. Deploy sürerken çalışmaz.

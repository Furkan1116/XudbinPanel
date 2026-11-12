# İlk uygulamanı yayınla

Bir proje oluşturup içine Git reposundan, yüklediğin dosyalardan, bir Docker imajından veya Compose dosyasından uygulama ekler, deploy eder ve sorunları Deploy Doktoru ile çözersin.

## 1. Proje oluştur

Projeler birbiriyle ilgili uygulama ve veritabanlarını bir arada tutar. Her projenin kendi Docker ağı vardır; bir projedeki uygulama başka projenin uygulamalarına ve veritabanlarına ulaşamaz.

**Projeler > Proje oluştur**'a bas, bir ad ver ve **Oluştur**.

## 2. Uygulama ekle

Projenin sayfasında **Uygulama ekle**'ye bas ve kaynağı seç:

| Kaynak | Ne zaman |
|---|---|
| **Git reposu** | GitHub, GitLab, Gitea... Özel repo için **Erişim token'ı** gir ya da [GitHub App](08-git-ve-otomatik-deploy.md) bağlıysa **GitHub'dan seç**. Monorepo'da **Proje klasörü** alanına alt klasörü yaz (ör. `apps/web`). |
| **Dosya yükle** | Proje klasörünü veya zip dosyasını sürükleyip bırak. `.env` dosyası yüklenmez; değerlerini ortam değişkenlerine gir. Yükleme için yönetici ya da en az bir projede geliştirici olmak gerekir; dosya en fazla 300 MB, açıldığında en fazla 3 GB olabilir; kullanıcı başına aynı anda tek yükleme ve saatte 20 yükleme / 1 GB sınırı vardır. |
| **Docker imajı** | Hazır bir imajı çalıştır, ör. `ghcr.io/kullanici/uygulama:latest`. |
| **Docker Compose** | Birden çok servis. Compose dosyasını repodan alır ya da yapıştırırsın. |

Hazır uygulamalar (WordPress, Ghost, n8n...) için **Hazır uygulama** düğmesini veya **Şablonlar** sayfasını kullan.

## 3. Framework algılama

Git reposunda **Repoyu incele**'ye bastığında repo taranır ve uygun framework önerilir (Django, Flask, FastAPI, Next.js, Nuxt, SvelteKit, Astro, NestJS, Laravel, Rails, ASP.NET Core, Go, Rust, Spring Boot, statik site...). Repoda Dockerfile varsa o kullanılır; yoksa Dockerfile'ı Xudbin üretir ve deploy logunda gösterir.

Seçtiğin framework'ün kartında "deploy'da ne olacak" adımları ve ayarları (ör. Django'da **Her deploy'da migrate çalıştır**) görünür. **Otomatik algıla** seçilirse framework her deploy'da yeniden belirlenir.

## 4. Ortam değişkenleri

Sihirbazın **Ayarlar** adımında ve uygulamanın **Ortam değişkenleri** sekmesinde her satıra `ANAHTAR=değer` yazarsın. Değerler şifrelenerek saklanır.

- **Gerekenlerin hepsini ekle** framework'ün istediği değişkenleri ekler; gizli anahtar gibi değerler otomatik üretilir.
- `.env.example` dosyasındakileri ve kodunda okunan değişkenleri **Hepsini ekle** ile tek tıkla ekleyebilirsin.
- `PORT` otomatik eklenir. `{{XUDBIN_URL}}`, `{{XUDBIN_DOMAINS}}` ve `{{XUDBIN_ORIGINS}}` yazarsan deploy sırasında uygulamanın güncel alan adlarıyla doldurulur:

```env
DJANGO_ALLOWED_HOSTS={{XUDBIN_DOMAINS}}
CSRF_TRUSTED_ORIGINS={{XUDBIN_ORIGINS}}
```

Değişikliklerin geçerli olması için yeniden deploy et.

## 5. Deploy

**Oluştur ve deploy et**'e bas. Canlı log **Deploylar** sekmesinde akar. Yeni sürüm, gerçek alan adıyla yapılan isteğe sağlıklı yanıt verince trafiği devralır; 400 veya 5xx dönerse eski sürüm yayında kalır. Uygulama ayarlandığından farklı bir portu dinliyorsa port ayarı otomatik düzeltilir. 30 dakikada bitmeyen deploy durdurulur; çalışan bir deploy'u **İptal et** ile durdurabilirsin.

Uygulama yayına girince **Genel** sekmesinde otomatik adresini görürsün.

## Yayın kontrolü

Git ve dosya yüklemesiyle gelen kaynak, her yayının başında, derleme başlamadan önce kontrol edilir. **Genel** sekmesindeki **Yayın kontrolü** bölümünde son rapor (kritik/uyarı/bilgi sayısı, ne zaman, hangi commit ya da yükleme) ve bulgular dosya:satır ile birlikte görünür; **Kontrol et** yayınlamadan kontrol eder.

Kontrol edilenler:

- **Gizli bilgi ve gereksiz dosyalar.** Kritik: gövdesiyle birlikte özel anahtar, dolu gizli değer içeren `.env` (`.env.example`, `.env.sample`, `.env.template` hariç), özel anahtarlı servis hesabı JSON'u. Uyarı: SQLite dosyası, `node_modules`, sanal ortam, `__pycache__`, 50 MB üstü dosya, kimlik dosyaları (`id_rsa`, `.pem`, `.p12`). Bilgi: `.gitignore` ya da `.dockerignore` yok. Gizli değerlerin kendisi rapora, günlüğe ya da API yanıtına yazılmaz; yalnız dosya yolu, satır ve anahtar adı.
- **Django.** Kritik: üretimde kullanılacağı kesin olan ayar dosyasında sabit `DEBUG = True`, başlatma komutunun `runserver` olması. Birden çok ayar dosyası varsa ve hangisinin kullanıldığı kesin değilse DEBUG bulgusu uyarıdır ve bakılan dosyalar yazılır. Uyarı: koda gömülü `SECRET_KEY`, `ALLOWED_HOSTS = ["*"]`, kendi Dockerfile'ında gunicorn/uvicorn/daphne yokluğu, eksik `STATIC_ROOT`/whitenoise. Bilgi: `CSRF_TRUSTED_ORIGINS` yok.
- **Node.js ve Next.js.** Kritik: başlatma komutunun geliştirme sunucusu olması (`next dev`, `vite`, `npm run dev` ile çağrılan bir geliştirme sunucusu...). Uyarı: kilit dosyası, `build` ya da çağrılan betik yok, Node sürümü belirtilmemiş. Bilgi: Next.js'te `output: "standalone"` yok.
- **Dockerfile ve port** (yalnız depodaki Dockerfile kullanılıyorsa; ön ayarda Dockerfile'ı panel üretir). Uyarı: `USER` yok, taban imaj etiketsiz ya da `latest`, `EXPOSE` paneldeki portla uyuşmuyor, `ADD` ile uzak adres, `.dockerignore` olmadan `COPY . .`, sunucunun yalnız `127.0.0.1` dinlemesi.

Compose kaynağında yalnız gizli bilgi grubu ve Compose politikasının sonucu rapora girer. İmaj kaynağında kaynak dosya olmadığı için kontrol atlanır; önceki sürüme dönüşte çalışmaz.

**Modlar** (bölümdeki seçimle değişir):

- **Kritik bulguda yayını durdur** (yeni uygulamalarda varsayılan): kritik bulgu varsa derleme başlamaz, eski sürüm yayında kalır. Uyarı ve bilgiler yayını durdurmaz.
- **Yalnız uyar** (panel güncellenmeden önce var olan uygulamalarda varsayılan): bulgular günlüğe ve rapora yazılır, yayın sürer.
- **Kapalı.**

Elle başlattığın yayın durduysa deploy kaydındaki **Yine de yayınla** ile kontrolü bilerek geçebilirsin; bu karar işlem kaydına ve yayın günlüğüne yazılır. Git push ile gelen yayında geçiş yoktur: yayın başarısız olur ve bildirim gider. Kontrolün kendisi hata verirse yayın durmaz.

Bu statik, sezgisel bir dosya kontrolüdür: kod çalıştırmaz, bilinen yaygın hataları erken gösterir. Güvenlik garantisi değildir; "sorun bulunmadı" sonucu uygulamanın güvenli olduğu anlamına gelmez. Büyük depolarda ilk 20.000 dosyaya ve birkaç saniyelik süreye bakılır, kısayollar (symlink) izlenmez.

## Deploy Doktoru

Deploy başarısız olursa ya da uygulama hata veriyorsa **Genel** sekmesindeki **Deploy Doktoru** kartında **Teşhis et**'e bas. Gerçek alan adına istek atılır ve loglar taranır. Bilinen sorunlar (Django ALLOWED_HOSTS, CSRF, eksik gizli anahtar, veritabanı bağlantısı, migration, eksik paket veya ortam değişkeni, bellek yetmezliği) açıklanır; uygun olanlarda tek tıkla düzeltme yapılıp yeniden deploy başlatılır.

## Loglar

**Loglar** sekmesi canlı uygulama loglarını gösterir. Aynı sekmedeki arama kutusuyla son 1 saat ile 14 gün arasındaki geçmiş loglarda arama yaparsın (ör. `Traceback`, `500`); tüm kopyalar ve Compose servisleri dahildir.

## Önceki sürüme dönmek

**Deploylar** sekmesinde dönmek istediğin başarılı deploy'un yanındaki **Bu sürüme dön**'e bas. O sürümün imajıyla bir geri dönüş deploy'u başlar. Geri dönüş Compose uygulamalarında kullanılamaz.

Dosya yükleyerek oluşturduğun uygulamalarda yeni sürümü **Genel** sekmesindeki **Yeni sürüm yükle** alanına bırakman yeterli; yüklenince hemen deploy edilir.

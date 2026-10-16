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
| **Dosya yükle** | Proje klasörünü veya zip dosyasını sürükleyip bırak. `.env` dosyası yüklenmez; değerlerini ortam değişkenlerine gir. |
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

## Deploy Doktoru

Deploy başarısız olursa ya da uygulama hata veriyorsa **Genel** sekmesindeki **Deploy Doktoru** kartında **Teşhis et**'e bas. Gerçek alan adına istek atılır ve loglar taranır. Bilinen sorunlar (Django ALLOWED_HOSTS, CSRF, eksik gizli anahtar, veritabanı bağlantısı, migration, eksik paket veya ortam değişkeni, bellek yetmezliği) açıklanır; uygun olanlarda tek tıkla düzeltme yapılıp yeniden deploy başlatılır.

## Loglar

**Loglar** sekmesi canlı uygulama loglarını gösterir. Aynı sekmedeki arama kutusuyla son 1 saat ile 14 gün arasındaki geçmiş loglarda arama yaparsın (ör. `Traceback`, `500`); tüm kopyalar ve Compose servisleri dahildir.

## Önceki sürüme dönmek

**Deploylar** sekmesinde dönmek istediğin başarılı deploy'un yanındaki **Bu sürüme dön**'e bas. O sürümün imajıyla bir geri dönüş deploy'u başlar. Geri dönüş Compose uygulamalarında kullanılamaz.

Dosya yükleyerek oluşturduğun uygulamalarda yeni sürümü **Genel** sekmesindeki **Yeni sürüm yükle** alanına bırakman yeterli; yüklenince hemen deploy edilir.

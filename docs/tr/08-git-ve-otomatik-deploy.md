# Git ve otomatik deploy

Her push'ta uygulamanı otomatik yeniden deploy eder, GitHub App ile özel repoları token girmeden bağlar ve her pull request için ayrı bir önizleme adresi açarsın.

## Push webhook'u (GitHub, GitLab, Gitea...)

Git reposundan oluşturulan her uygulamanın bir webhook adresi ve gizli anahtarı vardır.

1. Uygulamanın **Genel** sekmesindeki **Otomatik deploy** bölümünden **Webhook adresi**'ni ve **Gizli anahtar (Secret)**'ı kopyala.
2. Git sağlayıcında repo ayarlarına bir webhook ekle: adres alanına webhook adresini, Secret / Secret token alanına gizli anahtarı yapıştır, olay olarak push'u seç.
3. Uygulamanın **Ayarlar** sekmesinde **Push'ta otomatik deploy** açık olsun.
4. Secret'ı ekledikten sonra **Webhook imzası zorunlu**'yu aç. Böylece webhook adresi sızsa bile gizli anahtarla imzalanmamış istekler deploy başlatamaz.

Yalnız uygulamanın dalına (branch) yapılan push'lar deploy tetikler.

## GitHub App

GitHub App bağlarsan özel repolar token girmeden deploy edilir, repolar listeden seçilir, push ve PR olayları webhook kurmadan gelir ve önizleme adresleri PR'a yorum olarak yazılır.

### Önce bunları kontrol et

- Panele `https://` ile, **internetten erişilebilen** bir adresle girmiş olmalısın. GitHub olayları bu adrese gönderir; `localhost`, iç ağ adresi veya HTTPS'i kapalı bir panel çalışmaz.
- Aynı tarayıcıda **önce GitHub'a giriş yap**. Organizasyonda SSO varsa onu da onayla.
- App'i bir organizasyonda oluşturacaksan orada yönetici (owner) olmalısın.

### Kurulum

1. **Git kaynakları** sayfasını aç.
2. App'i bir organizasyonda oluşturmak istiyorsan **Organizasyon (isteğe bağlı)** alanına adını yaz; boş bırakırsan kişisel hesabında oluşturulur.
3. **GitHub App oluştur**'a bas. GitHub'da açılan sayfada yalnız **Create GitHub App** düğmesine bas; ayarlar hazır gelir.
4. Panele dönünce **Repolara erişim ver** ile App'in hangi repolara erişebileceğini seç.

App şu izinleri ister: kod okuma (`contents: read`) ve PR yorumu (`pull_requests: write`); olaylar: `push`, `pull_request`.

Artık uygulama eklerken **Git reposu** adımında **GitHub'dan seç** listesi görünür. Erişimi sonradan değiştirmek için **Repoları düzenle**'yi kullan. **Bağlantıyı kaldır** panelden App'in anahtarlarını siler; App'i tamamen silmek için GitHub'daki App ayarlarına git.

Önceki denemelerden yarım kalmış App'ler varsa aynı sayfadaki **GitHub'daki App'lerini gör** bağlantısından silebilirsin.

## Pull request önizlemeleri

Her PR ayrı bir adreste açılır, yeni commit'lerde güncellenir ve PR kapanınca uygulama verileriyle birlikte silinir.

1. Uygulamanın **Ayarlar** sekmesinde **Pull request önizlemeleri**'ni aç.
2. GitHub App kullanıyorsan başka bir şey gerekmez. Elle webhook kullanıyorsan Git sağlayıcının webhook ayarında "Pull requests" olaylarını da seç.

GitHub App bağlıysa (ya da uygulamada bir GitHub erişim token'ı kayıtlıysa) önizleme adresi PR'a yorum olarak yazılır. Açık önizlemeler ana uygulamanın **Genel** sekmesinde **Açık PR önizlemeleri** altında listelenir. Güvenlik nedeniyle fork'tan gelen PR'lar deploy edilmez. Önizlemeler ana uygulamanın üretim ortam değişkenlerini **almaz**: depoya yazabilen herkes bir dalda kod çalıştırabildiği için, **Ortam değişkenleri** sekmesindeki ayrı **Önizleme ortam değişkenleri** listesi kullanılır (boşsa önizleme yalnız `XUDBIN_PREVIEW=1` alır). Oraya test değerleri koy. Git token'ı yalnız klonlamak için kullanılır ve klonlanan deponun `.git/config` dosyasına yazılmaz. Bu sürümden önce açılmış önizlemeler, PR'a yeni bir olay (ör. push) geldiğinde yeni listeyle güncellenir.

## Özel imaj kayıt depoları (GHCR, Docker Hub, GitLab...)

Uygulaman özel bir Docker imajından geliyorsa (ör. `ghcr.io/sirketim/api:latest`) ya da Dockerfile'ındaki temel imaj özelse, panelin o depoya giriş yapabilmesi gerekir. Yönetici olarak **Git kaynakları** sayfasındaki **İmaj kayıt depoları** bölümünden **Giriş ekle**'ye bas ve şunları gir:

- **Kayıt deposu:** `ghcr.io`, `docker.io`, `registry.gitlab.com` ya da `registry.ornek.com:5000`. Docker Hub'ın diğer adları (`index.docker.io`, `registry-1.docker.io`) `docker.io` olarak kaydedilir.
- **Kullanıcı adı** ve **şifre veya token:** GitHub'da `read:packages` izinli bir token, Docker Hub'da salt okunur bir erişim token'ı, GitLab'da `read_registry` izinli bir deploy token önerilir.

Kaydetmeden önce giriş, panelin kendi sunucusundaki Docker üzerinden depoya karşı denenir (`docker login` ile aynı denetim); yanlış giriş kaydedilmez. Depoya yalnız uzak sunuculardan ulaşılabiliyorsa **Kaydetmeden önce doğrula**'yı kapatabilirsin. Kayıtlı bir girişi sonradan **Dene** ile yeniden doğrulayabilir, **Düzenle** ile token'ını yenileyebilirsin. Her depo için bir giriş tutulur.

Panel girişi imajın adresine bakarak kendisi seçer (adreste depo yoksa imaj Docker Hub'dadır: `nginx`, `kullanici/uygulama`):

- **Docker imajı** kaynaklı uygulamalar: imaj, uygulamanın sunucusunda çekilirken. Uzak sunucular ve ek sunuculardaki kopyalar da dahil; ek sunuculara imaj ana sunucudan aktarıldığı için orada ayrıca giriş gerekmez.
- **Git ve dosya yükleme** kaynaklı uygulamalar: Dockerfile'daki temel imaj özel bir depodaysa derleme sırasında (ayrı derleme sunucusunda da).
- **Docker Compose:** `docker compose` yalnız o deploy süresince var olan, deploy klasörünün dışında, yalnız panelin okuyabildiği geçici bir Docker yapılandırmasıyla çalışır; deploy bitince silinir.

Şifre ve token şifrelenerek saklanır, API'den ve arayüzden hiç dönmez, deploy loglarına yazılmaz. Derleme adımlarına (`RUN`, build argümanları) ya da konteynerlere geçmez; Compose dosyası geçici yapılandırma dosyasını okuyamaz (compose klasörü dışındaki dosyalar ancak yöneticinin açtığı "Sunucu erişimi" izniyle kullanılabilir).

**Bilmen gereken:** girişler panel genelindedir. Uygulama deploy edebilen her kullanıcı (üyeler dahil), burada girişi olan bir depoda token'ın erişebildiği **her imajı** kendi uygulamasına deploy edebilir ve böylece imajın içeriğini görebilir. Token'ı kimse göremez ama erişimini kullanabilir. Bu yüzden yalnız okuma izni olan ve yalnız panelde çalışacak imajların repolarına erişen bir token kullan; daha hassas imajlar için ayrı bir hesap/token düşün. Bu sayfaya ve API'sine (`/api/settings/registries`) yalnız yöneticiler erişebilir; ekleme, değiştirme, silme ve deneme işlemleri işlem kaydına yazılır.

## CI'dan deploy

Deploy'u kendi CI hattından (ör. testler geçince) başlatmak istiyorsan bir API anahtarı ve `xb` aracını kullan: [Komut satırı ve API](11-cli-ve-api.md).

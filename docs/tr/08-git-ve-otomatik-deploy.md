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

## CI'dan deploy

Deploy'u kendi CI hattından (ör. testler geçince) başlatmak istiyorsan bir API anahtarı ve `xb` aracını kullan: [Komut satırı ve API](11-cli-ve-api.md).

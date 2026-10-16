# Ekip ve erişim

Ekip arkadaşlarını panele ekler, yönetici veya üye rolü verir, üyeleri projelere geliştirici ya da izleyici olarak atar, işlemleri kayıt altında tutar ve SSO ile giriş sağlarsın.

## Kullanıcı eklemek

**Ayarlar > Kullanıcılar** sekmesinde **Kullanıcı ekle**'ye bas, ad, e-posta ve rol gir. Panel geçici bir şifre üretir; bu şifre bir daha gösterilmez, kullanıcıya kendin iletirsin. Kullanıcı ilk girişte kendi şifresini belirler.

Aynı sekmeden rol değiştirebilir, **Şifre sıfırla** ile yeni geçici şifre üretebilir veya kullanıcıyı silebilirsin. Sunucudan da yapılabilir:

```bash
xudbin user create ali@ornek.com Ali --member
xudbin user reset-password ali@ornek.com
```

## Roller

| Rol | Yetki |
|---|---|
| **Yönetici** | Her şey: sunucular, güvenlik, ayarlar, kullanıcılar ve tüm projeler |
| **Üye** | Yalnız eklendiği projeler, uygulamalar ve veritabanları; sunuculara, güvenliğe ve ayarlara erişemez |

Yönetici Docker'a eriştiği için sunucularda fiilen root yetkisine sahiptir; bu rolü yalnız güvendiğin kişilere ver ve 2FA'yı açtır. Üyeler Compose dosyalarında sunucuya erişim veren ayarları (privileged, sunucu klasörü bağlama, host ağı) kullanamaz; bunu yalnız bir yönetici, uygulamanın **Ayarlar** sekmesindeki **Sunucu erişimi** ile açabilir.

## Proje rolleri

Üyeler yalnız eklendikleri projeleri görür. Projenin sayfasındaki **Üyeler** bölümünden **Üye seç**, rol belirle ve **Ekle**:

- **Geliştirici:** projedeki uygulama ve veritabanlarını oluşturabilir, deploy edebilir, ayarlarını değiştirebilir.
- **İzleyici:** her şeyi görebilir ama hiçbir şeyi değiştiremez.

Bir üyenin oluşturduğu projeye o üye otomatik olarak geliştirici olarak eklenir.

## İşlem kaydı

**Ayarlar > İşlem kaydı** sekmesi kimin, ne zaman, hangi IP'den neyi değiştirdiğini gösterir. Kullanıcı, işlem, adres veya IP ile arama yapabilirsin.

## API anahtarları

**Ayarlar > Hesap > API anahtarları** bölümünden CI/CD veya `xb` aracı için anahtar oluşturursun. Anahtar senin yetkilerinle çalışır.

- **Geçerlilik:** 30 gün, 90 gün, 1 yıl veya süresiz.
- **Salt okunur:** yalnız bilgi okuyabilir; deploy başlatamaz, hiçbir şeyi değiştiremez.

Anahtar yalnız oluşturulduğu anda gösterilir; hemen kopyala. Kullanım için: [Komut satırı ve API](11-cli-ve-api.md).

## Tek oturum açma (SSO)

Google Workspace, Microsoft Entra, Keycloak, Authentik, GitLab gibi bir OpenID Connect sağlayıcısıyla giriş açabilirsin. Ayar **Ayarlar > Panel** sekmesindeki **Tek oturum açma (SSO)** bölümündedir.

1. Sağlayıcında bir OIDC istemcisi oluştur ve panelde gösterilen **Yönlendirme adresi**'ni (`https://<panel>/api/auth/oidc/callback`) gir.
2. Panelde **Sağlayıcı adresi (issuer)** (ör. `https://accounts.google.com`), **Client ID**, **Client secret** ve giriş ekranındaki **Düğme yazısı**'nı gir.
3. **Yeni kullanıcıları otomatik oluştur** kapalıysa yalnız panelde zaten kayıtlı e-postalar SSO ile girebilir. Açarsan **İzin verilen e-posta alan adları**'ndan (ör. `sirketim.com`) gelenler üye olarak oluşturulur; onları projelere sen eklersin.
4. **Kaydet**.

SSO ile girenlerde iki adımlı doğrulama sağlayıcıda yapılır. Kapatmak için **SSO'yu kapat**.

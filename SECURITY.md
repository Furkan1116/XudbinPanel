# Güvenlik politikası

Xudbin, sunucularını yöneten bir panel olduğu için güvenlik açıklarını çok ciddiye alıyoruz.

## Açık bildirmek

Bir güvenlik açığı bulduysan lütfen **herkese açık bir issue açma**. Bunun yerine GitHub'daki
[Security > Report a vulnerability](https://github.com/Furkan1116/XudbinPanel/security/advisories/new) bağlantısından
gizli olarak bildir. Bildirimde şunlar olursa hızlı ilerleriz:

- Etkilenen sürüm veya commit
- Açığı yeniden üretme adımları
- Olası etkisi (ör. kimlik doğrulamasız erişim, başka bir projenin verisine erişim)

Bildirimleri 72 saat içinde yanıtlamaya, doğrulanan açıkları düzeltip sürüm notunda (izin verirsen adınla) belirtmeye çalışırız.

## Desteklenen sürümler

Güvenlik düzeltmeleri yalnız en son sürüme gelir. Güncellemek için sunucuda `sudo xudbin update` çalıştır.

## Tehdit modeli (kısaca)

- Panel, Docker soketine erişir; yani **panelde yönetici olan biri sunucularda root yetkisine sahiptir**. Yönetici hesaplarında iki adımlı doğrulamayı aç.
- **Üye rolü henüz güçlü bir güvenlik sınırı değildir.** Üye, yalnız kendisine atanan projeleri görsün diye tasarlandı; ancak 2026-10-17'de yapılan bağımsız kod incelemesi, yetki ve Compose denetimlerinde üyenin başka projelere ya da panele erişebilmesine yol açabilecek eksikler buldu. Bunlar üzerinde çalışılıyor. **Düzeltilene kadar üye rolünü yalnız güvendiğin ekip arkadaşlarına ver; güvenmediğin birine verme.**
- Her projenin kendi Docker ağı vardır, ancak Compose ile dağıtılan uygulamalarda bu yalıtım şu an aşılabilir. Tek konteynerli uygulamalar ve veritabanları için amaç, başka projelere ve panelin API'sine doğrudan ulaşılamamasıdır.
- Dışarıdan konteynerlere yalnız 80/443 ve panelden açıkça dışarı açılan veritabanı portları ulaşır (Docker'ın güvenlik duvarını atlaması engellenir).
- **Bilinen sınırlar (2026-10-17 incelemesine göre):** kurulum ve güncelleme yalnız sürüm etiketlerinden yapılır ve panel ile Caddy imajlarının Sigstore imzası kurulmadan önce doğrulanır (doğrulanamazsa güncelleme durur); kaynaktan derlenen kurulumlar ve `XUDBIN_VERIFY=0` bu doğrulamayı yapmaz; veritabanı ve volume yedekleri şifresiz saklanır; WAF uygulamalarda açıktır, panelin kendi adresinde yalnız hız sınırı vardır.
- SSH ile bağlanılan sunucuların anahtarı ilk bağlantıda kaydedilir ve sonraki her bağlantıda doğrulanır.
- **Giriş koruması:** başarısız giriş denemeleri hem IP hem e-posta başına sayılır (başarılı giriş IP sayacını sıfırlamaz); ilk kurulum işlemde yeniden denetlenir. İki adımlı doğrulamayı kapatmak için şifre de gerekir ve denemeler sınırlıdır; e-posta, şifre ya da 2FA değişince diğer oturumlar kapanır.
- **SSO:** state, girişi başlatan tarayıcıya HttpOnly çerezle bağlanır ve sağlayıcıdan `email_verified: true` beklenir (bu alanı göndermeyen sağlayıcılarla giriş yapılamaz). SSO, 2FA'yı atladığı için yerel şifreli yönetici hesaplarına ve 2FA'lı hesaplara hiç bağlanmaz; yerel şifreli üyelere yalnız ayarlardan "şifreli üye hesaplarına SSO ile girişe izin ver" açılırsa bağlanır.
- Beklenmeyen sunucu hataları istemciye genel mesajla döner; ayrıntı yalnız sunucu logundadır.
- Şifreler scrypt ile, oturum anahtarları SHA-256 özetiyle saklanır; SSH anahtarları, ortam değişkenleri, veritabanı şifreleri ve yedekleme bilgileri AES-256-GCM ile şifrelenir.

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
- **Bilinen sınırlar (2026-10-17 incelemesine göre):** kurulum ve güncelleme yalnız sürüm etiketlerinden yapılır ve panel ile Caddy imajlarının Sigstore imzası kurulmadan önce doğrulanır (doğrulanamazsa güncelleme durur); kaynaktan derlenen kurulumlar ve `XUDBIN_VERIFY=0` bu doğrulamayı yapmaz; WAF uygulamalarda açıktır, panelin kendi adresinde yalnız hız sınırı vardır.
- **Panel konteyneri:** sunucunun kök dizini (`/:/host`) artık panele bağlanmaz; panel yalnız `/data` volume'unu ve `/opt/xudbin/status` klasörünü (güncelleme durumu) salt okunur görür. Konteyner `no-new-privileges` ile çalışır, `cap_drop: ALL` uygulanır ve yalnız `CHOWN`, `DAC_OVERRIDE`, `FOWNER` geri verilir. Panel hâlâ root kullanıcısıyla çalışır ve `docker.sock`'a erişir; bu yüzden panel konteynerinde kod çalıştırabilen biri sunucuda root'a eşdeğerdir. Root olmayan kullanıcıya geçiş (soketin grubu sunucuya göre değişir, Compose uygulama dizinleri ve yedekler root'a ait) ve salt okunur kök dosya sistemi (git, ssh, Compose geçici dosya yazar) henüz yapılmadı. Öneri: `docker.sock` önüne yalnız gereken API çağrılarına izin veren bir socket-proxy koymak (büyük bir mimari değişiklik, kapsam dışı).
- **Yedek şifreleme:** veritabanı ve volume yedekleri diskte ve S3'te AES-256-GCM ile (varsayılan, akış halinde) şifrelenir; dosya başına anahtar panelin `secret.key` dosyasından HKDF ile türetilir. Bu yüzden `secret.key`'e erişen yedekleri de açar, `secret.key`'i panel verisiyle birlikte kaybeden yedekleri açamaz (panel yedeği `secret.key`'i taşır, bu yüzden panel yedeğini kur). Bu özellikten önce alınmış yedekler şifresizdir. Ayrı bir kullanıcı parolası kullanılmaz.
- SSH ile bağlanılan sunucuların anahtarı ilk bağlantıda kaydedilir ve sonraki her bağlantıda doğrulanır.
- Şifreler scrypt ile, oturum anahtarları SHA-256 özetiyle saklanır; SSH anahtarları, ortam değişkenleri, veritabanı şifreleri ve yedekleme bilgileri AES-256-GCM ile şifrelenir.

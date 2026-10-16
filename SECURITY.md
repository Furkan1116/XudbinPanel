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
- **Üye** rolü yalnız kendisine atanan projeleri görür. Üyeler Compose dosyalarında sunucuya erişim veren ayarları (privileged, sunucu klasörü bağlama, host ağı) kullanamaz; bunu yalnız bir yönetici uygulama bazında açabilir.
- Uygulamalar kendi proje ağlarındadır; başka projelerin uygulamalarına, veritabanlarına ve panelin API'sine doğrudan ulaşamaz.
- Dışarıdan konteynerlere yalnız 80/443 ve panelden açıkça dışarı açılan veritabanı portları ulaşır (Docker'ın güvenlik duvarını atlaması engellenir).
- SSH ile bağlanılan sunucuların anahtarı ilk bağlantıda kaydedilir ve sonraki her bağlantıda doğrulanır.
- Şifreler scrypt ile, oturum anahtarları SHA-256 özetiyle saklanır; SSH anahtarları, ortam değişkenleri, veritabanı şifreleri ve yedekleme bilgileri AES-256-GCM ile şifrelenir.

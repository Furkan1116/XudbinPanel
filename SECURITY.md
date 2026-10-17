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
- **Panelin dışarıya attığı istekler (SSRF):** üye kaynaklı adresler (git repo adresi, uptime izleyicinin alan adı) iç ağa/özel aralıklara çözülüyorsa reddedilir; uptime bağlantısı doğrulanmış IP'ye kurulur ve yönlendirme izlemez. Git klonlamada adres önceden denetlenir, yönlendirme kapatılır, yalnız https kullanılır; git adresi kendisi çözdüğü için bu tam koruma değildir (DNS-rebinding penceresi kalır, sunucunun giden trafiğini güvenlik duvarıyla kısıtlamak önerilir). Yönetici ayarları (bildirim, S3, OIDC) süzülmez. İç ağ hedefleri için `XUDBIN_SSRF_ALLOW`.

- **Dosya yükleme ve kaynak sınırları:** zip yükleme yalnız yöneticiye ya da en az bir projede geliştirici olan üyeye açıktır; kullanıcı başına aynı anda tek yükleme, saatte 20 yükleme / 1 GB, geçici yüklemeler için toplam 2 GB disk sınırı vardır (sayaçlar bellektedir, panel yeniden başlayınca sıfırlanır). Arşiv açılırken yalnız beyan edilen boyut değil gerçek yazılan toplam da izlenir. Her uygulama konteynerinde PidsLimit 512 uygulanır; bellek sınırı varsayılan olarak yoktur (uygulama ayarından konur, güvenlik puanı uyarır), yani bellek tüketen bir uygulama hâlâ sunucuyu etkileyebilir.
- SSH ile bağlanılan sunucuların anahtarı ilk bağlantıda kaydedilir ve sonraki her bağlantıda doğrulanır.
- Şifreler scrypt ile, oturum anahtarları SHA-256 özetiyle saklanır; SSH anahtarları, ortam değişkenleri, veritabanı şifreleri ve yedekleme bilgileri AES-256-GCM ile şifrelenir.

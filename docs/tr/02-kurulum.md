# Kurulum

Xudbin'i tek komutla sunucuna kurar, kurulum linkiyle yönetici hesabını oluşturur ve sunucudaki `xudbin` komutuyla paneli yönetirsin.

## Gereksinimler

- Ubuntu, Debian veya AlmaLinux/Rocky; en az 2 GB RAM
- 80 ve 443 portları boş olmalı
- Root yetkisi

## Tek komutla kurulum

```bash
curl -fsSL https://raw.githubusercontent.com/Furkan1116/XudbinPanel/main/install.sh | sudo bash
```

Betik her adımı terminalde gösterir:

1. Sistemi kontrol eder; RAM 3 GB'tan azsa 2 GB swap açar.
2. Docker yoksa kurar.
3. Xudbin'i `/opt/xudbin` klasörüne indirir ve `xudbin` komutunu kurar.
4. Güvenlik duvarında yalnız SSH, 80 ve 443'ü açar, SSH için fail2ban kurar.
5. Hazır imajı (`ghcr.io/furkan1116/xudbin`) indirir; bulamazsa kaynaktan derler.
6. Sunucunun IP'sinden `xudbin.1-2-3-4.sslip.io` gibi bir panel adresi üretir ve HTTPS sertifikasını alır.
7. Kurulum linkini ve QR kodunu gösterir.

### Kurulum seçenekleri

Betiği ortam değişkenleriyle özelleştirebilirsin:

```bash
# Kendi alan adınla (A kaydı önceden sunucuyu göstermeli)
curl -fsSL https://raw.githubusercontent.com/Furkan1116/XudbinPanel/main/install.sh | sudo XUDBIN_DOMAIN=panel.ornek.com ACME_EMAIL=sen@ornek.com bash

# Dış IP'si olmayan yerel ağ/test sunucusunda HTTPS kapalı
curl -fsSL https://raw.githubusercontent.com/Furkan1116/XudbinPanel/main/install.sh | sudo XUDBIN_HTTPS=0 bash
```

`XUDBIN_HARDEN=0` verirsen güvenlik duvarı ve fail2ban kurulmaz.

## İlk yönetici hesabı

Kurulumun sonunda bir **kurulum linki** gösterilir (`...?setup=<anahtar>`). Yönetici hesabı yalnız bu linkteki kurulum anahtarıyla oluşturulabilir; böylece panel internete açıldığı anda başkası hesabı senden önce ele geçiremez.

1. Linki tarayıcıda aç (veya QR kodu telefonla okut).
2. **Yönetici hesabını oluştur** ekranında adını, e-postanı ve en az 10 karakterlik bir şifre gir. **Kurulum anahtarı** alanı linkten dolar.
3. **Hesabı oluştur**'a bas.

Linki kaçırdıysan sunucuda tekrar göster:

```bash
xudbin link
```

Linki kimseyle paylaşma. Hesabı oluşturduktan sonra **Ayarlar > Hesap** bölümünden iki adımlı doğrulamayı açman önerilir.

## `xudbin` komutu

```bash
xudbin link                                    # panel adresi (ilk kurulumda kurulum linki), QR kodla
xudbin status                                  # sunucu, uygulama, veritabanı, kullanıcı ve banlı IP sayıları
xudbin user list                               # kullanıcılar
xudbin user create ali@ornek.com Ali --member  # kullanıcı ekler (--member yoksa yönetici), geçici şifre verir
xudbin user reset-password ali@ornek.com       # geçici şifre üretir, oturumları kapatır
xudbin user disable-2fa ali@ornek.com          # telefon kaybolduysa 2FA'yı kapatır
xudbin user delete ali@ornek.com
xudbin unban 203.0.113.7                       # IP banını kaldırır
sudo xudbin restore /root/xudbin-panel-....xbk # panel yedeğini geri yükler
sudo xudbin update                             # Xudbin'i günceller
xudbin restart                                 # paneli yeniden başlatır
xudbin logs                                    # panel loglarını izler
```

## Güncelleme

Yeni sürüm çıktığında panelin üst kısmında bildirim görünür. **Ayarlar > Panel** sekmesinde **Güncelle**'ye basman yeterli; panel birkaç dakika içinde yeniden başlar ve sayfa kendiliğinden yenilenir.

Sunucudan da güncelleyebilirsin:

```bash
sudo xudbin update
```

Güncelleme uygulamalarına, veritabanlarına ve panel verisine dokunmaz. Güvenlik düzeltmeleri yalnız en son sürüme gelir.

## İmajları doğrulama

Hazır imajlar GitHub Actions'ta derlenip Sigstore (cosign) ile imzalanır; SBOM ve köken (provenance) bilgisi de imajla yayınlanır. İmzayı doğrulamak için:

```bash
cosign verify ghcr.io/furkan1116/xudbin:latest \
  --certificate-identity-regexp '^https://github.com/Furkan1116/XudbinPanel/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Uzak sunucu eklemek

1. **Sunucular > Sunucu ekle**'ye bas; ad, IP adresi, SSH portu ve kullanıcıyı gir (root önerilir; başka kullanıcı şifresiz sudo yetkisine sahip olmalı).
2. **Kurulum** sekmesinde gösterilen komutu sunucuda çalıştırarak panelin SSH anahtarını ekle.
3. **Bağlantıyı dene**, ardından **Kurulumu başlat**. Docker ve Caddy otomatik kurulur; ilk kurulum 3–6 dakika sürebilir.

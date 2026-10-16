# Komut satırı ve API

`xb` komut satırı aracıyla ve API anahtarlarıyla deploy'ları kendi bilgisayarından veya CI/CD hattından yönetirsin.

## API anahtarı oluştur

**Ayarlar > Hesap > API anahtarları** bölümünde bir ad (ör. GitHub Actions) ve **Geçerlilik** seç, **Oluştur**'a bas. Anahtar `xb_` ile başlar ve yalnız bir kez gösterilir.

- CI için süreli bir anahtar kullan.
- Deploy başlatacaksan **Salt okunur** seçme; salt okunur anahtar yalnız bilgi okuyabilir.
- Anahtar seninle aynı yetkilere sahiptir. Üyeysen yalnız erişebildiğin projelerdeki uygulamaları görür.

## `xb` kurulumu

`xb` tek dosyalık bir Node.js betiğidir (Node.js 18 veya üstü yeterli, başka bağımlılık yok):

```bash
sudo curl -fsSL https://raw.githubusercontent.com/Furkan1116/XudbinPanel/main/cli/xb.mjs -o /usr/local/bin/xb
sudo chmod +x /usr/local/bin/xb
xb login https://panel.ornek.com xb_...
```

`xb login` adresi ve anahtarı `~/.config/xudbin/cli.json` dosyasına kaydeder. Bunun yerine `XUDBIN_URL` ve `XUDBIN_TOKEN` ortam değişkenlerini de kullanabilirsin.

## Komutlar

```bash
xb apps                       # uygulamaları listeler (no, ad, durum, adres)
xb status blog                # durum, alan adları, son deploy
xb deploy blog                # deploy başlatır
xb deploy blog --wait         # deploy başlatır, logu izler; başarısızsa çıkış kodu 2
xb logs blog                  # canlı uygulama logları
xb rollback blog 42           # #42 numaralı deploy'a döner
```

Uygulamayı adıyla, kısa adıyla (slug) veya numarasıyla belirtebilirsin.

## GitHub Actions örneği

Anahtarı repo ayarlarında `XUDBIN_TOKEN` adlı gizli değişken olarak sakla:

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Xudbin'e deploy
        run: |
          curl -fsSL https://raw.githubusercontent.com/Furkan1116/XudbinPanel/main/cli/xb.mjs -o xb.mjs
          node xb.mjs deploy blog --wait
        env:
          XUDBIN_URL: https://panel.ornek.com
          XUDBIN_TOKEN: ${{ secrets.XUDBIN_TOKEN }}
```

`--wait` sayesinde deploy başarısız olursa iş de başarısız olur. Bu yöntemi kullanıyorsan aynı uygulamada push webhook'unu veya **Push'ta otomatik deploy**'u kapat, yoksa her push iki deploy başlatır.

## API'yi doğrudan kullanmak

Tüm istekler `Authorization: Bearer <anahtar>` başlığıyla `https://<panel>/api` altına gider:

```bash
# Uygulamaları listele
curl -H "Authorization: Bearer xb_..." https://panel.ornek.com/api/apps

# Deploy başlat (yanıt: {"deploymentId": ...})
curl -X POST -H "Authorization: Bearer xb_..." -H "Content-Type: application/json" -d '{}' \
  https://panel.ornek.com/api/apps/<no>/deploy

# Deploy durumunu sorgula
curl -H "Authorization: Bearer xb_..." https://panel.ornek.com/api/deployments/<deploy-no>
```

Uygulama numarası paneldeki uygulama adresinde ve `xb apps` çıktısında görünür.

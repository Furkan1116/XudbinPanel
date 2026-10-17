# Veritabanları ve yedekler

Tek tıkla veritabanı kurar, zamanlanmış ve doğrulanmış yedekler alır, yedekleri S3 uyumlu depolamaya gönderir ve gerektiğinde panelin kendisini bile geri yüklersin.

## Veritabanı oluşturmak

1. Projenin sayfasında **Veritabanı ekle**'ye bas.
2. **Motor** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis), **Sürüm** ve **Sunucu** seç.
3. **Dışarıya açık port** alanını boş bırak (önerilen): veritabanına yalnız aynı sunucudaki uygulamalar ulaşır.
4. **Oluştur**. Kullanıcı adı ve güçlü bir şifre otomatik üretilir.

Bağlantı bilgileri veritabanının **Bağlantı** sekmesindedir. **Uygulamalardan bağlan** altındaki adresi uygulamanın ortam değişkenlerine ekle, ör.:

```env
DATABASE_URL=postgresql://kullanici:sifre@xb-db-blog:5432/blog
```

Konteyner içinde `localhost` uygulamanın kendisidir; veritabanı adresi olarak `localhost` yazma. Dışarıdan bağlanman gerekirse **Ayarlar** sekmesinden bir port aç; bu port güvenlik duvarında da açılır.

## Otomatik yedekleme

Veritabanının **Yedekler** sekmesinde **Otomatik yedekleme**'yi aç, kaç saatte bir alınacağını ve kaç yedek saklanacağını gir, **Planı kaydet**'e bas. **Şimdi yedekle** ile istediğin an yedek alırsın. Her yedeği **İndir**, **Doğrula**, **Geri yükle** veya **Sil** ile yönetebilirsin.

Geri yükleme veritabanındaki mevcut verileri yedektekilerle değiştirir; önce şimdiki halin yedeğini al.

Tüm veritabanı ve klasör yedeklerinin durumunu **Yedekler** sayfasında topluca görürsün.

## Uzak depolama (S3)

Sunucu tamamen giderse yedekler de gitmesin diye **Ayarlar > Yedekleme > Uzak depolama** bölümünde **Yedekleri uzak depolamaya da yükle**'yi aç. AWS S3, Cloudflare R2, Backblaze B2 ve MinIO desteklenir. Adres (endpoint), Bucket, Access key, Secret key, Bölge (R2 için `auto`) ve isteğe bağlı Klasör (önek) gir; **Bağlantıyı dene** yazma iznini kontrol eder.

## Yedek doğrulama

Yedeğin gerçekten açılıp açılmadığını bilmek için **Yedekleri doğrula** alanına bir sıklık (saat) gir. Otomatik yedeklerden biri düzenli olarak ağsız, geçici bir veritabanına geri yüklenip denenir ve yedeğin yanında "doğrulandı" yazar. 0 bu özelliği kapatır. Doğrulama yalnız veritabanı yedeklerini kapsar; volume ve panel yedekleri doğrulanmaz. Tek bir yedeği elle denemek için **Doğrula**'ya bas.

## Kalıcı klasör yedekleri

Kalıcı depolama klasörü (volume) olan uygulamaların **Genel** sekmesinde **Kalıcı klasör yedekleri** kartı bulunur. Burada da otomatik yedekleme planı kurar, **Şimdi yedekle** ile yedek alır, **Geri yükle** ile klasörü yedekten döndürürsün (uygulama birkaç saniye durdurulur). Yedekler uzak depolama açıksa oraya da yüklenir. Veritabanı dosyası içeren klasörler için veritabanı yedeğini tercih et.

## Panel yedeği

Panelin kendi verisi (sunucular, uygulamalar, ortam değişkenleri, kullanıcılar) ve şifreleme anahtarı şifreli olarak yedeklenir.

1. **Ayarlar > Yedekleme > Panel yedeği** bölümünde en az 12 karakterlik bir **Yedek şifresi** belirle. Bu şifreyi kaybedersen yedek açılamaz; bir yere not et.
2. Sıklığı ve saklanacak yedek sayısını gir (varsayılan: 24 saatte bir, son 7 yedek).
3. **Şimdi yedekle** ile ilk yedeği al; yedeği **İndir** ile bilgisayarına da kaydedebilirsin.

### Yeni sunucuda geri yükleme

Sunucu giderse yeni bir sunucuya Xudbin'i kur, yedek dosyasını sunucuya kopyala ve:

```bash
sudo xudbin restore /root/xudbin-panel-....xbk
```

Yedek uzak depolamadaysa doğrudan oradan da alabilirsin:

```bash
sudo xudbin restore s3://bucket/anahtar --endpoint https://... --access-key ... --secret-key ... --region auto
```

Yedek şifresi sorulur, panel yedekten yeniden başlar. Ardından uygulamaları yeniden deploy et ve veritabanlarını yedeklerinden geri yükle.

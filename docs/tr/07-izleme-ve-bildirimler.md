# İzleme ve bildirimler

Sitelerinin ayakta olup olmadığını dakikada bir denetler, sorun olduğunda e-posta, Discord, Telegram, Slack veya webhook ile haber alır ve çerezsiz trafik analitiğiyle ziyaretçilerini izlersin.

## Erişilebilirlik izleme

Alan adı olan ve çalışan her web uygulaması dakikada bir, gerçek alan adıyla dışarıdan denenir. Art arda iki denemede yanıt alınamazsa "site çöktü", düzelince kesinti süresiyle birlikte "yeniden çalışıyor" bildirimi gider.

- **İzleme** sayfası tüm siteleri, son 24 saati saat saat, son 7 günün erişilebilirlik oranını, ortalama yanıt süresini, kesintileri ve sunucu kaynaklarını gösterir.
- Uygulamanın **Genel** sekmesindeki **Erişilebilirlik** kartında son 24 saat / 30 gün oranı ve kesinti geçmişi bulunur.
- İzlemeyi bir uygulama için kapatmak: uygulamanın **Ayarlar** sekmesinde **Erişilebilirlik izleme**.
- Tümüyle kapatmak: **Ayarlar > Panel** sekmesinde **Erişilebilirlik izleme**.

Uygulama ayarlarındaki **Sağlık kontrolü yolu** (ör. `/health`) verilirse hem deploy kontrolünde hem izlemede bu yol kullanılır.

## Bildirim kanalları

**Ayarlar > Bildirimler** sekmesinde **Kanal ekle**'ye bas ve **Tür** seç:

| Tür | Gerekenler |
|---|---|
| **E-posta** | SMTP sunucusu (ör. `smtp.gmail.com`), port (587 veya 465), kullanıcı adı, şifre (Gmail'de uygulama şifresi), gönderen ve virgülle ayrılmış alıcılar |
| **Discord** | Webhook adresi (Kanal ayarları > Entegrasyonlar > Webhook'lar) |
| **Telegram** | @BotFather'dan alınan bot token ve Chat ID |
| **Slack** | Slack Incoming Webhook adresi |
| **Webhook** | Bir adres; olaylar JSON POST isteği olarak gönderilir |

**Hangi olaylarda** bölümünde kanalın hangi olayları alacağını seç. **Test gönder** ile ayarları kaydetmeden önce dene, sonra **Ekle**.

## Olaylar

- Site çöktü / Site yeniden çalışıyor
- Deploy başarılı / Deploy başarısız
- İmajda kritik güvenlik açığı
- HTTPS sertifikası bitmek üzere
- Sunucuda disk veya bellek doluyor
- Sunucuya ulaşılamıyor
- Zamanlanmış görev başarısız
- Saldırgan IP banlandı
- Yedekleme başarısız

## Trafik analitiği

**Analitik** sayfası Google Analytics benzeri site istatistikleri sunar, ama çerez kullanmaz ve sitene kod eklemen gerekmez: veriler Caddy erişim loglarından, panelin kendi sunucusunda hesaplanır.

- Ziyaretçi, sayfa görüntüleme, hemen çıkma oranı, ortalama ziyaret süresi, bant genişliği ve şu an sitede olanlar
- Sayfalar, giriş sayfaları, yönlendirenler ve UTM kampanyaları
- Ülkeler, cihazlar, tarayıcılar ve işletim sistemleri
- 4xx/5xx hata sayıları; bot istekleri sayılmaz

Üstten site ve zaman aralığı seçersin. Gün sınırları **Ayarlar > Panel**'deki **Saat dilimi**'ne göredir.

Veriler yalnız senin sunucunda tutulur: saldırı kayıtları 30 gün, analitik özetleri 400 gün saklanır; ziyaretçi sayımı için IP'ler günlük değişen bir anahtarla tek yönlü özetlenir. Bu verilerin sorumlusu (KVKK/GDPR) paneli kuran kişidir. Panel hiçbir yere telemetri göndermez.

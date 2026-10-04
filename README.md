# MobilMotor

Bu bilgisayarda çalışan bir Android kontrol paneli. USB ile bağlı telefonları ve tabletleri, bir de Android emülatörlerini aynı anda tek ekrandan yönetir.

## Başka bir bilgisayara kurma

`build\cikti\MobilMotor-Kurulum.exe` dosyasını (yaklaşık 48 MB) karşı bilgisayara kopyalayıp çalıştır. Kurulum ekranı üç adımdan oluşur:

1. **Kurulacaklar:** MobilMotor, Node.js çalışma ortamı, Android adb ve scrcpy, boyutlarıyla birlikte listelenir.
2. **Bilgisayarı kontrol et:** Windows sürümü, disk, RAM, donanım sanallaştırma, mevcut Android SDK, tarayıcı ve önceki kurulum kontrol edilir. Eksikler yeşil, sarı ya da kırmızı gösterilir; yanlarında nasıl düzeltileceği yazar.
3. **Onaylıyorum, kur:** Yönetici izni istemez. Kullanıcı klasörüne kurar. Kısayolları oluşturur ve Denetim Masası'na "Kaldır" kaydı ekler.

Karşı makinede Node.js ya da Android Studio kurulu olması gerekmez. Emülatör bileşenleri (yaklaşık 2,1 GB) ilk kez gerektiğinde panelden **İndir ve kur** ile alınır. Dosyalar yalnızca `dl.google.com` adresinden iner ve SHA-1 ile doğrulanır.

İnternetten indirilen imzasız bir exe olduğu için Windows SmartScreen bir uyarı gösterebilir: **Ek bilgi › Yine de çalıştır**. Dosyanın bütünlüğünü `MobilMotor-Kurulum.sha256.txt` ile karşılaştırabilirsin.

Kurulum paketini yeniden üretmek için şunu çalıştır: `powershell -ExecutionPolicy Bypass -File build\paketle.ps1`. Senin `data` klasörün (anahtarlar, proxy şifreleri, hesap bilgisi) pakete **girmez**.

## Başlatma

`MobilMotor.exe` dosyasına çift tıkla. Konsol penceresi açılmaz; panel tarayıcıda açılır, sağ alttaki simge alanında MobilMotor simgesi belirir.

- **Simgeye çift tık:** paneli tekrar açar.
- **Simgeye sağ tık:** klasörler ve **Kapat**. Kapatırken açık sanal cihaz varsa onları da kapatıp kapatmayacağını sorar.
- `MobilMotor.exe --sessiz`: tarayıcı ve bildirim açmadan başlar.
- MobilMotor kapansa ya da yeniden başlasa bile açık emülatörler çalışmaya devam eder; panel yeniden bağlanır.

Telefonu bağlamak için telefonda: **Ayarlar › Telefon hakkında › Yazılım bilgisi › Yapım numarası** satırına 7 kez dokun. Sonra **Geliştirici seçenekleri › USB hata ayıklama** ayarını aç, telefonu USB ile bağla ve çıkan izin penceresini onayla.

## Neler yapılabilir

| | |
|---|---|
| **Tezgâh** | Odaktaki cihaz canlı video olarak gelir (scrcpy + tarayıcıda donanımla çözme); dokunma, sürükleme ve kaydırma milisaniyeler içinde iletilir. Diğer cihazlar kaynak harcamamak için 20 saniyede bir yenilenen küçük resimlerdir. |
| **Ayna** | Odaktaki ekranda yaptığın hareket, işaretli tüm cihazlarda da yapılır. |
| **Sanal cihazlar** | Tek seferde birden çok telefon ya da tablet oluşturup başlatırsın. Hepsi Türkçe ve İstanbul saatiyle açılır; varsayılan olarak penceresiz çalışır. |
| **Google Play** | **Play Store girişini aç** ile bir şablon emülatör açılır ve kendi Gmail hesabınla giriş yaparsın. Şifre bu panelden geçmez, doğrudan Google'a gider. **Kaydet** dedikten sonra yeni emülatörler bu hesapla açılır. |
| **Opera / Play Store'dan kur** | Hesap şablonunu kaydederken Opera otomatik kurulur, şablondan açılan her emülatörde hazır gelir. Uygulama sekmesindeki **Play Store'dan kur** ile herhangi bir paketi seçili cihazlara kurarsın (Google hesabı açık olmalı). |
| **Büyüt** | Kartlar aynı boyuttadır. Bir ekrana çift tıkla ya da **⤢ Büyüt**'e bas: büyür ve net kaliteye geçer. Küçültmek için çerçeveye/isme çift tıkla ya da **⤡ Küçült**. |
| **Cihazı çıkar** | Raftaki USB/Wi-Fi cihazın satırında **⏏ çıkar**: cihaz listeden kalkar, canlı görüntüsü kapanır, panel ona hiçbir komut göndermez; kabloyu güvenle çekebilirsin. "Çıkarılan cihazlar" altından **geri ekle** ile döner. Panel yeniden başlasa da çıkarılmış kalır. Emülatörler bunun yerine **Kapat** ile kapatılır. |
| **Motoru sıfırla** | Sol barın altında. "Emin misiniz?" penceresi silinecekleri listeler; onay kutusu işaretlenmeden çalışmaz. Sanal cihazlar, makrolar, kayıtlar, ağ çıkışları, hesap şablonu ve ayarlar silinir; Android SDK ve telefon verileri silinmez. |
| **Ağ çıkışları** | VPN sağlayıcının HTTP proxy uçlarını eklersin. Her emülatör seçtiğin çıkıştan ya da "sırayla dağıt" ile listedeki çıkışlardan birinden bağlanır; saat dilimi isteğe bağlıdır. Şifreler yalnızca bu bilgisayarda saklanır ve arayüzde gizlenir. |
| **Kontrol** | Tuşlar, metin, adres açma, çoklu cihaza APK kurma, dosya gönderme, ekran görüntüsü, scrcpy penceresi. |
| **Uygulama / Makro / Logcat / Kabuk** | Uygulama yönetimi; oransal koordinatlarla kaydedilen ve her ekran boyutunda çalışan makrolar; canlı günlük; `adb shell`. |

**Proxy notları:** Emülatörün TCP trafiği proxy'den çıkar. DNS sorguları ve UDP trafiği (QUIC gibi) bu bilgisayarın ağından gider. Gerçek telefonlara proxy uygulanmaz.

## Kaynak kullanımı

Hedef: **açık olan her sanal makine hep çalışsın**, ama bilgisayar boğulmasın.

- Emülatörler **sırayla** açılır (biri açılıp oturunca sıradaki), arka plandakiler ve açılanlar **düşük öncelikte** çalışır.
- **Hafif mod** (varsayılan açık): animasyon kapalı, pil tasarrufu, iç ekran 2/3 çözünürlük, gereksiz uygulamalar kapalı, ağır uygulamalar yalnızca arka planda kısıtlı (açık uygulama asla kapatılmaz).
- Ekran yenileme 30 Hz. Telefon 4 GB, tablet 6 GB RAM (az RAM'de bellek sıkıştırması işlemciyi yoruyordu).
- Otomatik uyku ve derin uyku **varsayılan kapalı**; açarsan kullanılmayan emülatör dondurulur (uyurken arkada iş yapmaz). "Bu emülatörü uyutma" ile tek tek muaf tutulabilir.

- Emülatör başına 2 çekirdek ve 2 GB RAM (tablette 3 GB) kullanılır. Ekran çizimini ekran kartı yapar (`-gpu host`). Penceresiz modda ses emülasyonu kapalıdır.
- Canlı video yalnızca odaktaki cihazda açıktır: emülatörde 15 fps ve 960 piksel, telefonda 30 fps ve 1280 piksel. Panel arka plana alınırsa ya da "Akış: Durdur" seçilirse cihazdaki kodlayıcı 5 saniye içinde kapanır.

## Güvenlik modeli

- Panel yalnızca `127.0.0.1` üzerinden dinler. Ağdaki başka hiçbir cihaz panele erişemez.
- 256 bitlik oturum anahtarı `HttpOnly` ve `SameSite=Strict` bir çerezde tutulur. Anahtar 7 günde bir yenilenir; yeniden başlatmada açık panel kopmaz.
- Host, Origin, Sec-Fetch-Site ve özel başlık denetimi yapılır. Bu, DNS-rebinding'e ve CSRF'ye karşı korur. Sıkı bir CSP uygulanır; arayüz hiçbir dış kaynak yüklemez.
- Sunucu kendi başına internete bağlanmaz. Tek istisna, senin başlattığın emülatör bileşeni indirmesidir (`dl.google.com`, SHA-1 doğrulamalı). Dış npm paketi yoktur.
- Komutlar kabuk (`cmd.exe`) üzerinden geçmez; her girdi doğrulanır. Sadece bağlı ve yetkili cihazlara komut gider.
- Emülatörler telemetri ve çökme raporu kapalı açılır. Kamera ve mikrofon sanal cihaza bağlanmaz. Pano senkronu kapalıdır.
- İşlem kaydı `data/logs` altında, yalnızca bu bilgisayarda tutulur. Yazılan metinlerin ve proxy şifrelerinin içeriği kaydedilmez.

## Testler

```
node qa/test.mjs --emu emulator-5554 --sure 20
```

Bu komut pentest, stabilite, dokunma ve kaynak ölçümü yapar. Dokunma testleri yalnızca `--emu` ile verilen emülatörde çalışır; gerçek telefona dokunulmaz. Rapor `data/logs/test-*.json` dosyasına yazılır. Test emülatörünü hazırlamak için: `node qa/emu-hazirla.mjs KTest`.

scrcpy v4.1 resmî sürümden indirildi; SHA-256 ve geliştiricinin GPG imzası doğrulandı. Türkçe yardımcısının (`tools/dil`) kaynak kodu da yanında duruyor.

## Kaynaktan çalıştırma

Depoda üçüncü taraf ikilileri yok. Çalıştırmadan önce [scrcpy v4.1](https://github.com/Genymobile/scrcpy/releases) Windows sürümünü (adb dahil) `tools\scrcpy` klasörüne aç, ardından `launcher\derle.cmd` ile `MobilMotor.exe`'yi derle ya da doğrudan `node server.js` çalıştır (Node.js 24).

## Lisans

MIT. Ayrıntı için `LICENSE` dosyasına bak.

# officev2

**PDF, fotoğraf, dosya ve cihaz üstü yapay zeka için yerel öncelikli masaüstü araç kutusu.**
Her şey kendi bilgisayarınızda çalışır. Hesap yok, bulut yok, veri toplama yok.

[English](README.md) · [Mimari](ARCHITECTURE.md) · [Tasarım sistemi](DESIGN.md)

officev2, insanların normalde bir düzine web sitesi ve uygulamaya dağıttığı araçları tek pencerede toplar: gerçek bir PDF düzenleyici, fotoğraf düzenleyici, toplu dosya araçları, çevrimdışı çalışan ses yazıya dökme ve belge arama. Dosyalarınız makineden çıkmaz ve hiçbir şey orijinallerinizi bozmaz: her araç bir **kopya** yazar, her dosya işlemi **geri alınabilir**.

![PDF düzenleyici](docs/screenshots/pdf-editor.png)

<table>
<tr>
<td><img src="docs/screenshots/photo-editor.png" alt="Fotoğraf düzenleyici"></td>
<td><img src="docs/screenshots/redact.png" alt="Karartma incelemesi"></td>
</tr>
<tr>
<td><img src="docs/screenshots/organize-pages.png" alt="Sayfa yöneticisi"></td>
<td><img src="docs/screenshots/photo-filters.png" alt="Fotoğraf filtreleri"></td>
</tr>
</table>

## Neler yapabilir

### PDF

| Araç | Yapabilecekleriniz |
|---|---|
| **PDF düzenleyici** | Yazı ekleme (yüklü her yazı tipi, Türkçe harfler dahil), damgalar (ONAYLANDI, TASLAK vb.), görsel ve imza ekleme. Vurgulama, altını çizme, üstünü çizme. Kutu, oval, çizgi, ok ve serbest çizim. Not bırakma, bağlantı ekleme. İçeriği silme veya kalıcı olarak karartma. Yaptığınız her değişikliği seçme, sürükleme, düzenleme ve silme. Geri al / yinele. Sayfa küçük resimleri, değiştirdiğiniz sayfaları işaretler. |
| **Sayfaları düzenle** | Her sayfa bir karo: sürükleyerek sırala, döndür, çoğalt, sil. Sade dille yazılmış bir liste tam olarak neyin değişeceğini söyler. |
| **Birleştir, Sayfa ayıkla** | Sayfa sayfa sonuç haritasıyla birleştirme; küçük resim ızgarasından sayfa seçme veya aralık yazma. |
| **Ekle ve böl** | Boş sayfa veya başka bir PDF'ten sayfa ekleme; her N sayfada, belirli sayfalardan önce veya yer imlerinde bölme. |
| **Sayfa numaraları** | Üstbilgi, altbilgi, sayfa numarası ve Bates numarası (`{n}`, `{n:04}`, `{total}`, `{file}`, `{date}`), canlı önizleme. |
| **Sayfa boyutu** | Kenar boşluklarını kırpma (elle veya otomatik), sayfaları A3/A4/A5/Letter/Legal kâğıda sığdırma. |
| **Karart** | Ara, her eşleşmeyi kendi sayfasında incele, kendi kutularınızı ekleyin. Altındaki metin dosyadan silinir. |
| **Filigran** | Her sayfanın canlı önizlemesiyle metin veya görsel filigran. |
| **Formlar** | Form alanlarını doldurma, isteğe bağlı düzleştirme. |
| **Özellikler** | Başlık, yazar, anahtar kelimeler ve yer imi ana hattını düzenleme. |
| **İçerik çıkar** | Sayfaları PNG/JPG olarak, PDF içindeki resimleri, metni (txt, Markdown, JSON), resimlerden PDF. |
| **Koru, Dönüştür, OCR** | AES-256 şifreleme ve kilit açma (parolayı bilmelisiniz), PDF→Word, Office→PDF, sıkıştırma, metadata temizleyici, aranabilir PDF için OCR, düzleştirme, gri tonlama. |

### Fotoğraf ve video

| Araç | Yapabilecekleriniz |
|---|---|
| **Fotoğraf düzenleyici** | Oranlı kırpma, döndürme, düzleştirme, çevirme, yeniden boyutlandırma. Pozlama, parlaklık, kontrast, parlak/koyu tonlar, sıcaklık, renk tonu, doygunluk, canlılık, renk dönüşü, keskinlik, otomatik iyileştirme. Canlı küçük resimli 17 filtre, vinyet, film greni. **Seçtiğiniz bir alanı** bulanıklaştırma, mozaikleme veya tilt-shift (yüz ya da plaka gizleme) ya da konu dışındaki her şeyi bulanıklaştırma. Çerçeveli/gölgeli yazı, şekil, ok, kalem ve fosforlu kalem, logo ekleme, kenarlık, yuvarlak köşe, arka plan silme. Her değişiklik kaldırılabilen bir adımdır. Hazır ayarlar, basılı tutup karşılaştırma, geri al / yinele. |
| **Toplu işlem** | Aynı düzenlemeleri bir klasördeki tüm fotoğraflara uygulama; toplu dönüştürme, sıkıştırma ve metadata silme. |
| **Video, Arka plan silme, Büyütme** | ffmpeg dönüştürme, arka plan silme, yapay zeka ile büyütme. |

### Dosyalar, yapay zeka ve günlük araçlar

- **Dosyalar:** önizlemeli toplu yeniden adlandırma; geçici dosya, geliştirici çöpü (`node_modules`, önbellekler) ve yinelenen dosya temizliği; disk haritası; yeni indirmeleri ayıklayan **Otopilot** kuralları. Temizlik hiçbir şeyi silmez: dosyaları geri yükleyebileceğiniz bir karantina klasörüne taşır.
- **Zeka:** ses yazıya dökme (Whisper), belgelerinizle sohbet ve anlamsal arama (yerel gömme modeli; Ollama kuruluysa yazılı yanıt), model yöneticisi.
- **Masa:** metin ve görsel için pano geçmişi (parola yöneticisi girdileri asla kaydedilmez), renk damlalığı, bir görseli pencerelerin üstüne iğneleme, ekranda her yerden metin kopyalama.
- **Kasa:** kurtarma anahtarlı şifreli depo (Argon2id + AES-256-GCM).
- **Araçlar:** Dev Lab (JWT, JSON, Base64, SQL, zaman damgası), PDF'ten kopyalanan metin için temiz yapıştır, karalama defteri.
- **Her yerde:** komut paleti (`Ctrl+K`), her işlem için geri alma özellikli Etkinlik günlüğü, uzun işler için ilerleme çubuğu ve iptal.

## Dosyalarınızı nasıl korur

- **Orijinaller asla değiştirilmez.** Araçlar kopya kaydeder ve var olan bir dosyanın üzerine yazmayı reddeder.
- **Her şey geri alınabilir.** Oluşturulan dosyalar çöp klasörüne gider, taşınan veya yeniden adlandırılan dosyalar eski yerine döner, kaldırılanlar karantinada bekler.
- **Motor uygulamaya özeldir.** Python motoru yalnızca `127.0.0.1` üzerinde rastgele bir portta dinler, oturum başına token ister, yabancı tarayıcı kaynaklarını reddeder ve yalnızca kullanıcı profilinizdeki klasörlere dokunur.
- **Arkanızdan hiçbir şey indirilmez.** Modeller ilk kullanımda iner; üçüncü taraf programlar (büyütücü) otomatik indirilmez.

## Gereksinimler

- Windows 10/11 (birincil ve tek test edilen platform)
- Python 3.12, Node.js 22, Rust (kararlı sürüm, MSVC derleme araçları) ve WebView2
- İsteğe bağlı: ffmpeg (video, ses), LibreOffice (Office→PDF), Ollama (belge sohbetinde yazılı yanıt)

## Çalıştırma

```powershell
git clone https://github.com/beyuphan/officev2.git
cd officev2

# 1. arka uç
cd backend
python -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..

# 2. uygulama (Python motorunu kendisi başlatır)
cd frontend
npm install
npm run tauri dev
```

Masaüstü kabuğu motoru `backend/venv` içinde bulur. Başka yere işaret etmek için `LOCALFLOW_BACKEND_DIR` veya `LOCALFLOW_PYTHON` ayarlayın.

| Değişken | Amacı |
|---|---|
| `LOCALFLOW_DATA_DIR` | Ayarların, geçmişin, modellerin ve kasanın yeri (varsayılan `%APPDATA%\officev2`) |
| `LOCALFLOW_ALLOWED_ROOTS` | Motorun okuyup yazabileceği klasörler (varsayılan: kullanıcı profiliniz) |
| `LOCALFLOW_TOKEN` | Kabuk tarafından ayarlanır; bağımsız motor için `LOCALFLOW_DEV_TOKEN` kullanın |

Geliştirme için bağımsız motor:

```powershell
cd backend
$env:LOCALFLOW_DEV_TOKEN = "dev"
.\venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

## Testler

```powershell
cd backend;  .\venv\Scripts\python.exe -m pytest -m "not network"   # motor: 137 test (model indirenlerle 140)
cd frontend; npm test                                              # mantık: 51 test
cd frontend; npm run test:e2e                                      # gerçek motor + gerçek arayüz (Edge): 52 kontrol
cd frontend\src-tauri; cargo test --lib                            # pano deposu: 9 test
```

Uçtan uca paket gerçek arayüzü sürer (dosya pencereleri taklit edilir), gerçek dosyalar kaydeder ve sonucu kontrol etmek için onları yeniden açar: eklenen metin aranabilir, karartılan metin gitmiştir, döndürülmüş sayfada numara dik durur, kırpılan fotoğraf doğru boyuttadır.

## Proje yapısı

```
backend/    Python motoru (FastAPI): PDF, fotoğraf, medya, yapay zeka, dosyalar, kasa, işler, geçmiş
frontend/   Tauri 2 kabuğu (Rust) + React/TypeScript arayüzü, uçtan uca testler e2e/ içinde
docs/       Ekran görüntüleri
```

Parçaların nasıl birleştiği için [ARCHITECTURE.md](ARCHITECTURE.md) dosyasına bakın.

## Durum ve sınırlar

- Şimdilik yalnızca Windows. Pano, renk damlalığı, ekran yakalama ve Windows OCR Windows'a özeldir.
- Kaynaktan çalışır: Python motoru henüz bir yükleyiciye paketlenmedi.
- PDF düzenleyici içerik **ekler**; bir PDF'in mevcut metnini yeniden yazmaz. Görsel imza çalışır; kriptografik dijital imza yoktur.
- OCR, dil paketi kuruluysa Windows OCR'ı kullanır (Türkçede doğru), yoksa Türkçe aksanlı harfleri düşüren paketli motora döner.
- Yapay zeka büyütücü, Modeller ekranından açıkça kurduğunuz üçüncü taraf bir programdır; henüz sağlama toplamıyla sabitlenmedi.
- Pano geçmişi yerel bir veritabanında düz veri olarak saklanır (henüz şifreli değil).
- Ekran metni yakalama, ekrana iğneleme ve renk damlalığı birim testleri ve taklit edilmiş komutlarla doğrulandı; gerçek overlay pencereleri sürülerek test edilmedi.
- Henüz yok: LocalDrop (yerel ağda dosya gönderme), tek tıkla yerel proje açma, macOS ve Linux.

## Yol haritası

1. Motoru içeren yükleyici
2. LocalDrop
3. Şifreli pano geçmişi
4. Ekran araçları için gerçek pencere testleri
5. Fotoğraflarda anlamsal arama

## Lisans

Henüz lisans seçilmedi; şimdilik tüm haklar saklıdır.

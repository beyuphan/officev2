🌊 officev2

İleri Düzey Kullanıcılar (Power-User) İçin Gelişmiş Masaüstü Üretkenlik, Yerel Yapay Zeka ve Dosya Asistanı.

officev2, Tauri ve Python (FastAPI) ile inşa edilmiş modüler bir masaüstü uygulamasıdır. Çevrimdışı yapay zeka yeteneklerinden derin sistem otomasyonuna, geliştirici araçlarından PDF manipülasyonuna kadar güçlü araçları bir araya getirir. Tüm işlemler bulut API'lerine bağlı kalmadan doğrudan kendi cihazınızda (lokal) çalışır. Birincil hedef platform Windows'tur; bkz. "Platform Desteği" bölümü.

Read this in English: [README.md](README.md)

## Proje durumu

Gerçekleştirilmiş ve testlerle doğrulanmış (86 backend, 27 arayüz birim, 31 uçtan uca kontrol, 9 Rust testi): PDF (birleştirme, ayıklama, düzenleme, şifreleme/kilit açma, filigran, karartma, sıkıştırma, metadata temizleme, PDF→Word, Office→PDF, OCR), görsel ve video dönüştürme, arka plan silme, ses deşifresi, belge indeksi ve arama (Ollama varsa yazılı yanıt), Kasa, toplu yeniden adlandırma, geçici/geliştirici çöpü/yinelenen dosya temizliği (karantinalı), disk haritası, Otopilot kuralları, geri alma günlüğü, iş ilerlemesi ve iptali, Model Yöneticisi, komut paleti, pano geçmişi (metin ve görsel), tüm PDF araçlarında sayfa önizlemesi, renk damlalığı, ekrana iğneleme, ekrandan metin yakalama, Dev Lab, Clean Paste, Karalama Defteri.

Henüz yok: Upscaler üçüncü taraf bir programın Modeller ekranından elle kurulmasını ister (henüz sağlama toplamı sabitlenmedi); LocalDrop ve Tünel Açıcı; diskte pano şifrelemesi; Python sidecar'ın üretim paketlemesi (şimdilik yalnızca geliştirme düzeni); macOS ve Linux desteği; Ekran İğnesi, renk damlalığı ve metin yakalama gerçek overlay pencereleri sürülerek değil, taklit edilmiş komutlar ve Rust birim testleriyle doğrulandı.

✨ Özellikler

1. 📄 Kapsamlı PDF ve Doküman Stüdyosu

Çift Yönlü Format Dönüştürücü: PDF dosyalarını düzenlenebilir PPTX, DOCX, XLSX formatlarına, ofis dosyalarını ise PDF'e dönüştürür. Karmaşık sayfa düzenlerinde sadakat "elinden gelenin en iyisi" düzeyindedir (bkz. "Bağımlılıklar ve Dürüst Sınırlar" bölümü).

Akıllı OCR (Görüntüden Metne): Taranmış veya metni kopyalanamayan belgelerdeki yazıları seçilebilir metinlere dönüştürür.

PDF Parçalama ve Birleştirme: Büyük PDF'lerden sayfa ayıklama veya birden fazla dosyayı sürükle-bırak ile birleştirme.

Şifreleme ve Kilit Açma: Belgelere AES parolası koyma veya parolasını bildiğiniz PDF'lerdeki kısıtlamaları (yazdırma/kopyalama engeli) kaldırma.

Filigran ve İmza Enjeksiyonu: Sayfalara saydam logolar, "GİZLİ" damgaları veya spesifik koordinatlara dijital imza ekleme. İçinde Hızlı Varlık (Asset) Kütüphanesi bulunur: sık kullanılan logolar, imzalar ve ikonlar için her an el altında duran minik çekmece.

2. 🎨 Medya ve Görsel İşleme Merkezi

Çevrimdışı Arkaplan Silici: İnternete ihtiyaç duymadan, lokal AI ile fotoğrafların arkaplanını şeffaf (PNG) yapma.

Çevrimdışı Çözünürlük Yükseltici (AI Upscaler): Düşük çözünürlüklü fotoğrafların kalitesini yerel yapay zeka modelleriyle (örn. Real-ESRGAN) 4 katına çıkarma.

Toplu Medya Sıkıştırma ve Çevirici: Klasörler dolusu görsel/videoyu sıkıştırma ve WebP, MP4 gibi formatlara toplu dönüştürme.

Ekrandan Anında Metin Yakalama (Live Text): Ekrandaki videolardan veya kilitli sitelerden alan seçip yazıyı anında kopyalama.

3. 🧠 Yerel Yapay Zeka ve Gizlilik

Çevrimdışı Ses Deşifresi (Local Whisper): Toplantı seslerini buluta göndermeden cihaz gücüyle yazıya (SRT/TXT) dökme.

Gizlilik Odaklı Belgelerle Sohbet (Local RAG): Özel sözleşmelerinizi yerel vektör indeksine gömüp yerel bir LLM ile internet kapalıyken bile belgelerinizle sohbet etme.

Kriptolu Kasa (Local Vault): Sadece ana parolayla görünür hale gelen şifreli özel sanal klasör. Argon2id anahtar türetme ve AES-256-GCM kullanır; zorunlu bir kurtarma anahtarı üretilir (parola ve kurtarma anahtarı birlikte kaybolursa veri geri getirilemez).

4. ⚙️ Akıllı Dosya ve Sistem Otomasyonu

İndirilenler Otopilotu: İndirilenler klasörünü dinleyip dosyaları uzantısına veya içeriğine göre otomatik taşıma. Genel Kural Motoru üzerine kurulacaktır (bkz. Planlanan Çekirdek Özellikler).

Toplu Yeniden Adlandırma: Yüzlerce dosyanın adını belirli kurallara (Regex) göre canlı önizlemeyle saniyeler içinde değiştirme.

Sessiz Sistem Temizlikçisi: Temp dosyalarını, uygulama önbelleklerini ve çöp kutusunu arka planda programlı olarak temizleme.

Geliştirici Çöpçüsü (Dev-Junk Sweeper): Unutulmuş node_modules, __pycache__ klasörlerini veya askıda kalan Docker imajlarını bularak GB'larca alanı geri kazanma.

Disk Görselleştirici: Diskteki doluluğu etkileşimli bir ağaç haritası (Treemap) ile bloklar halinde gösterme.

🛡️ Silme/taşıma yapan tüm özellikler için güvenlik kuralları (Temizlikçi, Çöpçü, Otopilot, Yeniden Adlandırma):
- İşlemden önce zorunlu önizleme (dry-run).
- Kalıcı silme yerine Çöp Kutusu / karantina klasörüne taşıma.
- Özellik bazında hariç tutma listeleri.
- Her işlem Geri Alma Günlüğü'ne yazılır, böylece geri döndürülebilir.

5. 🛠️ Geliştirici & Tasarım Araçları

Sınırsız Pano (Clipboard) Yöneticisi: Kopyalanan son 100 veriyi (metin, kod, görsel) arayüzden tek tıkla tekrar yapıştırma. İçerir:
- Akıllı Önizleme: HEX/RGB kodlarının yanında renk bloğu, URL'lerin yanında site adı (ikon indirilmez, bu yüzden bir bağlantıyı kopyalamak o siteyle iletişim kurmaz).
- Clean Paste: PDF'ten kopyalanan bozuk, alt satıra geçmiş metinleri tek parça paragrafa dönüştürme.
- Karalama Defteri: Kaydetme uyarısı vermeyen, anlık yapıştırmalar için uçucu not alanı.
- Gizlilik: Parola yöneticilerinin işaretlediği içerik (Windows `ExcludeClipboardContentFromMonitorProcessing` formatı) asla kaydedilmez. Geçmiş şimdilik yerel bir SQLite dosyasında düz metin olarak durur; şifreleme planlı. Yalnızca metin; görseller henüz yakalanmıyor.

Ekran İçi Renk Dedektifi: Ekrandaki herhangi bir pikselin HEX/RGB kodunu kopyalayan damlalık.

Ekran İğnesi (Pin-to-Screen): Referans görselleri, faturaları veya taslakları ekranın köşesinde şeffaf, her zaman üstte kalan mini pencere olarak iğneleme.

6. 🧭 Planlanan Çekirdek Özellikler

Bunlar henüz geliştirilmedi; geri kalan her şeyi birbirine bağladıkları için tasarım öncelikleridir.

Komut Paleti: Tüm araçlara tek yerden ulaşan global başlatıcı (örn. `Ctrl+Space`).

Kural Motoru: Genel bir `tetikleyici → koşul → eylem` sistemi (örn. "İndirilenler'e yeni PDF geldi → OCR yap → Belgeler'e taşı"). İndirilenler Otopilotu bu motorun hazır bir şablonu olur.

Ortak İndeks Servisi: Local RAG ve Semantik Dosya Arama'nın birlikte kullandığı tek bir dosya izleyici + embedding + vektör deposu.

Model Yöneticisi: AI modellerinin (Whisper, Real-ESRGAN, rembg, LLM/embedding) indirilmesi, boyut takibi, GPU tespiti ve silinmesi. Temel kurulum boyutunu küçük tutar.

Geri Al / İşlem Geçmişi: Tüm dosya işlemleri için birleşik geçmiş.

Explorer Sağ-Tık Menüsü: Sağ tık → "officev2 ile Sıkıştır / OCR yap / Birleştir".

Ek PDF ve gizlilik araçları: PDF sıkıştırma, sayfa sıralama/döndürme, gerçek içerik karartma (redaction), EXIF/PDF metadata temizleyici.

Yinelenen Dosya Bulucu: Hash tabanlı, Disk Görselleştirici ve Temizlikçi ile entegre.

Yerel çeviri ve özetleme: Kurulu yerel modeller kullanılarak.

7. 🧪 Deneysel / Opsiyonel

Bu özelliklerin ağ veya güvenlik etkileri vardır; yalnızca kullanıcı açıkça etkinleştirirse çalışır.

LocalDrop (Ağ İçi Dosya Fırlatıcı): Aynı Wi-Fi ağındaki cihazlara internet harcamadan geçici yerel sunucuyla büyük dosya transferi. Cihaz eşleştirme/PIN ve TLS gerektirir. Özel protokol yerine mevcut açık bir protokolü (örn. LocalSend) benimseyebilir.

Tek Tıkla Tünel Açıcı: Lokal projeyi (localhost:3000) geçici bir public URL ile dış dünyaya açma. Üçüncü taraf bir relay (örn. cloudflared) gerektirir; bu yüzden "bulut yok" garantisinin açıkça dışındadır ve officev2'un kendi API'sini asla dışarı açamamalıdır.

🖥️ Platform Desteği

| Özellik alanı | Windows | macOS | Linux |
|---|---|---|---|
| PDF, Medya, Yerel AI, Kasa, Dosya otomasyonu | Birincil | Planlı | Planlı |
| Renk damlalığı, Ekran İğnesi, Live Text, Pano kancaları | Birincil | Planlı (işletim sistemine özel kod gerekir) | Planlı (X11/Wayland farkları) |
| Sistem Temizlikçisi (temp/çöp kutusu yolları) | Birincil | Planlı | Planlı |

📦 Bağımlılıklar ve Dürüst Sınırlar

- OCR: Windows'ta, OCR dil paketi kuruluysa yerleşik Windows OCR kullanılır (Türkçe ve aksanlı diğer dillerde doğrudur). Aksi halde paketlenmiş RapidOCR (ONNX) devreye girer; her yerde çevrimdışı çalışır ama Türkçe karakterleri düşürür (örn. `Çalışma` → `Calisma`).
- Office → PDF için LibreOffice (veya Windows'ta Microsoft Office) gerekir. PDF → DOCX/PPTX/XLSX karmaşık sayfa düzenlerinde kayıplıdır.
- Video sıkıştırma ve dönüştürme için ffmpeg gerekir (pakete dahil edilir).
- Yerel AI özellikleri model dosyaları için disk alanı ister ve GPU'dan faydalanır; modeller kurulumda değil, ilk kullanımda indirilir.

🏗️ Mimari ve Teknoloji

officev2, tamamen localhost üzerinde çalışan ayrık bir frontend-backend mimarisi kullanır. Sistem seviyesindeki işler Rust (Tauri) katmanında, ağır hesaplamalar ise ihtiyaç anında başlayan bir Python sidecar'ında yaşar. Ayrıntılar için bkz. [ARCHITECTURE.md](ARCHITECTURE.md).

Kabuk (Rust / Tauri): tray, global kısayollar, pano, ekran yakalama, dosya izleme, disk tarama, sidecar yönetimi, güncelleyici.

Ön Yüz (Arayüz): React (Vite), TailwindCSS, TypeScript. (Native hissiyatlı, minimalist, "Quiet Luxury" karanlık tema).

Arka Plan (Motor): Python, FastAPI, Uvicorn. `127.0.0.1` üzerinde rastgele bir porta bağlanır ve oturum başına token ile korunur.

Çekirdek Kütüphaneler: PyMuPDF, OpenCV / rembg, RapidOCR / pytesseract, faster-whisper, llama.cpp veya Ollama (yerel LLM).

Veri Tabanı: Ayarlar, kurallar, pano geçmişi, işler ve geri alma günlüğü için SQLite; Local RAG ve semantik arama için `sqlite-vec` (veya LanceDB) vektör indeksi.

🚀 Kurulum ve Geliştirme

# 1. Depoyu klonlayın
git clone https://github.com/beyuphan/officev2.git

# 2. Python Arka Ucunu kurun
cd officev2/backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
# Sadece geliştirme: sabit port ve sabit token. Üretimde Tauri rastgele port ve token seçer.
LOCALFLOW_DEV_TOKEN=dev uvicorn main:app --reload --host 127.0.0.1 --port 8000

# 3. Tauri Ön Yüzünü kurun
cd ../frontend
npm install
npm run tauri dev


🗺️ Yol Haritası (Roadmap)

[ ] Çekirdek: Komut Paleti, Kural Motoru, Job Manager, Model Yöneticisi, Geri Alma Günlüğü.

[ ] Semantik Dosya Arama: Dosya adından bağımsız, görsel ve doküman içeriğini anlayan yerel yapay zeka destekli arama (Ortak İndeks Servisi üzerine kurulur).

[ ] Çevrimdışı Dev-Lab: Hassas JWT'leri çözmek, JSON ve SQL formatlamak için internete ihtiyaç duymayan lokal araç kiti.

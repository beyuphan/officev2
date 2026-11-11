# Özellik durumu

Hedef: **kolay, hafif, hızlı**. Her özellik "yeni biri açıklama okumadan bulup kullanabilir mi?" sorusundan geçer. Ağır yapan şeyler isteğe bağlı eklentiye ya da hiç yapılmamaya gider.

İşaretler: `[x]` yapıldı ve testle doğrulandı, `[ ]` yapılmadı.

---

## Arayüz ve ilk kullanım

- [x] Açılışta "Ne yapmak istiyorsun?" ekranı: 8 sık iş + her aracın tek cümlelik açıklaması
- [x] PDF veya fotoğrafı pencereye bırakınca doğru editörde açılır
- [x] Türkçe / İngilizce arayüz, dil seçici araç listesinin altında, tarayıcı dilinden otomatik seçim
- [x] Alt durum çubuğu kaldırıldı
- [x] Video araçları arayüzden kaldırıldı (motor kodu duruyor, ileride geri gelecek)
- [x] Ağır bağımlılıklar isteğe bağlı: `requirements.txt` küçük çekirdek, geri kalanı **Eklentiler** ekranından kurulur (arka plan silme, konuşmayı yazıya çevirme, belgelerle sohbet, ek OCR motoru, PDF'ten Word'e, dijital imza)
- [x] Eklenti yokken özellik "şu eklentiyi kurun" der, çökmez
- [x] "Kapat" ve "Başkasını aç" kaydedilmemiş değişiklik varsa sorar; üstte "Henüz kaydedilmedi / Tüm değişiklikler kaydedildi" göstergesi (PDF ve foto)
- [x] Metin aracı ardışık yazı için açık kalır; tıkla = yeniden yaz, sürükle = taşı
- [x] Stil kopyala / yapıştır (Ctrl+Shift+C / V), PDF ve fotoğrafta
- [x] Özel damga yapma ve saklama; damgada `{date}`
- [x] Sayfa numarası, üst ve alt bilgi PDF editörünün içinde (sayfada canlı görünür, diğer düzenlemelerle birlikte kaydedilir)
- [x] Sistemdeki tüm yazı tipleri listelenir, kendi .ttf/.otf dosyanı ekleyebilirsin
- [x] Klasör eklerken içindeki dosyalar tek tek listelenir, istemediğini çıkarırsın; alt klasörler isteğe bağlı
- [x] Sol menü gruplara ayrıldı, gruplar açılıp kapanır; dil seçici TR / EN düğmesi
- [x] Silgi: eklediğiniz şeyleri tıklayarak veya sürükleyerek geri alır. Eski "Erase" → "Beyaz kapat", "Redact" → "Karart" ve ne yaptığı yazıyor
- [x] Fotoğraf: kırpma çerçevesi başka araca geçince kaybolmaz, otomatik uygulanır
- [x] Fotoğraf: yazı onaylanınca yarım saniye kaybolmaz (tarayıcı çizer, motor yetişince devralır)
- [x] Fotoğraf: yan paneldeki üst üste binme giderildi
- [x] Fotoğraf: çerçeve köşeleri ve fotoğraf köşeleri ayrı ayrı ayarlanır
- [ ] Gerçek Tauri penceresinde elle denenmedi: sürükle-bırak, ana ekran, yeni paneller. Tarayıcıda otomatik testlerle (e2e) ve birim testlerle doğrulandı

## PDF

- [x] Redaksiyon kalıpları: e-posta, TC kimlik, IBAN, telefon, kart (sağlama toplamı denetimli), özel regex; sayfada gözden geçirme
- [x] Tablo çıkarma (CSV, Excel açar), PDF → HTML, HTML / Markdown / metin → PDF
- [x] Boyuta göre bölme, hedef boyuta sıkıştırma ("en fazla 2 MB")
- [x] Tarama temizliği (düzeltme, kenar kırpma, beyazlatma, siyah-beyaz)
- [x] Toplu PDF işlemi + adlandırılmış adım setleri
- [x] Mevcut metni yeniden yazma ("Metni değiştir") ve sayfanın kendi metnini/resmini doğrudan seçip taşıma, silme, yeniden yazma, resmi boyutlandırma (editörün içinde)
- [x] Editörde sayfa araçları: silme, taşıma, döndürme, çoğaltma, boş sayfa, başka PDF'ten sayfa ekleme (çalışma kopyası üzerinde, orijinale dokunulmaz)
- [x] PDF açılınca sayfanın kendi yazısı ve resmi hemen seçilebilir (soru yok, "Katmanlar" düğmesi yok). Yazıya tıkla = yaz, sürükle = taşı. Yazı değiştirince arka plan resmi bozulmaz (yalnız yazı silinir); bir resmi silmek diğer sayfalardaki aynı resmi silmez; sayfa boyu arka plan resmi yazının önüne geçmez
- [x] Sayfalar ekranı: birleştir, böl, sırala, döndür, çoğalt, sil, boş sayfa tek ızgarada (eski Birleştir / Sayfa çıkar / Sayfaları düzenle / Ekle ve böl yerine); birden çok PDF bırakılırsa bu ekran açılır
- [x] Sol menü 5 ana işe indi (Başlangıç, PDF editörü, Sayfalar, Fotoğraf editörü, Pano); gerisi "Diğer araçlar" altında
- [x] Pano: her yerden Ctrl+Shift+V, imlecin yanında açılır, ok tuşları + Enter ile önceki programa yapıştırır, sekmeler (Tümü, Sabitli, Bağlantılar, Resimler, Yazılar), arama; sistem tepsisinde çalışır (pencere kapanınca gizlenir, "Çık" tepsiden). **Gerçek pencerede elle denenmedi** (genel kısayol ve otomatik yapıştırma yalnız Windows'ta çalışan gerçek uygulamada sınanabilir)
- [ ] Pano: kısayolu değiştirme, Windows ile başlatma, dosya kopyalarını tanıma
- [x] Vurgu / altını çiz / üstünü çiz gerçek kelimelere yapışır
- [x] PDF içindeki resmi silme / değiştirme
- [x] İki PDF karşılaştırma (satır farkı + kırmızı görsel fark)
- [x] Form alanı oluşturma (metin, onay kutusu, açılır liste)
- [x] Ekler, sayfa etiketleri (i, ii, iii)
- [x] Yazdırma / kopyalama izinlerini ayrı ayrı sınırlama
- [x] Bozuk PDF onarma
- [x] Imposition: sayfa başına 2–16, kitapçık
- [x] Sertifikalı dijital imza (.pfx/.p12) ve imza doğrulama (eklenti)
- [ ] Zaman damgası (çevrimiçi bir zaman sunucusu gerektirir, uygulamanın çevrimdışı ilkesine ters)
- [ ] Doğrudan tarayıcı / kameradan alma (donanım gerektirir; tarayıcının kendi uygulaması + "Taramayı temizle")
- [ ] PDF/A, PDF/X (Ghostscript gibi ağır bir araç gerekir)
- [ ] PDF → PowerPoint (kalitesi düşük, ağır)
- [ ] Hızlı web görünümü (linearize): kullandığımız kütüphane artık desteklemiyor
- [ ] OCR sonrası kelime düzeltme ekranı

## Fotoğraf

- [x] Eğriler, renk karıştırıcı (HSL), perspektif düzeltme: motor + arayüz paneli
- [x] Gürültü azaltma, lens bozulması, vinyet düzeltme (karanlık köşeleri açma)
- [x] Renk tonlama (gölge / orta ton / vurgu) ve `.cube` renk görünümü (LUT)
- [x] HEIC, AVIF, ICO açma; AVIF, GIF, ICO kaydetme
- [x] Sosyal medya boyut şablonları (12 hazır boyut)
- [x] Vesikalık / pasaport fotoğrafı sayfası
- [x] Kolaj, animasyonlu GIF / WebP oluşturma
- [x] Panorama dikme, poz birleştirme (HDR görünümü)
- [x] QR kod ekleme
- [x] Yerleşik büyütme (indirme gerektirmez); yapay zekâlı büyütme isteğe bağlı
- [x] Toplu işlemde kayıtlı görünüm kullanma
- [ ] Katman sistemi, seçim araçları, maskeler (uygulamayı Photoshop'a çevirir; "hafif ve kolay" hedefine ters)
- [ ] Fırça, klon, iyileştirme, kırmızı göz, sıvılaştırma, cilt düzeltme (aynı sebep)
- [ ] Yapay zekâ: nesne silme, yüz iyileştirme, renklendirme, otomatik seçim (yüzlerce MB model)
- [ ] RAW, PSD, SVG açma; animasyonlu GIF düzenleme; içerik duyarlı ölçekleme
- [ ] Mockup çerçeveleri, meme şablonları

## Karar bekleyen konular

- [x] **Lisans: AGPL-3.0 seçildi** (GitHub'da ücretsiz, açık kaynak; `LICENSE` eklendi). Eski not: PDF motoru PyMuPDF **AGPL** lisanslı. Kapalı kaynak dağıtılırsa ticari lisans gerekir. Seçenekler: projeyi AGPL altında açmak, ticari lisans almak, ya da `pikepdf` + `pypdfium2` gibi serbest lisanslı kütüphanelere geçmek
- [ ] **İsim:** klasör "LocalFlow", paket ve README "officev2". Tek isim seçilmeli
- [ ] **Lisans dosyası:** şu an "tüm hakları saklı"
- [ ] **ARCHITECTURE.md** hâlâ "henüz kod yok" diyor, güncellenmeli
- [ ] **Platform:** şu an yalnızca Windows
- [ ] **Yükleyici:** motor henüz yükleyiciye gömülü değil (kaynaktan çalışıyor). Çekirdek küçüldüğü için hedef ~100 MB gerçekçi

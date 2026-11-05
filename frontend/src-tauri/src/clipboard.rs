//! Clipboard history. Runs in the Rust shell so it keeps working without the Python sidecar.
//!
//! - Text and images. Text wins when both are present (spreadsheets put both on the clipboard).
//! - Content that password managers flag as "exclude from monitoring" is never recorded.
//! - Keeps the last 100 unpinned items; pinned items stay until removed. Images are additionally
//!   capped at 300 MB in total (oldest unpinned images go first).
//! - Stored in %APPDATA%\officev2\clipboard.db. Not encrypted at rest yet.

use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use rusqlite::{params, Connection};
use serde::Serialize;

const MAX_UNPINNED: i64 = 100;
const MAX_TEXT_BYTES: usize = 200_000;
const MAX_IMAGE_PNG_BYTES: usize = 25 * 1024 * 1024;
const IMAGE_BYTES_CAP: i64 = 300 * 1024 * 1024;
const THUMB_MAX_SIDE: u32 = 240;

#[derive(Serialize)]
pub struct Clip {
    pub id: i64,
    /// "text" or "image"
    pub kind: String,
    /// The text; empty for images.
    pub text: String,
    pub width: u32,
    pub height: u32,
    /// Small PNG preview as base64 (images only).
    pub thumb: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub created_at: i64,
    pub pinned: bool,
}

pub struct Store {
    conn: Mutex<Connection>,
    paused: AtomicBool,
    image_cap: i64,
    last_ts: AtomicI64,
}

pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("LOCALFLOW_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("XDG_DATA_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("officev2")
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// RGBA pixels -> PNG bytes.
pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    if rgba.len() != (width as usize) * (height as usize) * 4 {
        return Err("image data does not match its size".into());
    }
    let img = image::RgbaImage::from_raw(width, height, rgba.to_vec()).ok_or("image data does not match its size")?;
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// PNG bytes -> (RGBA pixels, width, height).
pub fn decode_png(png: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let img = image::load_from_memory_with_format(png, image::ImageFormat::Png).map_err(|e| e.to_string())?.to_rgba8();
    let (w, h) = img.dimensions();
    Ok((img.into_raw(), w, h))
}

fn thumbnail_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let img = image::RgbaImage::from_raw(width, height, rgba.to_vec()).ok_or("image data does not match its size")?;
    let scale = (THUMB_MAX_SIDE as f32 / width.max(height) as f32).min(1.0);
    let (tw, th) = (((width as f32 * scale).round() as u32).max(1), ((height as f32 * scale).round() as u32).max(1));
    let small = image::imageops::thumbnail(&img, tw, th);
    let mut out = Cursor::new(Vec::new());
    small.write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

fn pixel_key(rgba: &[u8], width: u32, height: u32) -> String {
    let mut h = DefaultHasher::new();
    rgba.hash(&mut h);
    format!("image:{width}x{height}:{:016x}", h.finish())
}

impl Store {
    pub fn open(path: PathBuf) -> rusqlite::Result<Self> {
        Self::open_with_cap(path, IMAGE_BYTES_CAP)
    }

    pub fn open_with_cap(path: PathBuf, image_cap: i64) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS clips(
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 text TEXT NOT NULL UNIQUE,
                 created_at INTEGER NOT NULL,
                 pinned INTEGER NOT NULL DEFAULT 0
             );",
        )?;
        // upgrade databases created before images were supported
        let have: Vec<String> = conn
            .prepare("PRAGMA table_info(clips)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<_, _>>()?;
        for (col, decl) in [
            ("kind", "TEXT NOT NULL DEFAULT 'text'"),
            ("width", "INTEGER NOT NULL DEFAULT 0"),
            ("height", "INTEGER NOT NULL DEFAULT 0"),
            ("image", "BLOB"),
            ("thumb", "BLOB"),
        ] {
            if !have.iter().any(|c| c == col) {
                conn.execute(&format!("ALTER TABLE clips ADD COLUMN {col} {decl}"), [])?;
            }
        }
        Ok(Self { conn: Mutex::new(conn), paused: AtomicBool::new(false), image_cap, last_ts: AtomicI64::new(0) })
    }

    /// Strictly increasing millisecond clock, so items copied within the same millisecond keep their order.
    fn tick(&self) -> i64 {
        let mut prev = self.last_ts.load(Ordering::Relaxed);
        loop {
            let next = now_ms().max(prev + 1);
            match self.last_ts.compare_exchange(prev, next, Ordering::Relaxed, Ordering::Relaxed) {
                Ok(_) => return next,
                Err(actual) => prev = actual,
            }
        }
    }

    fn trim(&self, conn: &Connection) -> rusqlite::Result<()> {
        conn.execute(
            "DELETE FROM clips WHERE pinned = 0 AND id NOT IN
             (SELECT id FROM clips WHERE pinned = 0 ORDER BY created_at DESC, id DESC LIMIT ?1)",
            params![MAX_UNPINNED],
        )?;
        // keep total image storage under the cap: drop the oldest unpinned images first
        loop {
            let total: i64 =
                conn.query_row("SELECT COALESCE(SUM(LENGTH(image)), 0) FROM clips WHERE kind = 'image'", [], |r| r.get(0))?;
            if total <= self.image_cap {
                return Ok(());
            }
            let oldest: Option<i64> = conn
                .query_row(
                    "SELECT id FROM clips WHERE kind = 'image' AND pinned = 0 ORDER BY created_at ASC, id ASC LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .ok();
            match oldest {
                Some(id) => conn.execute("DELETE FROM clips WHERE id = ?1", params![id])?,
                None => return Ok(()), // only pinned images left; never drop those
            };
        }
    }

    /// Insert, or move an existing identical entry back to the top. Then trim to the caps.
    pub fn record(&self, text: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO clips(text, created_at) VALUES (?1, ?2)
             ON CONFLICT(text) DO UPDATE SET created_at = excluded.created_at",
            params![text, self.tick()],
        )?;
        self.trim(&conn)
    }

    pub fn record_image(&self, rgba: &[u8], width: u32, height: u32) -> Result<(), String> {
        let png = encode_png(rgba, width, height)?;
        if png.len() > MAX_IMAGE_PNG_BYTES {
            return Err("image is too large to keep".into());
        }
        let thumb = thumbnail_png(rgba, width, height)?;
        let key = pixel_key(rgba, width, height);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO clips(text, created_at, kind, width, height, image, thumb) VALUES (?1, ?2, 'image', ?3, ?4, ?5, ?6)
             ON CONFLICT(text) DO UPDATE SET created_at = excluded.created_at",
            params![key, self.tick(), width, height, png, thumb],
        )
        .map_err(|e| e.to_string())?;
        self.trim(&conn).map_err(|e| e.to_string())
    }

    pub fn list(&self, query: Option<String>) -> rusqlite::Result<Vec<Clip>> {
        let conn = self.conn.lock().unwrap();
        let raw = query.unwrap_or_default();
        let q = raw.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        // images have no text to search, so a search only returns text items
        let mut stmt = conn.prepare(
            "SELECT id, kind, text, width, height, thumb, created_at, pinned FROM clips
             WHERE (?2 = '' OR kind = 'text') AND (kind = 'image' OR text LIKE ?1 ESCAPE '\\')
             ORDER BY pinned DESC, created_at DESC, id DESC",
        )?;
        let rows = stmt.query_map(params![format!("%{q}%"), raw], |r| {
            let kind: String = r.get(1)?;
            let thumb: Option<Vec<u8>> = r.get(5)?;
            Ok(Clip {
                id: r.get(0)?,
                text: if kind == "image" { String::new() } else { r.get(2)? },
                kind,
                width: r.get(3)?,
                height: r.get(4)?,
                thumb: thumb.map(|t| base64::engine::general_purpose::STANDARD.encode(t)),
                created_at: r.get(6)?,
                pinned: r.get::<_, i64>(7)? != 0,
            })
        })?;
        rows.collect()
    }

    pub fn text_of(&self, id: i64) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT text FROM clips WHERE id = ?1 AND kind = 'text'", params![id], |r| r.get(0)).ok()
    }

    pub fn image_png(&self, id: i64) -> Option<Vec<u8>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT image FROM clips WHERE id = ?1 AND kind = 'image'", params![id], |r| r.get(0)).ok()
    }

    pub fn set_pinned(&self, id: i64, pinned: bool) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE clips SET pinned = ?2 WHERE id = ?1", params![id, pinned as i64])?;
        Ok(())
    }

    pub fn delete(&self, id: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM clips WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn clear_unpinned(&self) -> rusqlite::Result<usize> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM clips WHERE pinned = 0", [])
    }

    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
    }
}

/// Puts a stored image back on the system clipboard.
pub fn copy_image(png: &[u8]) -> Result<(), String> {
    let (rgba, w, h) = decode_png(png)?;
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: Cow::Owned(rgba) }))
        .map_err(|e| e.to_string())
}

/// True when the source application asked clipboard monitors to ignore this content
/// (password managers set this format).
#[cfg(windows)]
fn excluded_by_source() -> bool {
    use clipboard_win::{is_format_avail, register_format};
    register_format("ExcludeClipboardContentFromMonitorProcessing").map(|f| is_format_avail(f.get())).unwrap_or(false)
}

#[cfg(not(windows))]
fn excluded_by_source() -> bool {
    false
}

pub fn spawn_watcher(store: Arc<Store>) {
    std::thread::spawn(move || {
        let mut board = match arboard::Clipboard::new() {
            Ok(b) => b,
            Err(e) => {
                eprintln!("clipboard watcher disabled: {e}");
                return;
            }
        };
        let mut last_text = String::new();
        let mut last_image = String::new();
        loop {
            std::thread::sleep(Duration::from_millis(600));
            if store.paused() || excluded_by_source() {
                continue;
            }
            match board.get_text() {
                Ok(text) if !text.trim().is_empty() => {
                    if text != last_text {
                        last_text = text.clone();
                        if text.len() <= MAX_TEXT_BYTES {
                            let _ = store.record(&text);
                        }
                    }
                }
                _ => {
                    last_text.clear(); // so copying the same text again later is recorded again
                    if let Ok(img) = board.get_image() {
                        let (w, h) = (img.width as u32, img.height as u32);
                        let key = pixel_key(&img.bytes, w, h);
                        if key != last_image {
                            last_image = key;
                            if let Err(e) = store.record_image(&img.bytes, w, h) {
                                eprintln!("clipboard image skipped: {e}");
                            }
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(cap: i64) -> Store {
        let dir = std::env::temp_dir().join(format!("lf-clip-test-{}", uuid::Uuid::new_v4().simple()));
        Store::open_with_cap(dir.join("clip.db"), cap).unwrap()
    }

    fn store() -> Store {
        store_with(IMAGE_BYTES_CAP)
    }

    /// A w x h image with a gradient so each seed gives different bytes.
    fn pixels(w: u32, h: u32, seed: u8) -> Vec<u8> {
        (0..w * h).flat_map(|i| [(i % 251) as u8 ^ seed, (i / 7 % 251) as u8, seed, 255]).collect()
    }

    #[test]
    fn dedupes_and_moves_repeats_to_the_top() {
        let s = store();
        s.record("one").unwrap();
        s.record("two").unwrap();
        s.record("one").unwrap();
        let texts: Vec<String> = s.list(None).unwrap().into_iter().map(|c| c.text).collect();
        assert_eq!(texts, vec!["one", "two"]);
    }

    #[test]
    fn keeps_only_the_last_100_unpinned_but_all_pinned() {
        let s = store();
        s.record("keep me").unwrap();
        let id = s.list(None).unwrap()[0].id;
        s.set_pinned(id, true).unwrap();
        for i in 0..150 {
            s.record(&format!("item {i}")).unwrap();
        }
        let all = s.list(None).unwrap();
        assert_eq!(all.len(), 101);
        assert_eq!(all[0].text, "keep me"); // pinned first
        assert!(all.iter().any(|c| c.text == "item 149"));
        assert!(!all.iter().any(|c| c.text == "item 0"));
    }

    #[test]
    fn search_is_literal_and_clear_spares_pinned() {
        let s = store();
        s.record("100% sure").unwrap();
        s.record("plain text").unwrap();
        s.record("under_score").unwrap();
        assert_eq!(s.list(Some("100%".into())).unwrap().len(), 1);
        assert_eq!(s.list(Some("_".into())).unwrap().len(), 1); // underscore is not a wildcard
        let id = s.list(Some("plain".into())).unwrap()[0].id;
        s.set_pinned(id, true).unwrap();
        s.clear_unpinned().unwrap();
        let left = s.list(None).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].text, "plain text");
        s.delete(id).unwrap();
        assert!(s.list(None).unwrap().is_empty());
    }

    #[test]
    fn png_roundtrip_is_lossless() {
        let px = pixels(37, 21, 5);
        let png = encode_png(&px, 37, 21).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let (back, w, h) = decode_png(&png).unwrap();
        assert_eq!((w, h), (37, 21));
        assert_eq!(back, px);
        assert!(encode_png(&px, 10, 10).is_err()); // wrong size is rejected, not a panic
    }

    #[test]
    fn images_are_stored_with_a_small_thumbnail_and_can_be_restored() {
        let s = store();
        let px = pixels(800, 600, 1);
        s.record_image(&px, 800, 600).unwrap();
        s.record("some text").unwrap();
        let all = s.list(None).unwrap();
        assert_eq!(all.len(), 2);
        let img = all.iter().find(|c| c.kind == "image").unwrap();
        assert_eq!((img.width, img.height), (800, 600));
        assert!(img.text.is_empty());
        let thumb = base64::engine::general_purpose::STANDARD.decode(img.thumb.as_ref().unwrap()).unwrap();
        let (_, tw, th) = decode_png(&thumb).unwrap();
        assert_eq!((tw, th), (240, 180)); // aspect ratio kept, longest side 240
        let (restored, w, h) = decode_png(&s.image_png(img.id).unwrap()).unwrap();
        assert_eq!((w, h), (800, 600));
        assert_eq!(restored, px);
        assert!(s.text_of(img.id).is_none());
    }

    #[test]
    fn identical_images_are_deduped_and_small_images_are_not_enlarged() {
        let s = store();
        let px = pixels(30, 20, 9);
        s.record_image(&px, 30, 20).unwrap();
        s.record_image(&px, 30, 20).unwrap();
        s.record_image(&pixels(30, 20, 10), 30, 20).unwrap();
        let imgs = s.list(None).unwrap();
        assert_eq!(imgs.len(), 2);
        let thumb = base64::engine::general_purpose::STANDARD.decode(imgs[0].thumb.as_ref().unwrap()).unwrap();
        assert_eq!(decode_png(&thumb).unwrap().1, 30);
    }

    #[test]
    fn searching_returns_text_only() {
        let s = store();
        s.record_image(&pixels(10, 10, 3), 10, 10).unwrap();
        s.record("find me").unwrap();
        let hits = s.list(Some("find".into())).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "text");
        assert_eq!(s.list(Some("image".into())).unwrap().len(), 0);
    }

    #[test]
    fn image_storage_cap_drops_oldest_unpinned_but_never_pinned() {
        let one = encode_png(&pixels(60, 60, 1), 60, 60).unwrap().len() as i64;
        let s = store_with(one * 2 + one / 2); // room for two images
        s.record_image(&pixels(60, 60, 1), 60, 60).unwrap();
        let first = s.list(None).unwrap()[0].id;
        s.set_pinned(first, true).unwrap();
        for seed in 2..6u8 {
            s.record_image(&pixels(60, 60, seed), 60, 60).unwrap();
        }
        let kept = s.list(None).unwrap();
        assert!(kept.iter().any(|c| c.id == first), "the pinned image must survive");
        assert_eq!(kept.len(), 2, "pinned + the newest one fit under the cap");
    }

    #[test]
    fn upgrades_a_database_created_before_images() {
        let dir = std::env::temp_dir().join(format!("lf-clip-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old.db");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE clips(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL UNIQUE,
                 created_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
                 INSERT INTO clips(text, created_at) VALUES ('legacy entry', 1);",
            )
            .unwrap();
        }
        let s = Store::open(path).unwrap();
        let all = s.list(None).unwrap();
        assert_eq!((all.len(), all[0].kind.as_str(), all[0].text.as_str()), (1, "text", "legacy entry"));
        s.record_image(&pixels(8, 8, 2), 8, 8).unwrap();
        assert_eq!(s.list(None).unwrap().len(), 2);
    }
}

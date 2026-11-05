//! Screen access: pixel under the cursor and a screenshot of the primary display (Windows only).

use std::path::Path;

#[cfg(windows)]
pub fn pixel_at_cursor() -> Result<String, String> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC, CLR_INVALID};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    unsafe {
        let mut p = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut p) == 0 {
            return Err("could not read the cursor position".into());
        }
        let dc = GetDC(std::ptr::null_mut());
        if dc.is_null() {
            return Err("could not access the screen".into());
        }
        let c = GetPixel(dc, p.x, p.y);
        ReleaseDC(std::ptr::null_mut(), dc);
        if c == CLR_INVALID {
            return Err("the cursor is outside the screen".into());
        }
        let (r, g, b) = ((c & 0xFF) as u8, ((c >> 8) & 0xFF) as u8, ((c >> 16) & 0xFF) as u8);
        Ok(format!("#{r:02X}{g:02X}{b:02X}"))
    }
}

#[cfg(not(windows))]
pub fn pixel_at_cursor() -> Result<String, String> {
    Err("Color picking is only implemented on Windows".into())
}

/// Saves the primary display as a PNG and returns its size in pixels.
#[cfg(windows)]
pub fn capture_primary(path: &Path) -> Result<(u32, u32), String> {
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    unsafe {
        let (w, h) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
        if w <= 0 || h <= 0 {
            return Err("could not read the screen size".into());
        }
        let screen = GetDC(std::ptr::null_mut());
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp);
        let blitted = BitBlt(mem, 0, 0, w, h, screen, 0, 0, SRCCOPY);

        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -h; // top-down
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        let lines = GetDIBits(mem, bmp, 0, h as u32, buf.as_mut_ptr().cast(), &mut info, DIB_RGB_COLORS);

        SelectObject(mem, old);
        DeleteObject(bmp);
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);

        if blitted == 0 || lines == 0 {
            return Err("the screenshot failed".into());
        }
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2); // BGRA -> RGBA
            px[3] = 255;
        }
        image::save_buffer(path, &buf, w as u32, h as u32, image::ColorType::Rgba8).map_err(|e| e.to_string())?;
        Ok((w as u32, h as u32))
    }
}

#[cfg(not(windows))]
pub fn capture_primary(_path: &Path) -> Result<(u32, u32), String> {
    Err("Screen capture is only implemented on Windows".into())
}

// Embeds assets/icon.ico as this .exe's own PE icon resource -- what
// Explorer, the taskbar's pinned/unlaunched icon, and Alt-Tab (before the
// window sets its own runtime icon) all read. Without this the binary
// gets Windows' generic blank-application icon. The RUNNING window's
// icon (title bar + live taskbar entry) is set separately, in Rust, via
// NativeOptions.viewport.with_icon() in main.rs -- winres only covers
// the static file resource, not anything at runtime.
fn main() {
    #[cfg(windows)]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon("assets/icon.ico");
        res.compile().expect("failed to embed icon.ico into the .exe resources");
    }
}

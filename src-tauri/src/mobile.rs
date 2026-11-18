//! A phone has one window. The desktop's window calls (more windows, web tabs laid over the page, maximizing,
//! folder pickers) do not exist there, so on Android and iOS they compile as these stand-ins: showing and moving
//! does nothing, a new web tab or folder pick is refused or comes back empty. The desktop never sees this file.
use tauri::webview::{NewWindowFeatures, WebviewBuilder};
use tauri::{Manager, Position, Runtime, Size, Webview, WebviewWindow, WebviewWindowBuilder, Window};
use tauri_plugin_dialog::{FileDialogBuilder, FilePath, MessageDialogBuilder};

type Done = tauri::Result<()>;

pub trait WebviewDesk {
    fn close(&self) -> Done { Ok(()) }
    fn show(&self) -> Done { Ok(()) }
    fn hide(&self) -> Done { Ok(()) }
    fn set_focus(&self) -> Done { Ok(()) }
    fn set_position<P: Into<Position>>(&self, _: P) -> Done { Ok(()) }
    fn set_size<S: Into<Size>>(&self, _: S) -> Done { Ok(()) }
}
impl<R: Runtime> WebviewDesk for Webview<R> {}

pub trait WindowDesk<R: Runtime> {
    fn add_child<P: Into<Position>, S: Into<Size>>(&self, _: WebviewBuilder<R>, _: P, _: S) -> tauri::Result<Webview<R>> {
        Err(tauri::Error::WebviewNotFound)
    }
    fn set_fullscreen(&self, _: bool) -> Done { Ok(()) }
    fn maximize(&self) -> Done { Ok(()) }
    fn unminimize(&self) -> Done { Ok(()) }
}
impl<R: Runtime> WindowDesk<R> for Window<R> {}

pub trait WebviewWindowDesk {
    fn maximize(&self) -> Done { Ok(()) }
    fn unmaximize(&self) -> Done { Ok(()) }
    fn unminimize(&self) -> Done { Ok(()) }
}
impl<R: Runtime> WebviewWindowDesk for WebviewWindow<R> {}

pub trait BuilderDesk: Sized {
    fn decorations(self, _: bool) -> Self { self }
    fn always_on_top(self, _: bool) -> Self { self }
    fn window_features(self, _: NewWindowFeatures) -> Self { self }
    fn skip_taskbar(self, _: bool) -> Self { self }
    fn shadow(self, _: bool) -> Self { self }
    fn center(self) -> Self { self }
    fn focused(self, _: bool) -> Self { self }
}
impl<'a, R: Runtime, M: Manager<R>> BuilderDesk for WebviewWindowBuilder<'a, R, M> {}

pub trait PickDesk: Sized {
    fn blocking_pick_folder(self) -> Option<FilePath> { None }
    fn blocking_pick_folders(self) -> Option<Vec<FilePath>> { None }
}
impl<R: Runtime> PickDesk for FileDialogBuilder<R> {}

pub trait ParentDesk: Sized {
    fn parent<W>(self, _: &W) -> Self { self }
}
impl<R: Runtime> ParentDesk for MessageDialogBuilder<R> {}

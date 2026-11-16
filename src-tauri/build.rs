fn main() {
    // Windows looks for the system's DLLs next to the program first, and the portable exe often sits in Downloads:
    // a dwmapi.dll dropped beside it would run as Leonote. System32 only.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bins=/DEPENDENTLOADFLAG:0x800");
    }
    tauri_build::build()
}

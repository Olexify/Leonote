//! What a web shortcut is allowed to be before a window is ever built.

use super::webwin::*;

#[test]
fn only_http_and_https_open_a_window() {
    assert!(check_url("https://pinterest.com").is_ok());
    assert!(check_url("  http://localhost:3000/board  ").is_ok());
    assert_eq!(check_url("https://x.com").unwrap(), "https://x.com");
    // local pages open in the browser tab too (a site folder on disk)
    assert!(check_url("file:///E:/Site/index.html").is_ok());
    for bad in ["javascript:alert(1)", "data:text/html,<b>", "pinterest.com", ""] {
        assert!(check_url(bad).is_err(), "{} must be refused", bad);
    }
}

#[test]
fn a_url_with_a_newline_in_it_is_not_a_url() {
    assert!(check_url("https://x.com\nhttps://evil.example").is_err());
    assert!(check_url(&format!("https://x.com/{}", "a".repeat(3000))).is_err());
}

#[test]
fn every_web_window_label_is_recognisable_as_one() {
    assert!(is_web_label("web-abc123"));
    assert!(!is_web_label("main"));
}

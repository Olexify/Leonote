//! The loopback catcher: what it reads out of a redirect, and that a real
//! request on the port it opened comes back to the waiting command.

use super::oauth::*;
use std::io::{Read, Write};
use std::net::TcpStream;

#[test]
fn parses_the_redirect_query() {
    let q = parse_request("GET /callback?code=abc123&state=xy%2Fz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
    assert_eq!(q.get("code").unwrap(), "abc123");
    assert_eq!(q.get("state").unwrap(), "xy/z");
    let refused = parse_request("GET /callback?error=access_denied HTTP/1.1\r\n\r\n").unwrap();
    assert_eq!(refused.get("error").unwrap(), "access_denied");
    assert!(parse_request("GET /callback HTTP/1.1\r\n\r\n").unwrap().is_empty());
    assert!(parse_request("POST /callback?code=x HTTP/1.1\r\n\r\n").is_none(), "only GET");
    assert!(parse_request("").is_none());
}

#[test]
fn a_loopback_redirect_reaches_the_waiting_command() {
    let state = "s1-of-this-sign-in-0123";
    let started = tauri::async_runtime::block_on(oauth_listen(state.into())).unwrap();
    let port = started["port"].as_u64().unwrap() as u16;
    assert!(started["redirect"].as_str().unwrap().starts_with("http://127.0.0.1:"));
    // another process, or a web page in the browser, gets there first: told nothing, and the wait goes on
    for q in ["error=access_denied", "code=x&state=wrong"] {
        let mut sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
        sock.write_all(format!("GET /callback?{q} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).unwrap();
        let mut reply = String::new();
        let _ = sock.read_to_string(&mut reply);
        assert!(reply.contains("Nothing to do here"), "{q}");
    }
    let mut sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
    sock.write_all(format!("GET /callback?code=hello&state={state} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).unwrap();
    let mut reply = String::new();
    let _ = sock.read_to_string(&mut reply);
    assert!(reply.starts_with("HTTP/1.1 200 OK"), "the browser gets a page back");
    let got = tauri::async_runtime::block_on(oauth_wait(port, Some(5_000))).unwrap();
    assert_eq!(got["code"].as_str().unwrap(), "hello");
    assert_eq!(got["state"].as_str().unwrap(), state);
    assert!(tauri::async_runtime::block_on(oauth_listen("short".into())).is_err(), "a sign-in needs its state");
    // the same port cannot be waited on twice
    assert!(tauri::async_runtime::block_on(oauth_wait(port, Some(100))).is_err());
}

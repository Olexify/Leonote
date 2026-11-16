//! A page's title, description and picture for a link card in a note: the
//! page's own <title> and Open Graph tags, read from its first 300 KB.

use serde_json::{json, Value};

/// The content of `<meta ... property|name="key" ... content="…">`, if any.
fn meta(html: &str, key: &str) -> Option<String> {
    let low = html.to_ascii_lowercase();
    let mut at = 0;
    while let Some(i) = low[at..].find("<meta") {
        let start = at + i;
        let end = low[start..].find('>').map(|e| start + e).unwrap_or(low.len());
        let tag = &low[start..end];
        if tag.contains(&format!("=\"{}\"", key)) || tag.contains(&format!("='{}'", key)) {
            let raw = &html[start..end];
            if let Some(c) = attr(raw, "content") {
                return Some(c);
            }
        }
        at = end.max(start + 5);
    }
    None
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let low = tag.to_ascii_lowercase();
    let i = low.find(&format!("{}=", name))? + name.len() + 1;
    let rest = &tag[i..];
    let (q, body) = match rest.chars().next()? {
        '"' => ('"', &rest[1..]),
        '\'' => ('\'', &rest[1..]),
        _ => (' ', rest),
    };
    let end = body.find(q).unwrap_or(body.len());
    Some(unescape(body[..end].trim()))
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ")
}

/// A page that stands between you and the site ("Just a moment...", "Access denied"): nothing on it is the page's.
fn gatekeeper(title: &str) -> bool {
    let t = title.to_ascii_lowercase();
    ["just a moment", "attention required", "access denied", "403 forbidden", "forbidden", "are you a robot", "security check", "verify you are human", "please wait"]
        .iter()
        .any(|k| t.starts_with(k))
}

fn title_tag(html: &str) -> Option<String> {
    let low = html.to_ascii_lowercase();
    let i = low.find("<title")?;
    let s = low[i..].find('>')? + i + 1;
    let e = low[s..].find("</title>")? + s;
    Some(unescape(html[s..e].trim()))
}

/// Whether an http(s) address names a host on the internet - not localhost, a .local / .localhost name,
/// or a loopback, private, link-local or unspecified IP address.
pub(crate) fn public_host(url: &str) -> bool {
    let Ok(u) = tauri::Url::parse(url) else { return false };
    if !matches!(u.scheme(), "http" | "https") { return false; }
    let host = u.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => public_ip(ip),
        Err(_) => !(host.is_empty() || host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".lan") || host.ends_with(".internal") || !host.contains('.')),
    }
}

/// An address on the internet - not this computer, the local network, link-local, carrier NAT, documentation or
/// reserved space; an IPv6 address carrying an IPv4 one (mapped, NAT64) is judged by the IPv4 one inside.
pub(crate) fn public_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    let v4 = |ip: std::net::Ipv4Addr| {
        let o = ip.octets();
        !(o[0] == 0 || ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_broadcast() || ip.is_documentation()
            || (o[0] == 100 && (o[1] & 0xc0) == 64) || (o[0] == 192 && o[1] == 0 && o[2] == 0) || (o[0] == 198 && (o[1] & 0xfe) == 18) || o[0] >= 224)
    };
    match ip {
        IpAddr::V4(a) => v4(a),
        IpAddr::V6(a) => {
            if let Some(m) = a.to_ipv4_mapped() { return v4(m); }
            let s = a.segments();
            // only global unicast (2000::/3) - and not the ranges in it that carry or reach other addresses:
            // 6to4 (2002::/16), Teredo and other 2001::/23 protocol space, documentation (2001:db8::/32)
            (s[0] & 0xe000) == 0x2000 && s[0] != 0x2002 && !(s[0] == 0x2001 && s[1] < 0x0200) && !(s[0] == 0x2001 && s[1] == 0x0db8)
        }
    }
}

fn is_youtube(url: &str) -> bool {
    let Ok(u) = tauri::Url::parse(url) else { return false };
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    host == "youtu.be" || ["youtube.com", "youtube-nocookie.com"].iter().any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

fn oembed_url(url: &str) -> Result<String, String> {
    tauri::Url::parse_with_params("https://www.youtube.com/oembed", &[("url", url), ("format", "json")]).map(|u| u.to_string()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod host_tests {
    #[test]
    fn a_youtube_link_is_known_by_its_real_host() {
        for yes in ["https://www.youtube.com/watch?v=abc", "https://YouTube.com/@x", "https://music.youtube.com/playlist?list=PL1", "https://youtu.be/abc", "https://www.youtube-nocookie.com/embed/abc", "https://evil.example@youtube.com/"] { assert!(super::is_youtube(yes), "{yes}"); }
        for no in ["https://youtube.com.evil.example/", "https://notyoutube.com/", "https://youtube.com@evil.example/", "https://example.com/?u=youtube.com"] { assert!(!super::is_youtube(no), "{no}"); }
        assert_eq!(super::oembed_url("https://www.youtube.com/watch?v=a&t=1").unwrap(), "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Da%26t%3D1&format=json");
    }
    #[test]
    fn link_cards_are_for_the_internet_only() {
        for ok in ["https://example.com/a", "http://8.8.8.8/", "http://[2606:4700::1111]/"] { assert!(super::public_host(ok), "{ok}"); }
        for bad in ["http://localhost:3000", "http://127.0.0.1/", "http://192.168.1.1/", "http://10.0.0.5/", "http://169.254.1.1/", "http://[::1]/", "http://router.local/", "http://intranet/", "http://tauri.localhost/", "file:///C:/x",
                    "http://0.0.0.0/", "http://0.1.2.3/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:192.168.0.1]/", "http://[64:ff9b::a00:1]/", "http://[fec0::1]/", "http://[fd00::1]/", "http://[2002:7f00:1::1]/", "http://[2001::1]/"] {
            assert!(!super::public_host(bad), "{bad}");
        }
    }
}

/// What a link card shows: { title, description, image, site }.
#[tauri::command]
pub async fn link_preview(url: String, lang: Option<String>) -> Result<Value, String> {
    let u = crate::webwin::check_url(&url)?;
    // a card is for a page on the internet: not this computer or the local network (a router, a printer)
    if !public_host(&u) { return Err("not a page on the internet".into()); }
    // some pages (YouTube) put their head after a megabyte of script: read up to 2 MB;
    // asked in the app's own language, or the site picks one from where the request comes from
    let lang: String = lang.unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | ',' | ';' | '=' | '.' | ' ')).take(100).collect();
    // no page of YouTube's is read: what a card shows comes from YouTube's official oEmbed
    if is_youtube(&u) {
        let j: Value = oembed_url(&u).and_then(|o| crate::webext::fetch_public(&o, 64 << 10, &lang)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        return Ok(json!({ "title": j["title"].as_str().unwrap_or(""), "description": "", "image": j["thumbnail_url"].as_str().unwrap_or(""), "site": "YouTube" }));
    }
    // every address it connects to, redirects included, is checked again once the name is looked up
    let bytes = crate::webext::fetch_public(&u, 2 << 20, &lang)?;
    let html = String::from_utf8_lossy(&bytes).to_string();
    let title = meta(&html, "og:title").or_else(|| meta(&html, "twitter:title")).or_else(|| title_tag(&html)).unwrap_or_default();
    let host = u.split("//").nth(1).and_then(|r| r.split('/').next()).unwrap_or("").trim_start_matches("www.").to_string();
    if gatekeeper(&title) {
        return Ok(json!({ "title": "", "description": "", "image": "", "site": host }));
    }
    let description = meta(&html, "og:description").or_else(|| meta(&html, "description")).or_else(|| meta(&html, "twitter:description")).unwrap_or_default();
    let image = meta(&html, "og:image").or_else(|| meta(&html, "twitter:image")).unwrap_or_default();
    let site = meta(&html, "og:site_name").unwrap_or_default();
    // a relative picture address is made whole
    let image = if image.starts_with('/') && !image.starts_with("//") { format!("{}{}", u.split('/').take(3).collect::<Vec<_>>().join("/"), image) } else { image };
    Ok(json!({ "title": title, "description": description.chars().take(300).collect::<String>(), "image": image, "site": if site.is_empty() { host } else { site } }))
}

/// A card's picture or site icon as a `data:` address. Fetched here, not by the webview: the check above sees only
/// the address, while this one also holds for what a name resolves to and for every redirect - so a card can make
/// no request to this computer or the local network.
#[tauri::command]
pub async fn link_picture(url: String) -> Result<String, String> {
    const MAX: u64 = 2 << 20;
    let u = crate::webwin::check_url(&url)?;
    if !public_host(&u) { return Err("not a page on the internet".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let b = crate::webext::fetch_public(&u, MAX + 1, "")?;
        if b.len() as u64 > MAX { return Err("that picture is too big for a card".to_string()); }
        picture_data_url(&b).ok_or_else(|| "not a picture".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What the bytes say they are, whatever the server called them; anything but a picture (an HTML error page) is none.
fn picture_data_url(b: &[u8]) -> Option<String> {
    use base64::Engine;
    let head = String::from_utf8_lossy(&b[..b.len().min(1024)]).to_ascii_lowercase();
    let mime = if b.starts_with(&[0, 0, 1, 0]) { "image/x-icon" }
        else if b.starts_with(b"BM") { "image/bmp" }
        else if b.len() > 12 && &b[4..8] == b"ftyp" && &b[8..12] == b"avif" { "image/avif" }
        else if head.trim_start_matches('\u{feff}').trim_start().starts_with('<') && head.contains("<svg") && !head.contains("<html") { "image/svg+xml" }
        else { Some(crate::phone::sniff(b)).filter(|m| m.starts_with("image/"))? };
    Some(format!("data:{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(b)))
}

/// A source for a project (the room's Add a source): the page's HTML as text, or
/// any other kind of file (a PDF) as base64 for the app to keep in the vault.
/// Up to 40 MB; web addresses only.
#[tauri::command]
pub async fn source_fetch(app: tauri::AppHandle, url: String) -> Result<Value, String> {
    let u = crate::webwin::check_url(&url)?;
    if !u.to_ascii_lowercase().starts_with("http") {
        return Err("Only a web address can be added as a source".into());
    }
    // an address on this computer or the home network is read only when the user says so: the whole answer comes back
    // to the page, which a script in it could otherwise use to look around the router, a local server and the like
    if !public_host(&u) && !crate::grant::ask(&app, "Leonote is asking", &format!("Leonote wants to download a source from this computer or your own network:\n\n{u}\n\nAllow it? Say no if you did not just ask Leonote for this.")) {
        return Err(format!("Not allowed: {u}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        use std::io::Read;
        // a page on the internet may not redirect into this computer or the local network; a local address pasted on purpose still opens
        let agent = if public_host(&u) { crate::webext::public_agent() } else {
            ureq::AgentBuilder::new()
                .timeout_connect(std::time::Duration::from_secs(15))
                .timeout_read(std::time::Duration::from_secs(120))
                .build()
        };
        let resp = agent
            .get(&u)
            .set("User-Agent", crate::webext::AGENT)
            .call()
            .map_err(|e| format!("Could not download it: {}", e))?;
        let final_url = resp.get_url().to_string();
        let kind = resp.content_type().to_ascii_lowercase();
        let mut bytes = Vec::new();
        resp.into_reader().take(40 << 20).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        let text = kind.starts_with("text/") || kind.contains("html") || kind.contains("xml") || kind.contains("json");
        Ok(if text {
            json!({ "url": final_url, "type": kind, "text": String::from_utf8_lossy(&bytes) })
        } else {
            json!({ "url": final_url, "type": kind, "b64": base64::engine::general_purpose::STANDARD.encode(&bytes) })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_title_and_open_graph() {
        let html = r#"<html><head><title>Plain &amp; simple</title><meta property="og:title" content="OG title"><meta name="description" content='Desc "here"'></head></html>"#;
        assert_eq!(meta(html, "og:title").as_deref(), Some("OG title"));
        assert_eq!(meta(html, "description").as_deref(), Some("Desc \"here\""));
        assert_eq!(title_tag(html).as_deref(), Some("Plain & simple"));
        assert!(meta(html, "og:image").is_none());
        assert!(gatekeeper("Just a moment..."));
        assert!(!gatekeeper("Bell Ringing by freesound_community | Royalty-free Sound Effects - Pixabay"));
    }
    #[test]
    fn a_card_shows_only_real_pictures() {
        for (b, m) in [(&b"\x89PNG\r\n"[..], "image/png"), (&[0, 0, 1, 0, 1][..], "image/x-icon"), (&b"<?xml version=\"1.0\"?><svg></svg>"[..], "image/svg+xml")] {
            assert!(picture_data_url(b).unwrap().starts_with(&format!("data:{m};base64,")), "{m}");
        }
        for b in [&b"<!doctype html><html><svg></svg></html>"[..], b"not found", b"%PDF-1.7"] { assert!(picture_data_url(b).is_none()); }
    }
}

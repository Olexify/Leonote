//! Speech to text through a cloud model (Groq's Whisper, OpenAI's
//! transcribe models, Mistral's Voxtral): the page records a short clip,
//! it goes up as one multipart request to the provider's
//! /audio/transcriptions, the words come back. The key is the sealed one
//! kept for the Assistant (`ai_key_set`), never sent anywhere else.

use base64::Engine;
use serde_json::{json, Value};
use std::time::Duration;

/// The multipart body a transcription endpoint reads: the clip, the model, the language if given.
pub fn multipart(boundary: &str, audio: &[u8], mime: &str, ext: &str, model: &str, lang: &str, prompt: &str) -> Vec<u8> {
    let mut b = Vec::with_capacity(audio.len() + 1024);
    let field = |b: &mut Vec<u8>, name: &str, value: &str| {
        b.extend_from_slice(format!("--{}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{}\r\n", boundary, name, value).as_bytes());
    };
    b.extend_from_slice(format!("--{}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"clip.{}\"\r\nContent-Type: {}\r\n\r\n", boundary, ext, mime).as_bytes());
    b.extend_from_slice(audio);
    b.extend_from_slice(b"\r\n");
    field(&mut b, "model", model);
    field(&mut b, "response_format", "json");
    if !lang.is_empty() { field(&mut b, "language", lang); }
    if !prompt.is_empty() { field(&mut b, "prompt", prompt); }
    b.extend_from_slice(format!("--{}--\r\n", boundary).as_bytes());
    b
}

/// `audio` is base64 of the recorded clip. `key_ids` are tried in order for a sealed key.
#[tauri::command]
pub async fn speech_transcribe(base: String, model: String, key_ids: Vec<String>, audio: String, mime: String, lang: Option<String>, prompt: Option<String>) -> Result<Value, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(audio.trim()).map_err(|_| "The clip could not be read".to_string())?;
    if bytes.len() < 200 { return Err("Nothing was recorded.".into()); }
    if bytes.len() > 25 * 1024 * 1024 { return Err("The clip is over 25 MB.".into()); }
    let ext = if mime.contains("ogg") { "ogg" } else if mime.contains("mp4") { "mp4" } else if mime.contains("wav") { "wav" } else { "webm" };
    // Whisper on this computer: the clip into a temporary file, heard there, gone again
    if base == "local" {
        return tauri::async_runtime::spawn_blocking(move || {
            let f = std::env::temp_dir().join(format!("leonote-mic-{}.{ext}", std::process::id()));
            std::fs::write(&f, &bytes).map_err(|e| e.to_string())?;
            let r = crate::external::transcribe(&f, None, lang.as_deref(), false);
            let _ = std::fs::remove_file(&f);
            let words = r?.iter().filter_map(|x| x["text"].as_str()).map(str::trim).filter(|t| !t.is_empty() && !t.starts_with('[') && !t.starts_with('(')).collect::<Vec<_>>().join(" ");
            if words.is_empty() { return Err("Nothing was heard.".to_string()); }
            Ok(json!({ "text": words }))
        }).await.map_err(|e| e.to_string())?;
    }
    let (kid, key) = key_ids.iter().find_map(|id| crate::ai::key_of(id).map(|k| (id.clone(), k))).ok_or("No key saved for this speech provider (Settings › Speech recognition).")?;
    // a speech provider's key goes only to that provider's own server, whatever address the page names
    let own = match kid.as_str() { "speech-groq" => Some("https://api.groq.com"), "speech-openai" => Some("https://api.openai.com"), "speech-mistral" => Some("https://api.mistral.ai"), _ => None };
    if let Some(o) = own { if crate::ai::server_of(&base) != o { return Err("that key belongs to another server".into()); } }
    // the key only goes to the server it was first used with (as the assistant's keys)
    crate::ai::key_may_go(&kid, &base)?;
    let boundary = format!("----leonote{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(7));
    let body = multipart(&boundary, &bytes, &mime, ext, &model, lang.as_deref().unwrap_or(""), prompt.as_deref().unwrap_or(""));
    let url = format!("{}/audio/transcriptions", base.trim_end_matches('/'));
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(12)).timeout_read(Duration::from_secs(90)).build();
        let res = agent
            .post(&url)
            .set("Authorization", &format!("Bearer {}", key))
            .set("Content-Type", &format!("multipart/form-data; boundary={}", boundary))
            .send_bytes(&body);
        let text = match res {
            Ok(r) => r.into_string().map_err(|e| e.to_string())?,
            Err(ureq::Error::Status(code, r)) => {
                let body = r.into_string().unwrap_or_default();
                let said = serde_json::from_str::<Value>(&body).ok().and_then(|v| v.pointer("/error/message").or_else(|| v.get("message")).and_then(|m| m.as_str().map(String::from))).unwrap_or_else(|| body.chars().take(200).collect());
                return Err(match code { 401 | 403 => format!("The provider did not accept the key ({}).", said), 429 => "The provider says slow down, or the account is out of credit.".to_string(), _ => format!("The provider refused ({}): {}", code, said) });
            }
            Err(e) => return Err(format!("No answer from the provider: {}", e)),
        };
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let words = v.get("text").and_then(|t| t.as_str()).map(|s| s.trim().to_string()).unwrap_or_else(|| text.trim().to_string());
        if words.is_empty() { return Err("Nothing was heard.".into()); }
        Ok(json!({ "text": words }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn body_has_every_part() {
        let b = super::multipart("XX", b"abc", "audio/webm", "webm", "whisper-large-v3-turbo", "uk", "");
        let s = String::from_utf8_lossy(&b);
        assert!(s.starts_with("--XX\r\nContent-Disposition: form-data; name=\"file\"; filename=\"clip.webm\"\r\nContent-Type: audio/webm\r\n\r\nabc\r\n"));
        assert!(s.contains("name=\"model\"\r\n\r\nwhisper-large-v3-turbo\r\n"));
        assert!(s.contains("name=\"language\"\r\n\r\nuk\r\n"));
        assert!(!s.contains("name=\"prompt\""));
        assert!(s.ends_with("--XX--\r\n"));
    }
}

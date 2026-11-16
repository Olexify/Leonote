//! Speech to text through Windows' own recogniser (Windows.Media
//! .SpeechRecognition): the page's Web Speech API has no service behind it
//! in WebView2 and reports "not-allowed" whatever the permission. One call
//! listens until the sentence ends and hands the words back. It needs a
//! speech language installed in Windows (Settings › Time & language ›
//! Speech) and, for free dictation, "Online speech recognition" allowed
//! under Privacy › Speech.

#[cfg(windows)]
#[tauri::command]
pub async fn voice_listen() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        use windows::Media::SpeechRecognition::{SpeechRecognitionResultStatus, SpeechRecognizer};
        use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
        unsafe { let _ = RoInitialize(RO_INIT_MULTITHREADED); }
        let said = |e: windows_core::Error| {
            let code = e.code().0 as u32;
            match code {
                0x80045509 => "Windows wants \"Online speech recognition\" allowed first: Settings › Privacy & security › Speech.".to_string(),
                0x80045508 => "No speech language is installed: Settings › Time & language › Speech.".to_string(),
                _ => format!("Windows could not listen: {}", e.message()),
            }
        };
        let r = SpeechRecognizer::new().map_err(said)?;
        let c = r.CompileConstraintsAsync().map_err(said)?.join().map_err(said)?;
        if c.Status().map_err(said)? != SpeechRecognitionResultStatus::Success {
            return Err("The speech language could not be set up (Settings › Time & language › Speech).".into());
        }
        let res = r.RecognizeAsync().map_err(said)?.join().map_err(said)?;
        match res.Status().map_err(said)? {
            SpeechRecognitionResultStatus::Success => {
                let t = res.Text().map_err(said)?.to_string();
                if t.trim().is_empty() { Err("Nothing was heard.".into()) } else { Ok(t) }
            }
            SpeechRecognitionResultStatus::UserCanceled => Err("Cancelled.".into()),
            SpeechRecognitionResultStatus::MicrophoneUnavailable => Err("No microphone: Windows found none, or its privacy switch is off (Settings › Privacy & security › Microphone).".into()),
            SpeechRecognitionResultStatus::NetworkFailure => Err("The speech service could not be reached (dictation needs the network).".into()),
            SpeechRecognitionResultStatus::PauseLimitExceeded | SpeechRecognitionResultStatus::TimeoutExceeded => Err("Nothing was heard.".into()),
            s => Err(format!("Nothing understood ({}).", s.0)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn voice_listen() -> Result<String, String> {
    Err("Voice input is Windows-only here.".into())
}

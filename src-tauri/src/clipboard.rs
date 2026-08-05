//! Clipboard access and a short-lived history of what passed through it.
//!
//! Native clipboard work belongs to the Rust core, and the history has to be
//! collected whether or not the window is open, so a poller here samples the
//! clipboard on a timer and keeps what it sees in memory.
//!
//! History is **never persisted**: a clipboard carries whatever the user copied
//! last, credentials included, so it lives for as long as the app runs and no
//! longer. Screening for credentials happens in the sidecar
//! (`clipboard/screening.ts`) when the frontend renders history, so the pattern
//! list has one implementation rather than one per process.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::sleep;

/// How often the clipboard is sampled. Fast enough that a copy is in the palette
/// by the time the user summons it, slow enough to stay invisible.
const POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// How many past clips are kept. Beyond this the oldest are dropped.
const HISTORY_LIMIT: usize = 100;

/// Clips larger than this are ignored. History is for snippets worth reaching
/// for again; a copied document would only bloat memory and the palette list.
const MAX_TEXT_BYTES: usize = 16 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardItem {
    /// Identifies the clip for the run of the app. History is in-memory, so ids
    /// are a simple counter rather than anything that has to survive a restart.
    pub id: String,
    pub text: String,
    pub captured_at_ms: i64,
}

#[derive(Default)]
struct History {
    /// Newest first.
    items: VecDeque<ClipboardItem>,
    next_id: u64,
}

#[derive(Default)]
pub struct ClipboardState {
    history: Mutex<History>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Reads the clipboard as text. Non-text contents (an image, say) surface as an
/// error, which the poller treats as "nothing to record".
async fn read_clipboard() -> Result<String, String> {
    let output = Command::new("pbpaste")
        .output()
        .await
        .map_err(|e| format!("running pbpaste failed: {e}"))?;
    if !output.status.success() {
        return Err(format!("pbpaste exited with {}", output.status));
    }
    String::from_utf8(output.stdout).map_err(|_| "the clipboard is not utf-8 text".to_string())
}

async fn write_clipboard(text: &str) -> Result<(), String> {
    let mut child = Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawning pbcopy failed: {e}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "pbcopy stdin was unavailable".to_string())?;
    stdin
        .write_all(text.as_bytes())
        .await
        .map_err(|e| format!("writing to pbcopy failed: {e}"))?;
    // pbcopy takes the clipboard contents from stdin and only commits once the
    // pipe closes, so the handle has to be dropped before waiting on it.
    drop(stdin);
    let status = child
        .wait()
        .await
        .map_err(|e| format!("waiting for pbcopy failed: {e}"))?;
    if !status.success() {
        return Err(format!("pbcopy exited with {status}"));
    }
    Ok(())
}

impl History {
    /// Records a clip, newest first. Text already in the history is moved to the
    /// front and re-stamped rather than added twice, so copying the same snippet
    /// repeatedly (or copying it back out of the palette) doesn't fill the list
    /// with one value.
    fn record(&mut self, text: String) {
        if let Some(position) = self.items.iter().position(|item| item.text == text) {
            if let Some(mut existing) = self.items.remove(position) {
                existing.captured_at_ms = now_ms();
                self.items.push_front(existing);
            }
            return;
        }
        self.next_id += 1;
        self.items.push_front(ClipboardItem {
            id: format!("clip-{}", self.next_id),
            text,
            captured_at_ms: now_ms(),
        });
        while self.items.len() > HISTORY_LIMIT {
            self.items.pop_back();
        }
    }
}

/// Registers clipboard state and starts the poller. Call from `setup`.
pub fn init(app: &AppHandle) {
    app.manage(ClipboardState::default());
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        poller(handle).await;
    });
}

async fn poller(app: AppHandle) {
    loop {
        sleep(POLL_INTERVAL).await;
        // A read failure is routine — the clipboard may hold an image, or be
        // momentarily locked by whichever app is writing to it — so it is
        // skipped silently rather than logged every 1.5 seconds.
        let Ok(text) = read_clipboard().await else {
            continue;
        };
        if text.is_empty() || text.len() > MAX_TEXT_BYTES {
            continue;
        }
        if let Ok(mut history) = app.state::<ClipboardState>().history.lock() {
            history.record(text);
        }
    }
}

/// The clipboard history, newest first.
#[tauri::command]
pub fn clipboard_history(app: AppHandle) -> Vec<ClipboardItem> {
    match app.state::<ClipboardState>().history.lock() {
        Ok(history) => history.items.iter().cloned().collect(),
        Err(_) => Vec::new(),
    }
}

/// Drops every recorded clip. The current system clipboard is left alone — this
/// clears what Yarvis remembers, not what the user is about to paste.
#[tauri::command]
pub fn clipboard_clear_history(app: AppHandle) {
    if let Ok(mut history) = app.state::<ClipboardState>().history.lock() {
        history.items.clear();
    }
}

/// Puts text on the system clipboard. The poller picks the write up on its next
/// tick, which is what moves a copied entry to the front of the history.
#[tauri::command]
pub async fn clipboard_write(text: String) -> Result<(), String> {
    write_clipboard(&text).await
}

#[cfg(test)]
mod tests {
    use super::{History, HISTORY_LIMIT};

    #[test]
    fn records_newest_first() {
        let mut history = History::default();
        history.record("first".to_string());
        history.record("second".to_string());
        let texts: Vec<&str> = history.items.iter().map(|i| i.text.as_str()).collect();
        assert_eq!(texts, vec!["second", "first"]);
    }

    #[test]
    fn moves_a_repeat_to_the_front_instead_of_duplicating() {
        let mut history = History::default();
        history.record("first".to_string());
        history.record("second".to_string());
        history.record("first".to_string());
        let texts: Vec<&str> = history.items.iter().map(|i| i.text.as_str()).collect();
        assert_eq!(texts, vec!["first", "second"]);
    }

    #[test]
    fn drops_the_oldest_past_the_limit() {
        let mut history = History::default();
        for n in 0..HISTORY_LIMIT + 10 {
            history.record(format!("clip {n}"));
        }
        assert_eq!(history.items.len(), HISTORY_LIMIT);
        assert_eq!(
            history.items.back().map(|i| i.text.as_str()),
            Some("clip 10")
        );
    }

    #[test]
    fn gives_each_clip_a_distinct_id() {
        let mut history = History::default();
        history.record("first".to_string());
        history.record("second".to_string());
        let ids: Vec<&str> = history.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["clip-2", "clip-1"]);
    }
}

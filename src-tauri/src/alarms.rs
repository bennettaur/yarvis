//! Alarms with a full-screen takeover.
//!
//! Alarms live in the Rust core so they fire reliably even when the window is
//! hidden (the webview is throttled in the background). A scheduler task checks
//! for due alarms; when one fires it takes over the main window (fullscreen +
//! always-on-top + focus), shows a notification, plays an escalating sound, and
//! emits an event the frontend renders as a full-screen overlay.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rand::Rng;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;
use tokio::time::sleep;

/// Seconds after firing before the alert escalates (more frequent, louder).
const ESCALATE_AFTER_SECS: i64 = 60;
const SCHEDULER_TICK: Duration = Duration::from_secs(1);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alarm {
    pub id: String,
    pub label: String,
    pub fire_at_ms: i64,
    #[serde(default = "default_true")]
    pub sound: bool,
    /// Join URL for a meeting-derived alarm, so the takeover can offer a
    /// "Join meeting" action. Absent for manually created alarms.
    #[serde(default)]
    pub meet_link: Option<String>,
    /// "scheduled" | "fired" | "acknowledged" | "cancelled"
    pub status: String,
}

fn default_true() -> bool {
    true
}

pub struct AlarmState {
    alarms: Mutex<Vec<Alarm>>,
    path: PathBuf,
    /// Stop signals for currently-ringing alarms, keyed by alarm id.
    stops: Mutex<HashMap<String, Arc<Notify>>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn random_id() -> String {
    let mut bytes = [0u8; 8];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl AlarmState {
    fn load(path: PathBuf) -> Self {
        let alarms = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<Alarm>>(&s).ok())
            .unwrap_or_default();
        Self {
            alarms: Mutex::new(alarms),
            path,
            stops: Mutex::new(HashMap::new()),
        }
    }

    fn save(&self) {
        if let Ok(alarms) = self.alarms.lock() {
            if let Ok(json) = serde_json::to_string_pretty(&*alarms) {
                // Atomic write: serialize to a sibling file then rename over the
                // target so a crash mid-write can't leave alarms.json truncated.
                let tmp = self.path.with_extension("json.tmp");
                if std::fs::write(&tmp, json).is_ok() {
                    let _ = std::fs::rename(&tmp, &self.path);
                }
            }
        }
    }
}

/// Initializes alarm state and starts the scheduler. Call from `setup`.
pub fn init(app: &AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    let state = AlarmState::load(dir.join("alarms.json"));
    app.manage(state);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        scheduler(handle).await;
    });
    Ok(())
}

async fn scheduler(app: AppHandle) {
    loop {
        sleep(SCHEDULER_TICK).await;
        let state = app.state::<AlarmState>();
        let now = now_ms();

        // Collect alarms that just came due, marking them fired under the lock.
        let mut due: Vec<Alarm> = Vec::new();
        if let Ok(mut alarms) = state.alarms.lock() {
            for alarm in alarms.iter_mut() {
                if alarm.status == "scheduled" && alarm.fire_at_ms <= now {
                    alarm.status = "fired".to_string();
                    due.push(alarm.clone());
                }
            }
        }
        if due.is_empty() {
            continue;
        }
        state.save();
        for alarm in due {
            fire(&app, alarm);
        }
    }
}

fn fire(app: &AppHandle, alarm: Alarm) {
    // Take over the main window on the main thread.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_fullscreen(true);
            let _ = window.set_always_on_top(true);
            let _ = window.set_focus();
        }
    });

    let _ = app.emit("alarm-fired", &alarm);
    let _ = notify(app, &alarm);

    if alarm.sound {
        let stop = Arc::new(Notify::new());
        if let Ok(mut stops) = app.state::<AlarmState>().stops.lock() {
            stops.insert(alarm.id.clone(), stop.clone());
        }
        let fired_at = now_ms();
        tauri::async_runtime::spawn(async move {
            ring_until_stopped(stop, fired_at).await;
        });
    }
}

fn notify(app: &AppHandle, alarm: &Alarm) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title("Alarm")
        .body(alarm.label.clone())
        .show()
        .map_err(|e| e.to_string())
}

/// Plays the alert sound on a loop until the stop signal fires, escalating
/// (shorter interval, higher volume) once past the escalation threshold.
async fn ring_until_stopped(stop: Arc<Notify>, fired_at: i64) {
    loop {
        let escalated = now_ms() - fired_at >= ESCALATE_AFTER_SECS * 1000;
        // afplay's failure is discarded below, so a missing sound file fails
        // silently with no fallback or log. Use only built-in macOS sounds
        // that ship across releases; Sonar.aiff is absent on current macOS,
        // which is why the escalated path uses Submarine.aiff.
        let (sound, volume, gap) = if escalated {
            (
                "/System/Library/Sounds/Submarine.aiff",
                "2",
                Duration::from_secs(2),
            )
        } else {
            (
                "/System/Library/Sounds/Ping.aiff",
                "1",
                Duration::from_secs(5),
            )
        };

        let _ = tokio::process::Command::new("afplay")
            .args(["-v", volume, sound])
            .spawn();

        tokio::select! {
            _ = stop.notified() => break,
            _ = sleep(gap) => {}
        }
    }
}

fn stop_ringing(app: &AppHandle, id: &str) {
    if let Ok(mut stops) = app.state::<AlarmState>().stops.lock() {
        if let Some(stop) = stops.remove(id) {
            stop.notify_one();
        }
    }
}

fn restore_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.set_fullscreen(false);
            let _ = window.set_always_on_top(false);
        }
    });
}

fn set_status(app: &AppHandle, id: &str, status: &str) {
    let state = app.state::<AlarmState>();
    if let Ok(mut alarms) = state.alarms.lock() {
        if let Some(alarm) = alarms.iter_mut().find(|a| a.id == id) {
            alarm.status = status.to_string();
        }
    }
    state.save();
}

// --- Commands ---

#[tauri::command]
pub fn list_alarms(state: tauri::State<'_, AlarmState>) -> Vec<Alarm> {
    state.alarms.lock().map(|a| a.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn create_alarm(
    state: tauri::State<'_, AlarmState>,
    label: String,
    fire_at_ms: i64,
    sound: Option<bool>,
    meet_link: Option<String>,
) -> Result<Alarm, String> {
    let alarm = Alarm {
        id: random_id(),
        label,
        fire_at_ms,
        sound: sound.unwrap_or(true),
        meet_link,
        status: "scheduled".to_string(),
    };
    if let Ok(mut alarms) = state.alarms.lock() {
        alarms.push(alarm.clone());
    }
    state.save();
    Ok(alarm)
}

#[tauri::command]
pub fn cancel_alarm(app: AppHandle, id: String) {
    stop_ringing(&app, &id);
    set_status(&app, &id, "cancelled");
}

#[tauri::command]
pub fn acknowledge_alarm(app: AppHandle, id: String) {
    stop_ringing(&app, &id);
    restore_window(&app);
    set_status(&app, &id, "acknowledged");
}

#[tauri::command]
pub fn snooze_alarm(app: AppHandle, id: String, minutes: i64) {
    stop_ringing(&app, &id);
    restore_window(&app);
    let state = app.state::<AlarmState>();
    if let Ok(mut alarms) = state.alarms.lock() {
        if let Some(alarm) = alarms.iter_mut().find(|a| a.id == id) {
            alarm.fire_at_ms = now_ms() + minutes * 60_000;
            alarm.status = "scheduled".to_string();
        }
    }
    state.save();
}

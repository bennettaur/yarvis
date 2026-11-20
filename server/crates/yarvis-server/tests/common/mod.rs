//! A server on a real socket with PTY sessions running `/bin/sh`, a settings
//! file and secrets store of its own, and a data dir in a temp folder.

#![allow(dead_code)]

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use yarvis_server::auth::{Scope, create_device};
use yarvis_server::config::{Config, SshAgentConfig};
use yarvis_server::pty::{PtyManager, PtyOptions};
use yarvis_server::secret_blob::{SecretBlob, Store as SecretStore};
use yarvis_server::secret_store::memory::MemoryBackend;
use yarvis_server::settings::SettingsStore;
use yarvis_server::store::Store;
use yarvis_server::{AppState, app};

/// How long a test waits for something it expects before failing. Generous,
/// since a CI runner can be much slower than a dev machine.
pub const WAIT: Duration = Duration::from_secs(15);

pub struct Server {
    pub state: AppState,
    pub addr: std::net::SocketAddr,
    pub secrets: Arc<MemoryBackend>,
    pub dir: tempfile::TempDir,
}

pub async fn serve(options: PtyOptions) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.server.data_dir = dir.path().to_path_buf();
    let mut state = AppState::new(config, Store::open_in_memory().unwrap());
    let settings = SettingsStore::new(dir.path().join("settings.json"));
    let secrets = MemoryBackend::empty();
    let blob = SecretBlob::with_store(
        SecretStore {
            label: "memory",
            backend: secrets.clone(),
        },
        settings.clone(),
    );
    state.pty = PtyManager::new(
        settings,
        blob,
        state.events.clone(),
        SshAgentConfig::default(),
        PtyOptions {
            shell: Some("/bin/sh".into()),
            ..options
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app(state.clone());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    Server {
        state,
        addr,
        secrets,
        dir,
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.state.pty.kill_all();
    }
}

pub async fn device(state: &AppState, scopes: &[Scope]) -> (String, String) {
    create_device(&state.store, "test", "token", scopes, None)
        .await
        .unwrap()
}

/// Polls `check` until it returns `Some`, failing the test after [`WAIT`].
pub async fn until<T, F, Fut>(what: &str, mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        if let Some(value) = check().await {
            return value;
        }
        if tokio::time::Instant::now() > deadline {
            panic!("timed out waiting for {what}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

//! For the PTY and control-socket tests: a server on a real socket with PTY
//! sessions running `/bin/sh` (or the shell a test names), its own settings
//! file and secrets store, and a data dir in a temp folder.

use std::sync::Arc;

use yarvis_server::auth::{Scope, create_device};
use yarvis_server::config::{Config, SshAgentConfig};
use yarvis_server::pty::{PtyManager, PtyOptions};
use yarvis_server::secret_blob::{SecretBlob, Store as SecretStore};
use yarvis_server::secret_store::memory::MemoryBackend;
use yarvis_server::settings::SettingsStore;
use yarvis_server::{AppState, app};

pub struct Server {
    pub state: AppState,
    pub addr: std::net::SocketAddr,
    pub secrets: Arc<MemoryBackend>,
    pub dir: tempfile::TempDir,
}

/// What a test server differs in.
#[derive(Default)]
pub struct Setup {
    pub pty: PtyOptions,
    pub ssh_agent: SshAgentConfig,
    /// What the secrets store holds at the start. Empty when unset.
    pub secrets: Option<Arc<MemoryBackend>>,
}

pub async fn serve(options: PtyOptions) -> Server {
    serve_with(Setup {
        pty: options,
        ..Setup::default()
    })
    .await
}

pub async fn serve_with(setup: Setup) -> Server {
    let options = setup.pty;
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.server.data_dir = dir.path().to_path_buf();
    config.ssh_agent = setup.ssh_agent;
    let mut state = AppState::new(config, yarvis_server::store::testing::store().await);
    let settings = SettingsStore::new(dir.path().join("settings.json"));
    let secrets = setup.secrets.unwrap_or_else(MemoryBackend::empty);
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
        state.config.ssh_agent.clone(),
        PtyOptions {
            shell: options.shell.clone().or_else(|| Some("/bin/sh".into())),
            ..options
        },
    );
    state.pty.set_sidecar_env(Some(state.sidecar.session_env()));
    state
        .pty
        .set_server_ssh_agent(yarvis_server::ssh_agent::socket_path(&state));
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

impl Server {
    /// Writes the server's `settings.json`, which it re-reads on every use.
    pub fn write_settings(&self, settings: serde_json::Value) {
        std::fs::write(self.dir.path().join("settings.json"), settings.to_string()).unwrap();
    }
}

pub async fn device(state: &AppState, scopes: &[Scope]) -> (String, String) {
    create_device(&state.store, "test", "token", scopes, None)
        .await
        .unwrap()
}

//! Shared by the integration tests: an app on an in-memory store, requests
//! through `oneshot`, and the account's setup and sign-in, with TOTP codes
//! computed from the secret setup returns.

#![allow(dead_code)]

pub mod git;
pub mod pty;

use std::future::Future;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use yarvis_server::auth::totp;
use yarvis_server::config::Config;
use yarvis_server::rate_limit::RateLimiter;
use yarvis_server::store::Store;
use yarvis_server::{AppState, app};

/// The default config's origin.
pub const ORIGIN: &str = "http://localhost:7878";

/// The passphrase [`Harness::setup`] signs up with.
pub const PASSPHRASE: &str = "correct horse battery staple";

pub struct Harness {
    pub state: AppState,
    pub setup_code: String,
    /// The TOTP secret, once setup has run.
    pub totp_secret: Mutex<Option<Vec<u8>>>,
    /// The backup codes setup returned.
    pub backup_codes: Mutex<Vec<String>>,
}

impl Harness {
    pub async fn new() -> Self {
        Self::on(Store::open_in_memory().unwrap()).await
    }

    /// Every request a test builds shares one rate-limit budget (no peer
    /// address), so the harness lifts the limit. `with_default_limit` keeps it.
    pub async fn on(store: Store) -> Self {
        let mut harness = Self::with_default_limit(store).await;
        harness.state.auth_limiter = RateLimiter::new(100_000, Duration::from_secs(60));
        harness
    }

    pub async fn with_default_limit(store: Store) -> Self {
        Self::build(Config::default(), store).await
    }

    /// An app on `config`, with the rate limit lifted as in [`Harness::on`].
    pub async fn with_config(config: Config) -> Self {
        let mut harness = Self::build(config, Store::open_in_memory().unwrap()).await;
        harness.state.auth_limiter = RateLimiter::new(100_000, Duration::from_secs(60));
        harness
    }

    async fn build(config: Config, store: Store) -> Self {
        let state = AppState::new(config, store);
        let setup_code = state
            .account
            .issue_setup_code_if_needed(None)
            .await
            .unwrap()
            .unwrap_or_default();
        Self {
            state,
            setup_code,
            totp_secret: Mutex::default(),
            backup_codes: Mutex::default(),
        }
    }

    pub async fn call(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header("host", "localhost");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let body = body.map_or_else(Body::empty, |b| Body::from(b.to_string()));
        let response = app(self.state.clone())
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Starts setup with the setup code and [`PASSPHRASE`]. Returns the
    /// enrollment body.
    pub async fn start_setup(&self) -> Value {
        let (status, body) = self
            .call(
                "POST",
                "/api/auth/setup/start",
                None,
                Some(json!({
                    "code": self.setup_code,
                    "passphrase": PASSPHRASE,
                    "deviceName": "laptop",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    /// Runs setup to the end. Returns the first device's token.
    pub async fn setup(&self) -> String {
        let enrollment = self.start_setup().await;
        let secret = base32_decode(enrollment["secret"].as_str().unwrap());
        let code = code_now(&secret);
        let (status, body) = self
            .call(
                "POST",
                "/api/auth/setup/finish",
                None,
                Some(json!({ "enrollmentId": enrollment["enrollmentId"], "code": code })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        *self.totp_secret.lock().unwrap() = Some(secret);
        *self.backup_codes.lock().unwrap() = body["backupCodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c.as_str().unwrap().to_string())
            .collect();
        body["token"].as_str().unwrap().to_string()
    }

    /// A code the server will accept now. Each code is good once, and tests
    /// use several within one 30-second step, so the last accepted step is
    /// forgotten first.
    pub async fn code(&self) -> String {
        self.state
            .store
            .call(|conn| conn.execute("UPDATE account SET totp_last_step = NULL", []))
            .await
            .unwrap();
        code_now(
            self.totp_secret
                .lock()
                .unwrap()
                .as_ref()
                .expect("setup ran"),
        )
    }

    pub async fn login(&self, name: &str) -> String {
        let code = self.code().await;
        let (status, body) = self
            .call(
                "POST",
                "/api/auth/login",
                None,
                Some(json!({ "passphrase": PASSPHRASE, "code": code, "deviceName": name })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["token"].as_str().unwrap().to_string()
    }

    /// Makes `token`'s device fresh again with a code.
    pub async fn reverify(&self, token: &str) {
        let code = self.code().await;
        let (status, body) = self
            .call(
                "POST",
                "/api/auth/reverify",
                Some(token),
                Some(json!({ "code": code })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    /// Mints a token device. Returns its id and token.
    pub async fn mint(&self, by: &str, name: &str, scopes: Value) -> (String, String) {
        let (status, body) = self
            .call(
                "POST",
                "/api/devices/tokens",
                Some(by),
                Some(json!({ "name": name, "scopes": scopes })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        (
            body["device"]["deviceId"].as_str().unwrap().to_string(),
            body["token"].as_str().unwrap().to_string(),
        )
    }

    pub async fn device_id(&self, token: &str) -> String {
        let (_, me) = self.call("GET", "/api/devices/me", Some(token), None).await;
        me["deviceId"].as_str().unwrap().to_string()
    }

    /// Serves the app on a loopback port, for WebSocket tests.
    pub async fn serve(&self) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = app(self.state.clone());
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap()
        });
        addr
    }

    pub async fn events(&self, kind: &str) -> Vec<yarvis_server::events::Event> {
        self.state
            .events
            .since(0)
            .await
            .unwrap()
            .into_iter()
            .filter(|e| e.kind == kind)
            .collect()
    }
}

/// The 6-digit code for the current 30-second step.
pub fn code_now(secret: &[u8]) -> String {
    let step = totp::step_at(yarvis_server::store::now_ms());
    format!("{:06}", totp::code_at(secret, step, totp::DIGITS))
}

/// RFC 4648 base32, as setup returns the secret.
pub fn base32_decode(text: &str) -> Vec<u8> {
    const ALPHABET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let (mut buffer, mut bits, mut out) = (0u32, 0u32, Vec::new());
    for c in text.chars() {
        let value = ALPHABET.find(c).expect("a base32 character") as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

/// How long a test waits for something it expects before failing. Generous,
/// since a CI runner can be much slower than a dev machine.
pub const WAIT: Duration = Duration::from_secs(15);

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
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

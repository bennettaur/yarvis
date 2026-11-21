//! Shared by the integration tests: an app on an in-memory store, requests
//! through `oneshot`, and real WebAuthn ceremonies answered by
//! webauthn-authenticator-rs's software passkey.

#![allow(dead_code)]

pub mod git;
pub mod pty;

use std::future::Future;
use std::net::SocketAddr;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_rs::prelude::{CreationChallengeResponse, RequestChallengeResponse, Url};
use yarvis_server::config::Config;
use yarvis_server::rate_limit::RateLimiter;
use yarvis_server::store::Store;
use yarvis_server::{AppState, app};

/// The default config's origin.
pub const ORIGIN: &str = "http://localhost:7878";

pub struct Harness {
    pub state: AppState,
    pub setup_code: String,
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
            .passkeys
            .issue_setup_code_if_needed(None)
            .await
            .unwrap()
            .unwrap_or_default();
        Self { state, setup_code }
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

    /// Runs a registration: start, let the authenticator answer, finish.
    pub async fn register(
        &self,
        pk: &mut SoftPasskey,
        path: &str,
        token: Option<&str>,
        start_body: Value,
    ) -> (StatusCode, Value) {
        let (status, start) = self
            .call("POST", &format!("{path}/start"), token, Some(start_body))
            .await;
        assert_eq!(status, StatusCode::OK, "{path}/start: {start}");
        let body = answer_registration(pk, &start);
        self.call("POST", &format!("{path}/finish"), token, Some(body))
            .await
    }

    /// Runs an assertion at `path` (`/api/auth/login` or `/api/auth/reverify`).
    /// `extra` is merged into the finish body.
    pub async fn assert_with(
        &self,
        pk: &mut SoftPasskey,
        path: &str,
        token: Option<&str>,
        extra: Value,
    ) -> (StatusCode, Value) {
        let (status, start) = self
            .call("POST", &format!("{path}/start"), token, None)
            .await;
        assert_eq!(status, StatusCode::OK, "{path}/start: {start}");
        let options: RequestChallengeResponse =
            serde_json::from_value(start["options"].clone()).unwrap();
        let credential = pk
            .do_authentication(Url::parse(ORIGIN).unwrap(), options)
            .unwrap();
        let mut body = json!({ "ceremonyId": start["ceremonyId"], "credential": credential });
        if let (Some(body), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
            body.extend(extra.clone());
        }
        self.call("POST", &format!("{path}/finish"), token, Some(body))
            .await
    }

    /// Registers the first passkey with the setup code. Returns the token.
    pub async fn setup(&self, pk: &mut SoftPasskey) -> String {
        let (status, body) = self
            .register(
                pk,
                "/api/auth/setup",
                None,
                json!({ "code": self.setup_code, "deviceName": "laptop" }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["token"].as_str().unwrap().to_string()
    }

    pub async fn login(&self, pk: &mut SoftPasskey, name: &str) -> String {
        let (status, body) = self
            .assert_with(pk, "/api/auth/login", None, json!({ "deviceName": name }))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["token"].as_str().unwrap().to_string()
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

pub fn answer_registration(pk: &mut SoftPasskey, start: &Value) -> Value {
    let options: CreationChallengeResponse =
        serde_json::from_value(start["options"].clone()).unwrap();
    let credential = pk
        .do_registration(Url::parse(ORIGIN).unwrap(), options)
        .unwrap();
    json!({ "ceremonyId": start["ceremonyId"], "credential": credential })
}

/// A software passkey that claims user verification, as Touch ID would.
pub fn authenticator() -> SoftPasskey {
    SoftPasskey::new(true)
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

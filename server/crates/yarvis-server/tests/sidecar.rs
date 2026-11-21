//! The sidecar proxy against a fake upstream, the core API, and the
//! supervisor against a fake sidecar command.

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite;
use tower::ServiceExt;
use yarvis_server::auth::{Scope, create_device};
use yarvis_server::config::{Config, SecretBackendKind};
use yarvis_server::secret_blob::{SecretBlob, Store as SecretStore};
use yarvis_server::secret_store::memory::MemoryBackend;
use yarvis_server::secret_store::{SecretBackend, SecretError};
use yarvis_server::settings::SettingsStore;
use yarvis_server::sidecar::{Endpoint, Sidecar, SupervisorDeps};
use yarvis_server::store::Store;
use yarvis_server::vault::Vault;
use yarvis_server::{AppState, app};

const SIDECAR_TOKEN: &str = "sidecar-token";

struct TestServer {
    state: AppState,
    dir: tempfile::TempDir,
}

/// A server whose settings live in a temp dir, whose secrets are in memory,
/// and whose sidecar is whatever listens on `port`.
fn test_server(config: Config, backend: Arc<dyn SecretBackend>, port: u16) -> TestServer {
    let dir = tempfile::tempdir().unwrap();
    let mut state = AppState::new(config, Store::open_in_memory().unwrap());
    state.settings = SettingsStore::new(dir.path().join("settings.json"));
    state.secrets = SecretBlob::with_store(
        SecretStore {
            label: "the fake store",
            backend,
        },
        state.settings.clone(),
    );
    state.sidecar = Sidecar::at(
        Endpoint {
            port,
            token: SIDECAR_TOKEN.into(),
        },
        dir.path().join("logs").join("sidecar.log"),
    );
    TestServer { state, dir }
}

/// A passkey device that checked its passkey just now, as a sign-in leaves
/// it, for the commands that need `Fresh<Admin>`.
async fn fresh_passkey_device(state: &AppState) -> String {
    let (id, token) = create_device(&state.store, "laptop", "passkey", &Scope::ALL, None)
        .await
        .unwrap();
    state
        .store
        .call(move |conn| {
            conn.execute(
                "UPDATE devices SET verified_at = ?1 WHERE id = ?2",
                rusqlite::params![yarvis_server::store::now_ms(), id],
            )
        })
        .await
        .unwrap();
    token
}

async fn token(state: &AppState, scopes: &[Scope]) -> (String, String) {
    create_device(&state.store, "test", "token", scopes, None)
        .await
        .unwrap()
}

/// A loopback port nothing listens on: bound and dropped.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Serves `router` on a free loopback port and returns the port.
async fn serve(router: Router) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    port
}

/// Echoes what the sidecar would see: method, path, query, the auth and
/// device headers, and the body.
async fn echo(headers: HeaderMap, request: Request<Body>) -> axum::Json<Value> {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let method = request.method().to_string();
    let uri = request.uri().to_string();
    let body = request.into_body().collect().await.unwrap().to_bytes();
    axum::Json(json!({
        "method": method,
        "uri": uri,
        "authorization": header("authorization"),
        "deviceId": header("x-yarvis-device-id"),
        "cookie": header("cookie"),
        "body": String::from_utf8_lossy(&body),
    }))
}

/// Runs `request` through the app, naming this server in `Host` as a browser
/// would, since the app refuses any other host.
async fn oneshot(state: &AppState, mut request: Request<Body>) -> Response {
    request
        .headers_mut()
        .insert("host", "localhost:7878".parse().unwrap());
    app(state.clone()).oneshot(request).await.unwrap()
}

/// A fake sidecar running [`echo`] on every `/api` path, counting requests.
async fn counted_echo() -> (u16, Arc<AtomicUsize>) {
    let hits = Arc::new(AtomicUsize::new(0));
    let counted = hits.clone();
    let router = Router::new().route(
        "/api/{*rest}",
        any(move |headers: HeaderMap, request: Request<Body>| {
            counted.fetch_add(1, Ordering::SeqCst);
            echo(headers, request)
        }),
    );
    (serve(router).await, hits)
}

async fn send(state: &AppState, request: Request<Body>) -> (StatusCode, Value) {
    let response = oneshot(state, request).await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn request(method: &str, path: &str, token: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn a_get_reaches_the_sidecar_with_its_token_and_the_device_id() {
    let port = serve(Router::new().route("/api/{*rest}", any(echo))).await;
    let h = test_server(Config::default(), MemoryBackend::empty(), port);
    let (device_id, device_token) = token(&h.state, &[Scope::Read]).await;

    let mut req = request(
        "GET",
        "/api/sidecar/api/chat?limit=5",
        &device_token,
        json!(null),
    );
    req.headers_mut()
        .insert("x-yarvis-device-id", "spoofed".parse().unwrap());
    req.headers_mut().insert("cookie", "a=b".parse().unwrap());
    let (status, seen) = send(&h.state, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(seen["uri"], "/api/chat?limit=5");
    assert_eq!(seen["authorization"], format!("Bearer {SIDECAR_TOKEN}"));
    assert_eq!(seen["deviceId"], device_id);
    assert!(seen["cookie"].is_null());
}

#[tokio::test]
async fn a_write_needs_the_chat_scope_and_carries_its_body() {
    let (port, hits) = counted_echo().await;
    let h = test_server(Config::default(), MemoryBackend::empty(), port);
    let (_, reader) = token(&h.state, &[Scope::Read]).await;
    let (_, chatter) = token(&h.state, &[Scope::Chat]).await;

    let (status, _) = send(
        &h.state,
        request(
            "POST",
            "/api/sidecar/api/chat",
            &reader,
            json!({"text": "hi"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(hits.load(Ordering::SeqCst), 0);

    let (status, seen) = send(
        &h.state,
        request(
            "POST",
            "/api/sidecar/api/chat",
            &chatter,
            json!({"text": "hi"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(seen["method"], "POST");
    assert_eq!(seen["body"], r#"{"text":"hi"}"#);
}

/// Saving a file into a worktree or starting a PR's setup script runs code as
/// the server's user, so a chat device can't, and the request never reaches
/// the sidecar. A terminal device can.
#[tokio::test]
async fn a_route_that_reaches_a_worktree_needs_terminal() {
    let (port, hits) = counted_echo().await;
    let h = test_server(Config::default(), MemoryBackend::empty(), port);
    let (_, chatter) = token(&h.state, &[Scope::Read, Scope::Chat, Scope::Approve]).await;
    let (_, terminal) = token(&h.state, &[Scope::Terminal]).await;
    let routes = [
        (
            "PUT",
            "/api/sidecar/api/workspaces/w1/repos/r1/file",
            json!({ "path": ".claude/settings.json", "content": "{}" }),
        ),
        (
            "POST",
            "/api/sidecar/api/review-workspaces/w1/prs/p1/setup",
            json!({ "run": true }),
        ),
        // The sidecar decodes `%77` to `w` before routing.
        (
            "PUT",
            "/api/sidecar/api/%77orkspaces/w1/repos/r1/file",
            json!({ "path": "x", "content": "" }),
        ),
        (
            "POST",
            "/api/sidecar/api/heads-down/messages",
            json!({ "text": "push the branch" }),
        ),
    ];
    for (method, path, body) in &routes {
        let (status, _) = send(&h.state, request(method, path, &chatter, body.clone())).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
    }
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    for (method, path, body) in &routes {
        let (status, _) = send(&h.state, request(method, path, &terminal, body.clone())).await;
        assert_eq!(status, StatusCode::OK, "{method} {path}");
    }
    assert_eq!(hits.load(Ordering::SeqCst), routes.len());

    // Renaming a workspace only changes its row.
    let (status, _) = send(
        &h.state,
        request(
            "PATCH",
            "/api/sidecar/api/workspaces/w1",
            &chatter,
            json!({ "name": "x" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

/// Defining an MCP server can make the sidecar run a command, so a chat
/// device can't, and the request never reaches the sidecar.
#[tokio::test]
async fn a_route_that_changes_what_the_sidecar_may_do_needs_admin() {
    let (port, hits) = counted_echo().await;
    let h = test_server(Config::default(), MemoryBackend::empty(), port);
    let (_, chatter) = token(&h.state, &[Scope::Read, Scope::Chat]).await;
    let (_, admin) = token(&h.state, &[Scope::Admin]).await;
    let server = json!({ "transport": "stdio", "command": "sh" });
    let (status, _) = send(
        &h.state,
        request(
            "POST",
            "/api/sidecar/api/mcp/servers",
            &chatter,
            server.clone(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    let (status, _) = send(
        &h.state,
        request("POST", "/api/sidecar/api/mcp/servers", &admin, server),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

/// While the supervisor has no sidecar up, its port may belong to anyone,
/// so nothing is sent there.
#[tokio::test]
async fn nothing_is_sent_while_no_sidecar_is_running() {
    let (port, hits) = counted_echo().await;
    let mut h = test_server(Config::default(), MemoryBackend::empty(), port);
    h.state.sidecar = Sidecar::new(h.dir.path()).unwrap();
    let (_, reader) = token(&h.state, &[Scope::Read]).await;
    let (status, _) = send(
        &h.state,
        request("GET", "/api/sidecar/api/status", &reader, json!(null)),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_revoked_device_loses_its_open_stream() {
    let port = serve(Router::new().route(
        "/api/stream",
        get(|| async {
            let first = futures_util::stream::once(async {
                Ok::<_, Infallible>(Bytes::from("data: one\n\n"))
            });
            let rest = futures_util::stream::pending::<Result<Bytes, Infallible>>();
            Response::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(first.chain(rest)))
                .unwrap()
        }),
    ))
    .await;
    let h = test_server(Config::default(), MemoryBackend::empty(), port);
    let (device_id, reader) = token(&h.state, &[Scope::Read]).await;
    let response = oneshot(
        &h.state,
        request("GET", "/api/sidecar/api/stream", &reader, json!(null)),
    )
    .await;
    let mut body = response.into_body();
    let first = body.frame().await.unwrap().unwrap();
    assert_eq!(first.into_data().unwrap(), "data: one\n\n");
    h.state.auth.announce_revocation(&device_id);
    let end = tokio::time::timeout(Duration::from_secs(5), body.frame())
        .await
        .expect("the stream ended once the device was revoked");
    assert!(end.is_none(), "{end:?}");
}

#[tokio::test]
async fn no_token_gets_401_and_nothing_reaches_the_sidecar() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counted = hits.clone();
    let port = serve(Router::new().route(
        "/api/{*rest}",
        any(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            async { "reached" }
        }),
    ))
    .await;
    let h = test_server(Config::default(), MemoryBackend::empty(), port);
    let req = Request::get("/api/sidecar/api/status")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send(&h.state, req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body["error"].is_string());
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn routes_outside_the_bearer_wall_are_not_proxied() {
    let port = serve(Router::new().route("/{*rest}", any(echo))).await;
    let h = test_server(Config::default(), MemoryBackend::empty(), port);
    let (_, all) = token(&h.state, &Scope::ALL).await;
    for path in [
        "/api/sidecar/mcp",
        "/api/sidecar/ingest/permission",
        "/api/sidecar/api/%2e%2e/mcp",
    ] {
        let (status, _) = send(&h.state, request("GET", path, &all, json!(null))).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn a_sidecar_that_is_down_gets_503() {
    let h = test_server(Config::default(), MemoryBackend::empty(), free_port());
    let (_, reader) = token(&h.state, &[Scope::Read]).await;
    let (status, body) = send(
        &h.state,
        request("GET", "/api/sidecar/health", &reader, json!(null)),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body["error"].as_str().unwrap().contains("sidecar"));
}

/// The upstream holds its second event until the test has read the first,
/// so the test only passes if the proxy hands each chunk on as it arrives.
#[tokio::test]
async fn sse_streams_through_without_buffering() {
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let release = Arc::new(std::sync::Mutex::new(Some(release_rx)));
    let port = serve(Router::new().route(
        "/api/stream",
        get(move || {
            let release = release.lock().unwrap().take().unwrap();
            async move {
                let first = futures_util::stream::once(async {
                    Ok::<_, Infallible>(Bytes::from("data: one\n\n"))
                });
                let second = futures_util::stream::once(async move {
                    let _ = release.await;
                    Ok::<_, Infallible>(Bytes::from("data: two\n\n"))
                });
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(Body::from_stream(first.chain(second)))
                    .unwrap()
            }
        }),
    ))
    .await;
    let h = test_server(Config::default(), MemoryBackend::empty(), port);
    let (_, reader) = token(&h.state, &[Scope::Read]).await;
    let response = oneshot(
        &h.state,
        request("GET", "/api/sidecar/api/stream", &reader, json!(null)),
    )
    .await;
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut body = response.into_body();

    let first = tokio::time::timeout(Duration::from_secs(5), body.frame())
        .await
        .expect("the first event arrived before the stream ended")
        .unwrap()
        .unwrap();
    assert_eq!(first.into_data().unwrap(), "data: one\n\n");
    release_tx.send(()).unwrap();
    let rest = body.collect().await.unwrap().to_bytes();
    assert_eq!(rest, "data: two\n\n");
}

/// A fake sidecar socket that reports the headers it was opened with, then
/// echoes every text message.
async fn ws_echo(headers: HeaderMap, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let device = headers
        .get("x-yarvis-device-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    upgrade.on_upgrade(move |mut socket| async move {
        let hello = json!({ "authorization": auth, "deviceId": device }).to_string();
        let _ = socket.send(Message::Text(hello.into())).await;
        while let Some(Ok(Message::Text(text))) = socket.recv().await {
            let _ = socket
                .send(Message::Text(format!("echo {text}").into()))
                .await;
        }
    })
}

/// A fake sidecar serving [`ws_echo`] at `/api/socket`, counting the sockets
/// opened to it.
async fn ws_upstream() -> (u16, Arc<AtomicUsize>) {
    let opened = Arc::new(AtomicUsize::new(0));
    let counted = opened.clone();
    let router = Router::new().route(
        "/api/socket",
        get(move |headers: HeaderMap, upgrade: WebSocketUpgrade| {
            counted.fetch_add(1, Ordering::SeqCst);
            ws_echo(headers, upgrade)
        }),
    );
    (serve(router).await, opened)
}

/// Opens a proxied socket and sends the auth message.
async fn open_proxied_socket(
    state: &AppState,
    token: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let server = serve(app(state.clone())).await;
    let url = format!("ws://127.0.0.1:{server}/api/sidecar/api/socket");
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let auth = json!({ "type": "auth", "token": token }).to_string();
    socket.send(tungstenite::Message::text(auth)).await.unwrap();
    socket
}

async fn next_close_code<S>(socket: &mut S) -> u16
where
    S: futures_util::Stream<Item = Result<tungstenite::Message, tungstenite::Error>> + Unpin,
{
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("a message arrived");
        match message {
            Some(Ok(tungstenite::Message::Close(Some(frame)))) => return frame.code.into(),
            Some(Ok(_)) => {}
            other => panic!("expected a close frame, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn a_revoked_device_loses_its_relayed_websocket() {
    let (upstream, _) = ws_upstream().await;
    let h = test_server(Config::default(), MemoryBackend::empty(), upstream);
    let (device_id, chatter) = token(&h.state, &[Scope::Chat]).await;
    let (other_id, _) = token(&h.state, &[Scope::Chat]).await;
    let mut socket = open_proxied_socket(&h.state, &chatter).await;
    next_text(&mut socket).await;

    h.state.auth.announce_revocation(&other_id);
    socket
        .send(tungstenite::Message::text("still here"))
        .await
        .unwrap();
    assert_eq!(next_text(&mut socket).await, "echo still here");

    h.state.auth.announce_revocation(&device_id);
    assert_eq!(next_close_code(&mut socket).await, 4401);
}

#[tokio::test]
async fn a_websocket_with_a_bad_token_or_no_sidecar_is_closed() {
    let (upstream, opened) = ws_upstream().await;
    let h = test_server(Config::default(), MemoryBackend::empty(), upstream);
    let mut socket = open_proxied_socket(&h.state, "not-a-token").await;
    assert_eq!(next_close_code(&mut socket).await, 4401);
    assert_eq!(opened.load(Ordering::SeqCst), 0);

    // Bound and dropped, so nothing listens there.
    let down = test_server(Config::default(), MemoryBackend::empty(), free_port());
    let (_, chatter) = token(&down.state, &[Scope::Chat]).await;
    let mut socket = open_proxied_socket(&down.state, &chatter).await;
    assert_eq!(next_close_code(&mut socket).await, 1011);
}

#[tokio::test]
async fn a_websocket_is_authenticated_by_its_first_message_and_relayed() {
    let upstream = serve(Router::new().route("/api/socket", get(ws_echo))).await;
    let h = test_server(Config::default(), MemoryBackend::empty(), upstream);
    let (device_id, chatter) = token(&h.state, &[Scope::Chat]).await;
    let server = serve(app(h.state.clone())).await;

    let url = format!("ws://127.0.0.1:{server}/api/sidecar/api/socket");
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let auth = json!({ "type": "auth", "token": chatter }).to_string();
    socket.send(tungstenite::Message::text(auth)).await.unwrap();

    let hello = next_text(&mut socket).await;
    let hello: Value = serde_json::from_str(&hello).unwrap();
    assert_eq!(hello["authorization"], format!("Bearer {SIDECAR_TOKEN}"));
    assert_eq!(hello["deviceId"], device_id);

    socket
        .send(tungstenite::Message::text("ping"))
        .await
        .unwrap();
    assert_eq!(next_text(&mut socket).await, "echo ping");
}

#[tokio::test]
async fn a_websocket_from_a_read_only_device_is_closed_before_the_sidecar_is_reached() {
    let (upstream, opened) = ws_upstream().await;
    let h = test_server(Config::default(), MemoryBackend::empty(), upstream);
    let (_, reader) = token(&h.state, &[Scope::Read]).await;
    let mut socket = open_proxied_socket(&h.state, &reader).await;
    assert_eq!(next_close_code(&mut socket).await, 4403);
    assert_eq!(opened.load(Ordering::SeqCst), 0);
}

async fn next_text<S>(socket: &mut S) -> String
where
    S: futures_util::Stream<Item = Result<tungstenite::Message, tungstenite::Error>> + Unpin,
{
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("a message arrived")
            .expect("the socket is open")
            .unwrap();
        if let tungstenite::Message::Text(text) = message {
            return text.to_string();
        }
    }
}

#[tokio::test]
async fn secrets_are_written_by_admins_and_only_their_presence_is_read_back() {
    let backend = MemoryBackend::empty();
    let h = test_server(Config::default(), backend.clone(), 1);
    let (_, admin) = token(&h.state, &[Scope::Read, Scope::Admin]).await;
    let (_, reader) = token(&h.state, &[Scope::Read]).await;

    let set = json!({ "key": "github_token", "value": "gho_secret" });
    let (status, _) = send(
        &h.state,
        request("POST", "/api/core/set_secret", &reader, set.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(backend.writes().is_empty());

    let (status, _) = send(
        &h.state,
        request("POST", "/api/core/set_secret", &admin, set),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, listed) = send(
        &h.state,
        request("POST", "/api/core/list_secret_status", &reader, json!(null)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let github = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["key"] == "github_token")
        .unwrap();
    assert_eq!(github["present"], true);
    assert!(!listed.to_string().contains("gho_secret"));
}

#[tokio::test]
async fn an_unknown_secret_key_is_a_400_naming_it() {
    let h = test_server(Config::default(), MemoryBackend::empty(), 1);
    let (_, admin) = token(&h.state, &[Scope::Admin]).await;
    let (status, body) = send(
        &h.state,
        request(
            "POST",
            "/api/core/set_secret",
            &admin,
            json!({ "key": "mcpServers", "value": "x" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("mcpServers"));
}

#[tokio::test]
async fn settings_round_trip_in_the_frontends_shape() {
    let h = test_server(Config::default(), MemoryBackend::empty(), 1);
    let (_, admin) = token(&h.state, &[Scope::Read, Scope::Admin]).await;

    let (status, view) = send(
        &h.state,
        request(
            "POST",
            "/api/core/set_agent",
            &admin,
            json!({ "name": "Codex", "command": "codex --yolo" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["agentCommand"], "codex --yolo");
    assert!(view["defaultMaxPtySessions"].is_number());

    let (status, body) = send(
        &h.state,
        request(
            "POST",
            "/api/core/set_max_pty_sessions",
            &admin,
            json!({ "value": 0 }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("at least 1"));

    // `get_settings` takes no arguments, so an empty body is fine.
    let req = Request::post("/api/core/get_settings")
        .header("Authorization", format!("Bearer {admin}"))
        .body(Body::empty())
        .unwrap();
    let (status, view) = send(&h.state, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["agentName"], "Codex");
    let on_disk: Value =
        serde_json::from_str(&std::fs::read_to_string(h.dir.path().join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(on_disk["agentName"], "Codex");
}

#[tokio::test]
async fn switching_to_a_backend_server_toml_did_not_choose_is_a_409() {
    let mut config = Config::default();
    config.secrets.backend = Some(SecretBackendKind::Keychain);
    let h = test_server(config, MemoryBackend::empty(), 1);
    let admin = fresh_passkey_device(&h.state).await;
    let (status, body) = send(
        &h.state,
        request(
            "POST",
            "/api/core/set_secret_backend",
            &admin,
            json!({ "backend": "onepassword", "vault": "Private", "item": "Yarvis" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body["error"].as_str().unwrap().contains("server.toml"));
}

#[tokio::test]
async fn an_unknown_or_client_local_command_is_a_404() {
    let h = test_server(Config::default(), MemoryBackend::empty(), 1);
    let (_, all) = token(&h.state, &Scope::ALL).await;
    for command in ["get_sidecar_info", "focus_main_window", "nope"] {
        let (status, _) = send(
            &h.state,
            request("POST", &format!("/api/core/{command}"), &all, json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{command}");
    }
}

#[tokio::test]
async fn the_web_ui_is_served_with_a_fallback_to_index_but_not_under_api() {
    let web = tempfile::tempdir().unwrap();
    std::fs::write(web.path().join("index.html"), "<html>app</html>").unwrap();
    std::fs::create_dir(web.path().join("assets")).unwrap();
    std::fs::write(web.path().join("assets").join("app.js"), "js").unwrap();
    let mut config = Config::default();
    config.server.web_dir = Some(web.path().to_path_buf());
    let h = test_server(config, MemoryBackend::empty(), 1);

    let body = |path: &str| {
        let state = h.state.clone();
        let path = path.to_string();
        async move {
            let response = oneshot(&state, Request::get(path).body(Body::empty()).unwrap()).await;
            let status = response.status();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            (status, String::from_utf8_lossy(&bytes).into_owned())
        }
    };
    assert_eq!(body("/assets/app.js").await, (StatusCode::OK, "js".into()));
    assert_eq!(
        body("/settings/devices").await,
        (StatusCode::OK, "<html>app</html>".into())
    );
    let (status, text) = body("/api/nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(text.contains("\"error\""), "{text}");
}

#[tokio::test]
async fn with_no_web_dir_every_other_path_is_a_json_404() {
    let h = test_server(Config::default(), MemoryBackend::empty(), 1);
    let (status, body) = send(
        &h.state,
        Request::get("/settings").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body["error"].is_string());
}

/// A backend that fails until told otherwise, counting its reads.
#[derive(Default)]
struct Locked {
    open: AtomicBool,
    reads: AtomicUsize,
}

impl SecretBackend for Locked {
    fn read_root(&self) -> Result<Option<String>, SecretError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.open.load(Ordering::SeqCst) {
            Ok(Some(r#"{"anthropic_api_key":"sk-test"}"#.into()))
        } else {
            Err(SecretError::Locked)
        }
    }

    fn write_root(&self, _blob: &str) -> Result<(), SecretError> {
        Err(SecretError::Locked)
    }
}

async fn until(what: &str, mut check: impl AsyncFnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !check().await {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn kinds(state: &AppState) -> Vec<String> {
    state
        .events
        .since(0)
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.kind)
        .collect()
}

/// The fake sidecar writes the variables the test checks to a file, under a
/// temp name first so the test never reads it half-written, then waits.
#[tokio::test]
async fn the_supervisor_waits_for_the_secrets_then_starts_and_restarts_the_sidecar() {
    let locked = Arc::new(Locked::default());
    let dir = tempfile::tempdir().unwrap();
    let env_file = dir.path().join("env");
    let script = format!(
        "echo booted; printf '%s\\n%s\\n' \"$ANTHROPIC_API_KEY\" \"$YARVIS_SIDECAR_TOKEN\" > '{0}.tmp' && mv '{0}.tmp' '{0}'; exec sleep 30",
        env_file.display()
    );
    let mut config = Config::default();
    config.sidecar.command = Some(vec!["sh".into(), "-c".into(), script]);
    config.secrets.backend = Some(SecretBackendKind::Keychain);
    let h = test_server(config, locked.clone(), 1);
    let deps = SupervisorDeps {
        config: h.state.config.clone(),
        settings: h.state.settings.clone(),
        secrets: h.state.secrets.clone(),
        events: h.state.events.clone(),
        vault_unlocked: None,
    };
    let supervisor = tokio::spawn(h.state.sidecar.clone().supervise(deps));

    // A second failed read means the first one was handled by waiting, not
    // by starting anyway. The restart request skips the retry delay.
    until("a failed secrets read", async || {
        locked.reads.load(Ordering::SeqCst) > 0
    })
    .await;
    h.state.sidecar.restart();
    until("a second failed read", async || {
        locked.reads.load(Ordering::SeqCst) > 1
    })
    .await;
    assert!(
        kinds(&h.state).await.is_empty(),
        "started without its secrets"
    );
    assert!(!env_file.exists(), "started without its secrets");

    locked.open.store(true, Ordering::SeqCst);
    h.state.sidecar.restart();
    until("sidecar.started", async || {
        kinds(&h.state)
            .await
            .contains(&"sidecar.started".to_string())
    })
    .await;
    until("the env file", async || env_file.exists()).await;
    let env = std::fs::read_to_string(&env_file).unwrap();
    assert_eq!(env, format!("sk-test\n{SIDECAR_TOKEN}\n"));
    until("the log line", async || {
        std::fs::read_to_string(h.state.sidecar.log_path()).is_ok_and(|log| log.contains("booted"))
    })
    .await;

    h.state.sidecar.restart();
    until("a second start", async || {
        kinds(&h.state).await == ["sidecar.started", "sidecar.stopped", "sidecar.started"]
    })
    .await;
    let stopped = h.state.events.since(0).await.unwrap()[1].clone();
    assert_eq!(stopped.data["reason"], "restart");
    assert_eq!(stopped.device_id, None);
    supervisor.abort();
}

/// A sidecar that dies on its own is started again, and the stop records why.
#[tokio::test]
async fn a_sidecar_that_exits_is_restarted() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("ran-once");
    let script = format!(
        "if [ -f '{0}' ]; then exec sleep 30; else touch '{0}'; exit 3; fi",
        marker.display()
    );
    let mut config = Config::default();
    config.sidecar.command = Some(vec!["sh".into(), "-c".into(), script]);
    let h = test_server(config, MemoryBackend::empty(), 1);
    let deps = SupervisorDeps {
        config: h.state.config.clone(),
        settings: h.state.settings.clone(),
        secrets: h.state.secrets.clone(),
        events: h.state.events.clone(),
        vault_unlocked: None,
    };
    let supervisor = tokio::spawn(h.state.sidecar.clone().supervise(deps));
    until("a restart after the exit", async || {
        kinds(&h.state).await == ["sidecar.started", "sidecar.stopped", "sidecar.started"]
    })
    .await;
    let stopped = h.state.events.since(0).await.unwrap()[1].clone();
    assert_eq!(stopped.data, json!({ "reason": "exited", "code": 3 }));
    supervisor.abort();
}

/// The server stops by dropping the supervisor, which must take the sidecar
/// with it rather than leave it running.
#[tokio::test]
async fn stopping_the_supervisor_kills_the_sidecar() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let script = format!(
        "echo $$ > '{0}.tmp' && mv '{0}.tmp' '{0}'; exec sleep 30",
        pid_file.display()
    );
    let mut config = Config::default();
    config.sidecar.command = Some(vec!["sh".into(), "-c".into(), script]);
    let h = test_server(config, MemoryBackend::empty(), 1);
    let deps = SupervisorDeps {
        config: h.state.config.clone(),
        settings: h.state.settings.clone(),
        secrets: h.state.secrets.clone(),
        events: h.state.events.clone(),
        vault_unlocked: None,
    };
    let supervisor = tokio::spawn(h.state.sidecar.clone().supervise(deps));
    until("the pid file", async || pid_file.exists()).await;
    let pid = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .to_string();
    let alive = |pid: &str| {
        std::process::Command::new("kill")
            .args(["-0", pid])
            .status()
            .unwrap()
            .success()
    };
    assert!(alive(&pid));
    supervisor.abort();
    let _ = supervisor.await;
    until("the sidecar to exit", async || !alive(&pid)).await;
}

/// With the vault backend, the sidecar starts when the vault unlocks, with no
/// restart request or retry delay, and stops when it locks.
#[tokio::test]
async fn the_sidecar_follows_the_vault_lock() {
    let dir = tempfile::tempdir().unwrap();
    let created = Vault::init(dir.path(), false).unwrap();
    let mut config = Config::default();
    config.server.data_dir = dir.path().to_path_buf();
    config.secrets.backend = Some(SecretBackendKind::Vault);
    config.sidecar.command = Some(vec!["sh".into(), "-c".into(), "exec sleep 30".into()]);
    let mut state = AppState::new(config, Store::open_in_memory().unwrap());
    state.settings = SettingsStore::new(dir.path().join("settings.json"));
    state.secrets = SecretBlob::from_config(
        Some(SecretBackendKind::Vault),
        state.settings.clone(),
        &state.vault,
    );
    let deps = SupervisorDeps {
        config: state.config.clone(),
        settings: state.settings.clone(),
        secrets: state.secrets.clone(),
        events: state.events.clone(),
        vault_unlocked: Some(state.vault.subscribe()),
    };
    let supervisor = tokio::spawn(state.sidecar.clone().supervise(deps));

    state
        .vault
        .unlock_with_recovery(&created.recovery_key)
        .unwrap();
    until("sidecar.started", async || {
        kinds(&state).await == ["sidecar.started"]
    })
    .await;

    state.vault.lock();
    until("sidecar.stopped", async || {
        kinds(&state).await == ["sidecar.started", "sidecar.stopped"]
    })
    .await;
    let stopped = state.events.since(0).await.unwrap()[1].clone();
    assert_eq!(stopped.data["reason"], "vault.locked");

    state
        .vault
        .unlock_with_recovery(&created.recovery_key)
        .unwrap();
    // Well inside the supervisor's 5-second retry, so only the unlock can
    // have started it.
    tokio::time::timeout(
        Duration::from_secs(2),
        until("a start after the second unlock", async || {
            kinds(&state).await.len() == 3
        }),
    )
    .await
    .expect("the unlock didn't start the sidecar; it waited out the retry");
    supervisor.abort();
}

//! The `/api/events` WebSocket over a real socket: auth, catch-up, live
//! events, and revocation.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use yarvis_server::auth::{Scope, create_device};
use yarvis_server::config::Config;
use yarvis_server::store::Store;
use yarvis_server::{AppState, app};

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn serve() -> (AppState, String) {
    let state = AppState::new(Config::default(), Store::open_in_memory().unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app(state.clone());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (state, format!("ws://{addr}/api/events"))
}

async fn connect(url: &str, hello: Value) -> Socket {
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    socket
        .send(Message::Text(hello.to_string().into()))
        .await
        .unwrap();
    socket
}

/// The next message, failing the test if none comes within a few seconds.
async fn next(socket: &mut Socket) -> Message {
    tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("no message in time")
        .expect("socket ended")
        .expect("socket error")
}

async fn next_json(socket: &mut Socket) -> Value {
    match next(socket).await {
        Message::Text(text) => serde_json::from_str(&text).unwrap(),
        other => panic!("expected text, got {other:?}"),
    }
}

async fn close_code(socket: &mut Socket) -> u16 {
    match next(socket).await {
        Message::Close(Some(frame)) => u16::from(frame.code),
        other => panic!("expected a close frame, got {other:?}"),
    }
}

async fn device(state: &AppState, scopes: &[Scope]) -> (String, String) {
    create_device(&state.store, "test", "token", scopes, None)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_socket_with_no_auth_message_is_closed_as_unauthorized() {
    let (_, url) = serve().await;
    let mut socket = connect(&url, json!({"type": "hello"})).await;
    assert_eq!(close_code(&mut socket).await, 4401);
}

#[tokio::test]
async fn an_unknown_token_is_closed_as_unauthorized() {
    let (_, url) = serve().await;
    let mut socket = connect(&url, json!({"type": "auth", "token": "AAAA"})).await;
    assert_eq!(close_code(&mut socket).await, 4401);
}

#[tokio::test]
async fn a_device_without_read_is_closed_as_forbidden() {
    let (state, url) = serve().await;
    let (_, token) = device(&state, &[Scope::Chat]).await;
    let mut socket = connect(&url, json!({"type": "auth", "token": token})).await;
    assert_eq!(close_code(&mut socket).await, 4403);
}

#[tokio::test]
async fn a_malformed_since_is_refused_rather_than_ignored() {
    let (state, url) = serve().await;
    let (_, token) = device(&state, &[Scope::Read]).await;
    let mut socket = connect(&url, json!({"type": "auth", "token": token, "since": "5"})).await;
    assert_eq!(close_code(&mut socket).await, 4400);
}

#[tokio::test]
async fn catch_up_sends_the_backlog_then_live_events_in_the_documented_shape() {
    let (state, url) = serve().await;
    let (_, token) = device(&state, &[Scope::Read]).await;
    let first = state
        .events
        .append(Some("d1"), "a", json!({}))
        .await
        .unwrap();
    state
        .events
        .append(None, "b", json!({"x": 1}))
        .await
        .unwrap();

    let mut socket = connect(
        &url,
        json!({"type": "auth", "token": token, "since": first.seq}),
    )
    .await;
    let backlog = next_json(&mut socket).await;
    assert_eq!(backlog["type"], "event");
    assert_eq!(backlog["kind"], "b");
    assert_eq!(backlog["deviceId"], Value::Null);
    assert_eq!(backlog["data"], json!({"x": 1}));
    assert!(backlog["at"].as_i64().unwrap() > 0);

    // The socket subscribes before it reads the backlog, so an event
    // appended after the backlog arrived must come through live.
    state
        .events
        .append(Some("d2"), "c", json!({}))
        .await
        .unwrap();
    let live = next_json(&mut socket).await;
    assert_eq!(live["kind"], "c");
    assert_eq!(live["seq"], backlog["seq"].as_i64().unwrap() + 1);
}

#[tokio::test]
async fn a_client_too_far_behind_is_told_to_reload() {
    let (state, url) = serve().await;
    let (_, token) = device(&state, &[Scope::Read]).await;
    for _ in 0..1000 {
        state.events.append(None, "x", json!({})).await.unwrap();
    }
    let mut socket = connect(&url, json!({"type": "auth", "token": token, "since": 0})).await;
    assert_eq!(next_json(&mut socket).await, json!({"type": "lagged"}));
}

#[tokio::test]
async fn revoking_a_device_closes_its_socket_and_leaves_others_open() {
    let (state, url) = serve().await;
    let (phone, phone_token) = device(&state, &[Scope::Read]).await;
    let (_, laptop_token) = device(&state, &[Scope::Read]).await;
    // `since: 0` makes the ping arrive whether it lands before or after the
    // socket subscribes, and seeing it proves the socket finished
    // authenticating before the revocation goes out.
    let mut phone_socket = connect(
        &url,
        json!({"type": "auth", "token": phone_token, "since": 0}),
    )
    .await;
    let mut laptop_socket = connect(
        &url,
        json!({"type": "auth", "token": laptop_token, "since": 0}),
    )
    .await;

    state.events.append(None, "ping", json!({})).await.unwrap();
    assert_eq!(next_json(&mut phone_socket).await["kind"], "ping");
    assert_eq!(next_json(&mut laptop_socket).await["kind"], "ping");

    state.auth.announce_revocation(&phone);
    assert_eq!(close_code(&mut phone_socket).await, 4401);

    state.events.append(None, "after", json!({})).await.unwrap();
    assert_eq!(next_json(&mut laptop_socket).await["kind"], "after");
}

#[tokio::test]
async fn concurrent_appends_reach_clients_in_seq_order() {
    let (state, url) = serve().await;
    let (_, token) = device(&state, &[Scope::Read]).await;
    let mut socket = connect(&url, json!({"type": "auth", "token": token, "since": 0})).await;
    state.events.append(None, "ready", json!({})).await.unwrap();
    assert_eq!(next_json(&mut socket).await["kind"], "ready");

    let appends = (0..50).map(|i| {
        let events = state.events.clone();
        tokio::spawn(async move { events.append(None, "n", json!({ "i": i })).await })
    });
    for append in appends {
        append.await.unwrap().unwrap();
    }
    let mut last = 0;
    for _ in 0..50 {
        let seq = next_json(&mut socket).await["seq"].as_i64().unwrap();
        assert!(seq > last, "{seq} arrived after {last}");
        last = seq;
    }
}

#[test]
fn close_codes_are_in_the_private_range() {
    // Guards against a rename in tungstenite turning these into reserved codes.
    assert!(matches!(CloseCode::from(4401), CloseCode::Library(4401)));
}

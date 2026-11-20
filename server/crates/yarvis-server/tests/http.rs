use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use yarvis_server::auth::{Scope, create_device};
use yarvis_server::config::Config;
use yarvis_server::store::Store;
use yarvis_server::{AppState, app};

async fn get(state: &AppState, path: &str, token: Option<&str>) -> (StatusCode, serde_json::Value) {
    let mut request = Request::get(path);
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let response = app(state.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

fn state() -> AppState {
    AppState::new(Config::default(), Store::open_in_memory().unwrap())
}

#[tokio::test]
async fn health_needs_no_token() {
    let (status, body) = get(&state(), "/api/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn a_request_with_no_token_gets_401_in_the_shared_error_shape() {
    let (status, body) = get(&state(), "/api/devices/me", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn a_device_without_the_scope_gets_403() {
    let state = state();
    let (_, token) = create_device(&state.store, "bot", "token", &[Scope::Chat], None)
        .await
        .unwrap();
    let (status, body) = get(&state, "/api/devices/me", Some(&token)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body["error"].as_str().unwrap().contains("read"));
}

#[tokio::test]
async fn a_device_sees_itself() {
    let state = state();
    let (id, token) = create_device(&state.store, "laptop", "token", &[Scope::Read], None)
        .await
        .unwrap();
    let (status, body) = get(&state, "/api/devices/me", Some(&token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deviceId"], id);
    assert_eq!(body["scopes"], serde_json::json!(["read"]));
}

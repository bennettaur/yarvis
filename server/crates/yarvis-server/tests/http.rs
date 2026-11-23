use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use yarvis_server::auth::{Scope, create_device};
use yarvis_server::config::Config;
use yarvis_server::{AppState, app};

async fn get(state: &AppState, path: &str, token: Option<&str>) -> (StatusCode, serde_json::Value) {
    let mut request = Request::get(path).header("Host", "localhost:7878");
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

async fn state() -> AppState {
    AppState::new(
        Config::default(),
        yarvis_server::store::testing::store().await,
    )
}

#[tokio::test]
async fn health_needs_no_token() {
    let (status, body) = get(&state().await, "/api/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["database"], "ok");
}

/// A server whose database isn't up yet answers 503, so a client waits and
/// retries rather than treating it as signed out or set up.
#[tokio::test]
async fn before_the_database_is_ready_health_and_auth_status_answer_503() {
    let store = yarvis_server::store::Store::connect_lazy(
        &yarvis_server::store::testing::test_database_url(),
        "yarvis_never_migrated",
    )
    .unwrap();
    let state = AppState::new(Config::default(), store);
    let (status, body) = get(&state, "/api/health", None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["database"], "unavailable");
    let (status, body) = get(&state, "/api/auth/status", None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "database_unavailable");
    let (status, _) = get(&state, "/api/devices/me", Some("AAAA")).await;
    assert_eq!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "not 401, which would sign the client out"
    );
}

#[tokio::test]
async fn settings_see_where_the_database_url_came_from_but_never_its_password() {
    use yarvis_server::database_url::{DatabaseUrl, UrlSource};
    let mut state = state().await;
    let (_, reader) = create_device(&state.store, "phone", "token", &[Scope::Read], None)
        .await
        .unwrap();
    let (_, token) = create_device(&state.store, "laptop", "token", &[Scope::Admin], None)
        .await
        .unwrap();
    let request = Request::post("/api/core/get_database_info")
        .header("Host", "localhost:7878")
        .header("Authorization", format!("Bearer {reader}"))
        .body(Body::empty())
        .unwrap();
    let response = app(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(
        response.status(),
        StatusCode::FORBIDDEN,
        "it names the database host"
    );
    let info = |state: &AppState| {
        let request = Request::post("/api/core/get_database_info")
            .header("Host", "localhost:7878")
            .header("Authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let app = app(state.clone());
        async move {
            let response = app.oneshot(request).await.unwrap();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        }
    };
    assert_eq!(info(&state).await, serde_json::Value::Null);
    state.database = Some(DatabaseUrl {
        url: "postgres://me:s3cret@localhost:5432/yarvis".into(),
        source: UrlSource::ConfigFile,
    });
    assert_eq!(
        info(&state).await,
        serde_json::json!({
            "url": "postgres://me:****@localhost:5432/yarvis",
            "source": "configFile",
        })
    );
}

#[tokio::test]
async fn a_request_with_no_token_gets_401_in_the_shared_error_shape() {
    let (status, body) = get(&state().await, "/api/devices/me", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn a_device_without_the_scope_gets_403() {
    let state = state().await;
    let (_, token) = create_device(&state.store, "bot", "token", &[Scope::Chat], None)
        .await
        .unwrap();
    let (status, body) = get(&state, "/api/devices/me", Some(&token)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body["error"].as_str().unwrap().contains("read"));
}

#[tokio::test]
async fn a_device_sees_itself() {
    let state = state().await;
    let (id, token) = create_device(&state.store, "laptop", "token", &[Scope::Read], None)
        .await
        .unwrap();
    let (status, body) = get(&state, "/api/devices/me", Some(&token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deviceId"], id);
    assert_eq!(body["scopes"], serde_json::json!(["read"]));
}

#[tokio::test]
async fn a_request_naming_another_host_is_refused() {
    // DNS rebinding: a page on evil.example resolved its name to 127.0.0.1.
    let request = Request::get("/api/health")
        .header("Host", "evil.example:7878")
        .body(Body::empty())
        .unwrap();
    let response = app(state().await).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn responses_carry_the_security_headers() {
    let request = Request::get("/api/health")
        .header("Host", "127.0.0.1:7878")
        .body(Body::empty())
        .unwrap();
    let response = app(state().await).oneshot(request).await.unwrap();
    let csp = response.headers()["content-security-policy"]
        .to_str()
        .unwrap();
    assert!(csp.contains("frame-ancestors 'none'"));
    assert_eq!(response.headers()["x-frame-options"], "DENY");
}

#[tokio::test]
async fn a_revoked_token_gets_401() {
    let state = state().await;
    let (id, token) = create_device(&state.store, "phone", "token", &[Scope::Read], None)
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET revoked_at = 1 WHERE id = $1")
        .bind(id)
        .execute(state.store.db().unwrap())
        .await
        .unwrap();
    let (status, _) = get(&state, "/api/devices/me", Some(&token)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_device_view_has_no_token_material() {
    let state = state().await;
    let (_, token) = create_device(&state.store, "laptop", "token", &[Scope::Read], None)
        .await
        .unwrap();
    let (_, body) = get(&state, "/api/devices/me", Some(&token)).await;
    let keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["deviceId", "name", "scopes", "verifiedAt"]);
}

//! Serves the built web UI from `config.server.web_dir`.
//!
//! A path with no file behind it gets `index.html`, so a reload on a client
//! route like `/settings` loads the app rather than a 404. Paths under `/api`
//! never fall back: an unknown API route is a JSON 404, not a page of HTML a
//! client would fail to parse.

use std::path::Path;

use axum::Router;
use axum::extract::Request;
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::error::ApiError;

/// The fallback for every route the app doesn't define.
pub fn fallback<S: Clone + Send + Sync + 'static>(web_dir: Option<&Path>) -> Router<S> {
    let Some(dir) = web_dir else {
        return Router::new().fallback(|| async { ApiError::not_found() });
    };
    let files = ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")));
    Router::new().fallback(move |request: Request| {
        let files = files.clone();
        async move { serve(files, request).await }
    })
}

async fn serve(files: ServeDir<ServeFile>, request: Request) -> Response {
    let path = request.uri().path();
    if path == "/api" || path.starts_with("/api/") {
        return ApiError::not_found().into_response();
    }
    match files.oneshot(request).await {
        Ok(response) => response.into_response(),
        Err(e) => ApiError::internal(e).into_response(),
    }
}

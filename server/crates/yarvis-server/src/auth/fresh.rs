//! Actions that could give a stolen token a lasting foothold (minting tokens,
//! adding a passkey, revoking devices) also need a passkey check from the last
//! few minutes. Only passkey devices can pass one, so a token never qualifies,
//! whatever its scopes.

use std::marker::PhantomData;

use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;

use super::{Auth, Authed, DeviceContext, ScopeMarker};
use crate::error::ApiError;
use crate::store::now_ms;

/// How recent the passkey check must be.
pub const FRESH_WINDOW_MS: i64 = 10 * 60 * 1000;

/// The error a client answers by running `/api/auth/reverify`.
pub const REAUTH_REQUIRED: &str = "reauth_required";

pub fn is_fresh(verified_at: Option<i64>, now: i64) -> bool {
    verified_at.is_some_and(|at| now - at < FRESH_WINDOW_MS)
}

/// Like [`Authed`], and the device also passed a passkey check within
/// [`FRESH_WINDOW_MS`].
pub struct Fresh<S: ScopeMarker> {
    pub device: DeviceContext,
    _scope: PhantomData<S>,
}

impl<S, St> FromRequestParts<St> for Fresh<S>
where
    S: ScopeMarker,
    Auth: FromRef<St>,
    St: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &St) -> Result<Self, Self::Rejection> {
        let Authed { device, .. } = Authed::<S>::from_request_parts(parts, state).await?;
        if !is_fresh(device.verified_at, now_ms()) {
            return Err(ApiError::forbidden(REAUTH_REQUIRED)
                .with_detail("confirm with your passkey first: POST /api/auth/reverify/start"));
        }
        Ok(Self {
            device,
            _scope: PhantomData,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_check_counts_only_inside_the_window() {
        let now = 1_000_000_000;
        assert!(is_fresh(Some(now - 1000), now));
        assert!(!is_fresh(Some(now - FRESH_WINDOW_MS), now));
        assert!(!is_fresh(None, now));
    }
}

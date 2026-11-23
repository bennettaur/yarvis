//! The device token this app signs in to yarvis-server with, kept in the
//! macOS Keychain and never in a file.
//!
//! One item per bundle identifier and server, so a `dev:instance` copy and the
//! primary app each hold their own device, and switching between local and
//! remote doesn't throw the other token away.

const SERVICE: &str = "com.mikebennett.yarvis.device-token";

/// The local server's port can change between runs, so its token is keyed by
/// mode rather than by origin.
pub const LOCAL: &str = "local";

fn entry(identifier: &str, server: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &format!("{identifier}|{server}"))
        .map_err(|e| format!("couldn't open the Keychain item: {e}"))
}

/// `Ok(None)` only when there is no item. Any other Keychain failure is an
/// error, so a locked Keychain never looks like "unpaired" and starts a second
/// pairing.
pub fn get(identifier: &str, server: &str) -> Result<Option<String>, String> {
    match entry(identifier, server)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!(
            "couldn't read the device token from the Keychain: {e}"
        )),
    }
}

pub fn set(identifier: &str, server: &str, token: &str) -> Result<(), String> {
    entry(identifier, server)?
        .set_password(token)
        .map_err(|e| format!("couldn't save the device token to the Keychain: {e}"))
}

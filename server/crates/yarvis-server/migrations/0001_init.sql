-- Times are milliseconds since the epoch, as the API sends them.
CREATE TABLE devices (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('login', 'token')),
    scopes        TEXT NOT NULL,
    token_hash    BYTEA NOT NULL UNIQUE,
    created_by    TEXT,
    user_agent    TEXT,
    created_at    BIGINT NOT NULL,
    last_seen_at  BIGINT,
    verified_at   BIGINT,
    revoked_at    BIGINT
);

CREATE TABLE events (
    seq        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at         BIGINT NOT NULL,
    device_id  TEXT,
    kind       TEXT NOT NULL,
    data       TEXT NOT NULL
);

CREATE TABLE account (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    passphrase_hash  TEXT NOT NULL,
    totp_secret      BYTEA NOT NULL,
    totp_last_step   BIGINT,
    created_at       BIGINT NOT NULL
);

CREATE TABLE backup_codes (
    hash        BYTEA PRIMARY KEY,
    created_at  BIGINT NOT NULL,
    used_at     BIGINT
);

CREATE TABLE setup_code (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    hash           BYTEA NOT NULL,
    attempts_left  INTEGER NOT NULL
);

CREATE TABLE approvals (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    summary      TEXT NOT NULL,
    data         TEXT NOT NULL,
    created_at   BIGINT NOT NULL,
    expires_at   BIGINT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
    outcome      TEXT CHECK (outcome IN ('answered', 'timeout', 'abandoned', 'restart')),
    answered_by  TEXT,
    answered_at  BIGINT
);
CREATE INDEX approvals_pending ON approvals (status, created_at);

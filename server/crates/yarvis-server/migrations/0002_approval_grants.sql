-- An approval can offer to cover later requests for a while, such as git
-- signatures for 15 minutes. `max_allow_for_secs` is the longest the
-- requester offered (NULL: it can't); `allow_for_secs` is what the answer chose.
ALTER TABLE approvals ADD COLUMN max_allow_for_secs INTEGER;
ALTER TABLE approvals ADD COLUMN allow_for_secs INTEGER;

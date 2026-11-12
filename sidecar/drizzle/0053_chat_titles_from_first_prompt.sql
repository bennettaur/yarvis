-- Names each untitled chat after its first user message, the way the sidecar
-- names new ones (titleFromPrompt in src/chat/service.ts): the first non-blank
-- line, whitespace collapsed, cut to 60 characters with an ellipsis.
-- A scheduled task's prompt is model-written, so it never names a chat.
WITH first_prompt AS (
	SELECT DISTINCT ON ("session_id")
		"session_id",
		btrim(regexp_replace((regexp_match("content", '\S[^\n]*'))[1], '\s+', ' ', 'g')) AS "line"
	FROM "chat_messages"
	WHERE "role" = 'user' AND ("metadata" IS NULL OR "metadata" -> 'scheduledTask' IS NULL)
	ORDER BY "session_id", "created_at"
)
UPDATE "chat_sessions" AS s
SET "title" = CASE
	WHEN char_length(fp."line") <= 60 THEN fp."line"
	ELSE rtrim(left(fp."line", 59)) || '…'
END
FROM first_prompt AS fp
WHERE s."id" = fp."session_id" AND s."title" IS NULL AND fp."line" IS NOT NULL AND fp."line" <> '';

-- Names each untitled chat after the first prompt the user wrote that has text,
-- the way the sidecar names new ones (titleFromPrompt in src/chat/service.ts):
-- its first non-blank line, whitespace collapsed, cut to 60 characters with an
-- ellipsis. Whitespace is the ASCII set spelled out, since `\s` here depends on
-- the database's locale. A scheduled task's prompt is model-written and a
-- heads-down pass's is the app's, so neither names a chat.
WITH first_prompt AS (
	SELECT DISTINCT ON ("session_id")
		"session_id",
		rtrim(regexp_replace(
			(regexp_match("content", '[^ \t\n\r\f\v][^\n]*'))[1],
			'[ \t\r\f\v]+', ' ', 'g'
		)) AS "line"
	FROM "chat_messages"
	WHERE "role" = 'user'
		AND "content" ~ '[^ \t\n\r\f\v]'
		AND ("metadata" IS NULL OR (
			"metadata" -> 'scheduledTask' IS NULL
			AND "metadata" ->> 'source' IS DISTINCT FROM 'heads-down'
		))
	ORDER BY "session_id", "created_at"
)
UPDATE "chat_sessions" AS s
SET "title" = CASE
	WHEN char_length(fp."line") <= 60 THEN fp."line"
	ELSE rtrim(left(fp."line", 59)) || '…'
END
FROM first_prompt AS fp
WHERE s."id" = fp."session_id" AND s."title" IS NULL;

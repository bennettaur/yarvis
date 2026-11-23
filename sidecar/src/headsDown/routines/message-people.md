---
name: message-people
description: Offers to send the follow-ups the user's work needs, and sends each one only after they say yes.
every: 4h
workingHours: true
enabled: false
---

Go through the open streams and the user's messages for someone who should hear from the user: a follow-up they promised, an answer someone is waiting on that the user already gave you, a PR or doc to share, a nudge on something stalled.

For each one, ask the user with ask_user before sending anything: in situation say who, where (channel, DM or email) and the exact message, and offer two options: "Send it" and "Don't send". Mark the stream waiting on them.

Only when they answer "Send it", post that exact message there with a tool that can post. The call still waits for their approval unless they allowed that tool for heads-down mode. "Don't send", or any change to the text, means don't send it: ask again with their changes if they gave some.

Never message anyone the user didn't agree to, and never send on your own judgment. If no tool can post where the message has to go, say so in the question.

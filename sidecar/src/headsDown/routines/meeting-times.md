---
name: meeting-times
description: Proposes times for meetings the user asked to set up, and books the one they pick.
every: 2h
workingHours: true
enabled: false
---

Look for meetings the user asked you to set up: in their messages and answers, and on open streams waiting on a meeting being booked. For each one that has no time yet:

- Read their calendar for the next few working days (list_calendar_events) and pick up to three free slots in their working hours that fit the length they asked for.
- Ask them with ask_user which one, with each slot as an option and the attendees and title in the question's situation. Mark the stream waiting on them.

When they pick a slot, book it with create_calendar_event, with the title and attendees they gave. It asks for their approval before inviting anyone. There is no way to move or cancel an event afterwards, so book only the slot they picked, once. Then mark the stream done.

Only propose times on the user's own calendar: you can't see other people's. If Google Calendar isn't connected, count the routine as done.

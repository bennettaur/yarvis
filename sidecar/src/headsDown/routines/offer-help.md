---
name: offer-help
description: Once a day, offers a few things it could take off the user's plate.
every: 1d
workingHours: true
enabled: false
---

Look at today's calendar (list_calendar_events), the open streams and the user's tasks, and pick up to three things you could do for them that nobody has asked for yet: notes or a brief for a meeting coming up, a ticket for work that is only in a message, a reply to draft, a stalled review to chase, a task due today with no plan.

Tell the user with one raise_attention (kind message, category general): a line for each offer saying what you would do. Don't do any of it: they say yes by telling heads-down mode or the assistant. If nothing is worth offering, raise nothing and count the routine as done.

# Calendar and alarms

The **Calendar** tab shows your Google Calendar. The assistant can read it to
plan your week, and can add events after asking you. **Alarms** make sure you
don't miss a meeting: when one fires, Yarvis takes over the whole screen and
keeps sounding until you acknowledge it.

## Set up Google Calendar

You need your own Google Cloud OAuth client. This is a one-time setup.

1. In the [Google Cloud Console](https://console.cloud.google.com), create a
   project (or pick one) and enable the **Google Calendar API**.
2. Configure the OAuth consent screen. For personal use, choose **External**
   and add yourself as a test user.
3. Create an **OAuth client ID** of type **Desktop app**. Copy the client ID and
   client secret.
4. In Yarvis, open **Settings → Credentials**:
   - Enter the client ID in **Google client id** and save.
   - Enter the client secret in **Google client secret** and save. It goes to
     your secret store (the Keychain by default), and the sidecar restarts.
5. Open the **Calendar** tab and press **Connect Google Calendar**. Your browser
   opens Google's consent screen.
6. Approve it. The browser shows "Calendar connected. You can close this tab."
7. Back in Yarvis, press **I've connected — refresh**.

The redirect Yarvis uses is
`http://127.0.0.1:<sidecar-port>/oauth/google/callback`. The sidecar port
changes every launch, but Desktop-app clients accept any loopback port, so
there is nothing to update when it does.

Yarvis asks for the `calendar.events` scope. The tokens are stored in Postgres
and refresh themselves. One Google account is connected at a time.
**Disconnect** in the Calendar tab forgets it.

If you connected before Yarvis asked for write access, reading works but
creating an event fails with "connected read-only". Disconnect and connect
again.

## Use the calendar

The Calendar tab has four views: **Agenda**, **Week**, **Month** and **Day**
(Day can be vertical or horizontal). Week, Month and Day have **Prev**,
**Today** and **Next**.

Each event shows its time and an alarm button. The Agenda, Week and Day views
also show a **join** link for Google Meet.

## Ask the assistant

The assistant can read your calendar and book new events:

> What does my week look like? Find me two hours of focus time on Thursday.

> Book 30 minutes with sam@example.com tomorrow at 2pm to go over the migration.

Booking an event **always** asks for your approval first, whether you typed or
spoke. Yarvis can create events, but it can't move or delete them. The Google
client has no method for either, and no tool offers one. Moving or cancelling a
meeting stays with you, in your own calendar.

It can also set alarms, without asking, since an alarm only rings on your
machine and you can cancel it:

> Look through my meetings this week and set alarms for all the ones I've accepted.

> Wake me at 3pm to call the bank.

A meeting alarm it sets is the same one **Set alarm** makes, so the calendar
shows it as set. It won't set one for a meeting you declined, or set one again
for a meeting whose alarm you cancelled or dismissed.

## Alarms

### Set an alarm

- **From the calendar:** press **Set alarm** on an event, or **Set alarms for
  all** in the Agenda view, which arms the next 20 upcoming timed events. The
  alarm fires **one minute before** the event and carries the Meet link. All-day events and events that have already started
  can't be armed. Arming the same event twice does nothing.
- **From the Alarms tab:** in the **New alarm** section, enter a label and a
  time, and press **Set**. **Test in 5s** fires a test alarm.
- **From the assistant:** ask it in a chat (see above). In
  [heads-down mode](heads-down.md) it checks your coming meetings a few times a
  day and sets alarms for the ones you're going to, asking you about the ones it
  isn't sure of. In that mode it can only set meeting alarms, never one with a
  label of its own, and it can't cancel any.

Otherwise alarms are not armed automatically. Each morning, press **Set alarms
for all** in the Agenda view.

### When an alarm fires

1. The Yarvis window comes forward, goes full screen and stays on top.
2. macOS shows a notification, and a sound repeats every few seconds.
3. After a minute, the screen pulses red with "Overdue by …", and the sound
   gets louder and more frequent.

Then choose one:

- **Join meeting** opens the meeting link and acknowledges the alarm.
- **Acknowledge** stops it.
- **Snooze 5 min** fires it again in five minutes.

If several alarms fire together, they queue up, and the screen is released
once you've handled them all.

### Other details

- The **Alarms** tab lists what's **Ringing** (with Snooze, and Dismiss, which acknowledges it) and
  what's **Upcoming** (with Cancel).
- An alarm whose time passed while Yarvis was closed fires as soon as the app
  starts.
- Alarms are stored in Postgres, so they need the database. Alarms from older
  versions, which kept them in `alarms.json` in the app's data folder, are
  copied over on first start, and the file is renamed to
  `alarms.json.imported`.
- Alarms ring only while the sidecar is running, since it decides when one is
  due. If it can't reach the app's core to ring one, it tries again every few
  seconds.
- If Yarvis can't record your choice (Acknowledge or Snooze) because the
  sidecar is down, the ringing still stops and the alarm screen says so. Try
  again once it's back, or a snooze won't ring again.
- Only the instance running background workers rings alarms: the main one, by
  default. A second instance sharing the database lists them and leaves the
  ringing to it. One with its own database doesn't ring them at all unless you
  turn its background workers on (`YARVIS_BACKGROUND_WORKERS=1`).
- The sound uses macOS system sounds through `afplay`.

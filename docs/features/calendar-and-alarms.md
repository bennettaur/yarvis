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

## Alarms

### Set an alarm

- **From the calendar:** press **Set alarm** on an event, or **Set alarms for
  all** in the Agenda view, which arms the next 20 upcoming timed events. The alarm fires **one minute before** the event and
  carries the Meet link. All-day events and events that have already started
  can't be armed. Arming the same event twice does nothing.
- **From the Alarms tab:** in the **New alarm** section, enter a label and a
  time, and press **Set**. **Test in 5s** fires a test alarm.

Alarms are not armed automatically. Each morning, press **Set alarms for all**
in the Agenda view. The assistant can't set alarms yet.

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
- Alarms are stored in `alarms.json` in the app's data folder, not in Postgres,
  so they work without a database.
- The sound uses macOS system sounds through `afplay`.

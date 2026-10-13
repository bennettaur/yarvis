# Yarvis Chrome extension

Lets Yarvis read the pages open in your Chrome, and move around inside them —
any profile, no debugging port, no Playwright profile. The aim is reading a site
like Slack: open a channel, read it, scroll back, open the next one.

It stays on the site the tab is on and it can never type, so it can't compose or
send anything.

## How it connects

An extension can't listen on a socket, so the link is built from the extension
outward:

```
Yarvis sidecar  <--HTTP long poll-->  native host  <--stdio-->  extension
(/browser/next,                       (scripts/browser/host.ts)  (background.js)
 /browser/result)
```

- The sidecar picks a new port each launch, so on startup each running Yarvis
  instance writes `~/.yarvis/browser/instances/<instance>-<pid>.json` (name, port, a
  scoped token and its pid, mode 0600). The host rescans that folder every few
  seconds and polls every live instance, so restarting Yarvis, or running a
  second one with `bun run dev:instance <name>`, needs nothing on your side.
- Each Chrome profile running the extension polls under its own name, which you
  set in the extension's popup. Tools take that name as `profile`, so you can
  say "look at Slack in my work profile". With one profile connected the name
  can be left out.
- The token reaches only the two `/browser` routes — never the full-access
  bearer.
- Chrome only starts the host for extension ids listed in the host manifest.

## Install

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick this
   `extension/` directory. Note the extension id it shows.
2. `bun run browser:install <extension-id>` — registers the native-messaging
   host with Chrome (macOS, Google Chrome).
3. Reload the extension, then click its toolbar icon and give this profile a
   name (e.g. `work`).
4. With Yarvis running, ask it about your current tab.

The popup's "Show activity beside the page" opens Chrome's side panel with a log
of every command Yarvis sent this profile: the tool, the arguments and the full
result or error, newest first. It lives in session storage, so it is gone when
Chrome quits, and each result is kept up to 100,000 characters.

The popup shows whether the helper is running and which Yarvis instances it can
reach, with a dot for whether each one is answering. The badge on the icon is
the number of connected instances.

Repeat step 1 in each profile you want Yarvis to see, adding each id to the
install command (they differ per profile only if loaded from a different path).

## What the agent can do

- `list_browser_tabs` — id, window, title, URL of every open tab, grouped by
  Chrome profile.
- `read_browser_page` — URL, title, selection and visible text of a tab (the
  active one by default), capped in length.
- `list_browser_elements` — the links, buttons, sidebar items and scrollable
  panels on a page, each with a numeric ref.
- `click_browser_element`, `scroll_browser_page`, `navigate_browser_tab` — act on
  a ref, scroll (to load older messages), or load an address.
- `inspect_browser_page` — how part of a page is built (tag, role, aria/data
  attributes, text, size, children, and whether a click would be refused), for
  an agent working out why a click or listing missed. Matches get refs.

When a click does nothing, the agent can recover without new code: list or
inspect with a CSS `selector`, click by `selector` instead of a ref, click with
`mode: "direct"` (at the element itself rather than whatever is under its
middle), or `mode: "hover"` to reveal a menu first. However the target is
chosen, the same screens below apply to what the click really lands on.

### Site adapters

`extension/adapters/` holds per-site code that changes what the same tools
return, never what they may do (`kit.js` holds what they share):

- **Slack** turns `read_browser_page` into a message transcript (newest kept) and
  tags sidebar conversations with a `channelId` and an `openUrl`.
- **Gmail** reads a mailbox as one line per conversation (unread mark, time,
  sender, subject, snippet, thread id), and an open conversation as its
  messages. A conversation is opened by navigating to `#all/<id>`, not by
  clicking its row, since subjects often contain words the click screens refuse.
- **Google Calendar** reads the events in view as one line each, from the
  description each event carries for screen readers.

None of these sites' markup is a public interface, so when an adapter finds
nothing it recognises the tools fall back to the generic behaviour and the
result carries an `adapterNote` saying so.

The code that runs inside the page lives in `extension/page.js`, injected with
the adapters before each command.

### What keeps it on the site

The extension enforces this, not the sidecar:

- **Same origin only.** A link or address on another scheme, host or port is
  refused before anything happens. While a click or navigation runs, the tab is
  also blocked from loading any other host (`declarativeNetRequest`), which
  covers a script that navigates and an open redirect on the site. Sibling
  subdomains of the host are not blocked that way, so a click that still ends up
  elsewhere is caught afterwards and undone with Back, but by then that page may
  have loaded with your session. A tab a click opens is closed. A sibling
  subdomain counts as another site.
- **No sign-out-style addresses.** `navigate_browser_tab` and links whose
  address contains logout, delete, remove, leave and the like are refused.
- **No typing.** There is no tool for it, so nothing can be composed or sent.
- **No controls that send or change things.** Buttons and `#` links labelled
  send, post, delete, leave, edit, save and the like are left out of the list and
  refused if named. This is a match on the visible label, so treat it as a
  safety net, not a guarantee. Links to pages on the site are screened by
  address instead (`/logout`, `/delete`, `/leave`, ...), so a channel called
  `post-mortems` still opens.
- **Approval on spoken turns.** `click_browser_element` and `navigate_browser_tab`
  sit in `chat/destructiveTools.ts`, so a voice turn asks first.

Page text is fenced as untrusted data before it reaches the model.

## Privacy

Page text a tool reads goes into the chat turn, so it reaches your LLM provider
and is kept in the chat history like any other tool result. Listed URLs drop
their query string and fragment. The extension is not allowed in incognito unless
you turn that on for it in `chrome://extensions`; leave it off.

## Limits of this first pass

- The host runs through the checkout's Bun (`scripts/browser/host.ts`), so this
  is for a dev checkout; a packaged app would need to ship the host.
- Every running Yarvis instance can drive the browser, and two could act in the
  same tab at once. That is on purpose, for testing branches side by side.
- Clicks are not asked about on typed turns. That is what makes reading many
  channels practical, and it is a decision to revisit if it feels too loose.
- `<all_urls>` lets a read reach any tab, including signed-in ones; there is no
  per-site allowlist yet.

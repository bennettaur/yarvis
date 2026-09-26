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

- The sidecar picks a new port each launch, so on startup it writes
  `~/.yarvis/browser.json` (port + a scoped token, mode 0600). The host reads it
  fresh on every poll, so restarting Yarvis needs nothing on your side.
- The token reaches only the two `/browser` routes — never the full-access
  bearer.
- Chrome only starts the host for extension ids listed in the host manifest.

## Install

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick this
   `extension/` directory. Note the extension id it shows.
2. `bun run browser:install <extension-id>` — registers the native-messaging
   host with Chrome (macOS, Google Chrome).
3. Reload the extension. With Yarvis running, ask it about your current tab.

Repeat step 1 in each profile you want Yarvis to see, adding each id to the
install command (they differ per profile only if loaded from a different path).

## What the agent can do

- `list_browser_tabs` — id, window, title, URL of every open tab.
- `read_browser_page` — URL, title, selection and visible text of a tab (the
  active one by default), capped in length.
- `list_browser_elements` — the links, buttons, sidebar items and scrollable
  panels on a page, each with a numeric ref.
- `click_browser_element`, `scroll_browser_page`, `navigate_browser_tab` — act on
  a ref, scroll (to load older messages), or load an address.

### What keeps it on the site

The extension enforces this, not the sidecar:

- **Same origin only.** A link, redirect or address on another scheme, host or
  port is refused. A click that ends up elsewhere is undone with Back, and a
  tab a click opens is closed. A sibling subdomain counts as another site.
- **No typing.** There is no tool for it, so nothing can be composed or sent.
- **No controls that send or change things.** Buttons and `#` links labelled
  send, post, delete, leave, edit, save and the like are left out of the list and
  refused if named. This is a match on the visible label, so treat it as a
  safety net, not a guarantee. Real links to pages on the site are not screened
  by label, so a channel called `post-mortems` still opens.
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
- One Yarvis instance owns the browser (the one running background workers).
- Clicks are not asked about on typed turns. That is what makes reading many
  channels practical, and it is a decision to revisit if it feels too loose.
- `<all_urls>` lets a read reach any tab, including signed-in ones; there is no
  per-site allowlist yet.

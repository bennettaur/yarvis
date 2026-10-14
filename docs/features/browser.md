# Browser

Yarvis can read the pages open in your Chrome, and move around inside them, so
you can ask it things like "what's happening in #announce?" or "summarize my
unread mail". It works in your normal Chrome profiles, with no debugging port
and no separate automation browser.

It reads; it doesn't act for you. Yarvis stays on the site a tab is already on,
won't press anything that sends, posts, deletes or changes something, and has
no way to type.

## Set up

The extension isn't in the Chrome Web Store, so it is loaded from a checkout of
this repo.

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load
   unpacked**, and pick the repo's `extension/` folder. Note the extension id
   Chrome shows.
2. From the repo, run `bun run browser:install <extension-id>`. This registers
   the small helper Chrome starts to talk to Yarvis.
3. Reload the extension, click its toolbar icon, and give this Chrome profile a
   name, such as `work`.

Repeat steps 1 and 3 in each Chrome profile you want Yarvis to see. With Yarvis
running, the extension's icon shows a count of the Yarvis apps it's connected
to.

## Using it

Ask in chat. The browser tools sit behind tool search, so the assistant mounts
them when a question needs them.

- **Several profiles.** Name each one in its popup, then say which you mean:
  "check Slack in my work profile". With one profile connected you don't need
  to.
- **Several Yarvis instances.** Every running Yarvis app, including one started
  with `bun run dev:instance`, can use the browser, and the popup lists them.
- **Watching what it does.** In the extension's popup, **Show activity beside
  the page** opens Chrome's side panel with every command Yarvis sent, its
  arguments and the full result. The log is kept in memory and is gone when
  Chrome quits.

## Sites it knows

On these sites the same tools return tidier results:

| Site | What you get |
| --- | --- |
| Slack | The loaded messages of a channel as a transcript, newest kept, and each sidebar conversation with a link that opens it |
| Gmail | A mailbox as one line per conversation (unread, time, sender, subject, snippet), or the messages of an open conversation |
| Google Calendar | The events in view, one line each |

Anywhere else Yarvis reads the page's visible text. If one of these sites
changes its page and Yarvis can't recognize it, it falls back to the plain text
and says so.

## What it won't do

- **Leave the site.** A link, address or redirect to another site is refused,
  and a click that ends up elsewhere is undone.
- **Send or change things.** Buttons and links like send, post, delete, leave,
  edit, save, invite or sign out are left out and refused, and so are form
  controls such as checkboxes and switches. This works from the visible labels,
  so treat it as a safety net rather than a guarantee.
- **Type.** There is no tool for it.

When you speak to Yarvis rather than type, it asks before clicking or loading a
page. What a page says is treated as text written by someone else, never as an
instruction to the assistant.

## Privacy

What Yarvis reads from a page goes into the chat, so it reaches your model
provider and is kept in the chat history like any other tool result. Page
addresses are shared without their query strings. Leave the extension off in
incognito, which is Chrome's default.

## Troubleshooting

- **"No browser is connected."** Check the extension's popup. If it says the
  helper isn't running, rerun `bun run browser:install` with the extension id
  and reload the extension.
- **A click changes nothing.** Some sites only react to particular elements.
  Ask Yarvis to try again; it can inspect how that part of the page is built
  and click something more specific.

For how it works and what each tool returns, see `extension/README.md` in the
repo.

// Slack adapter: the same browser tools, with Slack-shaped results.
//
// read_browser_page returns the loaded messages as a transcript instead of the
// whole page's text (sidebar, toolbar and composer included), and
// list_browser_elements tags sidebar conversations with their channel id and an
// address that opens them. Nothing here changes what may be clicked; page.js
// screens every click the same way on every site.
//
// Slack's markup is not a public interface, so each part is looked for under a
// few selectors, and anything not found leaves page.js to fall back to the
// generic behaviour and say so.

(() => {
  const { clean, text, first, all, fit, register } = globalThis.__yarvisAdapterKit;

  const MESSAGE = ['[data-qa="message_container"]', ".c-message_kit__message"];
  const SENDER = [
    '[data-qa="message_sender_name"]',
    ".c-message__sender_button",
    '[data-qa="message_sender"]',
  ];
  const TIMESTAMP = ["a.c-timestamp", '[data-qa="timestamp_label"]', "a[data-ts]"];
  const BODY = ['[data-qa="message-text"]', ".c-message_kit__blocks", ".p-rich_text_block"];
  const REPLIES = ['[data-qa="reply_bar_count"]', ".c-message__reply_count"];
  const HEADER = ['[data-qa="channel_name"]', ".p-view_header__channel_title"];
  /**
   * The conversation's own pane. Without it, an open thread or side panel adds
   * its messages to the transcript as if they were in the channel.
   */
  const MAIN_PANE = [".p-workspace__primary_view", '[role="main"]'];
  const SIDE_PANE = '.p-flexpane, .p-threads_flexpane, [data-qa="threads_flexpane"]';

  /** Slack conversation ids: C channels, D direct messages, G group DMs. */
  const CONVERSATION_ID = /^[CDG][A-Z0-9]{6,}$/;
  // T for a workspace, E for an Enterprise Grid org.
  const ID_IN_ADDRESS = /\/(?:archives|client\/[TE][A-Z0-9]+)\/([CDG][A-Z0-9]{6,})/;

  function conversationName() {
    const header = text(first(document, HEADER));
    if (header) return header;
    // "general (Channel) - Acme - Slack": the first part names the conversation.
    return clean(document.title.split(" - ")[0]);
  }

  /** The message's time as Slack shows it, e.g. "Today at 12:40:24 PM". */
  function timeOf(message) {
    const stamp = first(message, TIMESTAMP);
    return clean(stamp?.getAttribute("aria-label") || text(stamp));
  }

  /**
   * The loaded messages as "[time] author: text" lines, oldest first, or null
   * when none are found. When they don't all fit in maxChars the oldest are
   * dropped: what's happening now is what a reader of a chat wants. Slack leaves
   * the sender off a run of messages from the same person, so the last one seen
   * carries over, within one list only.
   */
  function readPage({ maxChars }) {
    const pane = first(document, MAIN_PANE);
    const messages = all(pane ?? document, MESSAGE).filter((m) => !m.closest(SIDE_PANE));
    if (messages.length === 0) return null;
    const lines = [];
    let author = "";
    let list = null;
    for (const message of messages) {
      const container = message.closest('[role="list"]');
      if (container !== list) author = "";
      list = container;
      author = text(first(message, SENDER)) || author;
      const body = text(first(message, BODY));
      if (!body) continue;
      const replies = text(first(message, REPLIES));
      const time = timeOf(message);
      lines.push(
        `${time ? `[${time}] ` : ""}${author || "(unknown)"}: ${body}${replies ? ` (${replies})` : ""}`,
      );
    }
    if (lines.length === 0) return null;

    const header = `Conversation: ${conversationName()}\n`;
    const { kept, omitted } = fit(lines, maxChars - header.length - 120, { keep: "last" });
    const note = omitted
      ? `Older loaded messages were left out to fit; ${omitted} more above.\n`
      : "Only the messages Slack has loaded are here; scroll the message list up for older ones.\n";
    return { text: `${header}${note}\n${kept.join("\n")}`, truncated: omitted > 0 };
  }

  /** The conversation a sidebar row opens, from an attribute on it or a link inside it. */
  function conversationIdOf(el) {
    const tagged =
      el.closest("[data-qa-channel-sidebar-channel-id]") ??
      el.querySelector("[data-qa-channel-sidebar-channel-id]");
    const fromAttribute = tagged?.getAttribute("data-qa-channel-sidebar-channel-id");
    if (fromAttribute && CONVERSATION_ID.test(fromAttribute)) return fromAttribute;
    for (const link of [el.closest("a[href]"), ...el.querySelectorAll("a[href]")]) {
      const match = link?.getAttribute("href")?.match(ID_IN_ADDRESS);
      if (match) return match[1];
    }
    return null;
  }

  function describeElement(el, loc = location) {
    const id = conversationIdOf(el);
    if (!id) return null;
    const team = loc.pathname.match(/^\/client\/([TE][A-Z0-9]+)/)?.[1];
    return {
      channelId: id,
      // Loading this opens the conversation even when its sidebar row isn't rendered.
      ...(team ? { openUrl: `${loc.origin}/client/${team}/${id}` } : {}),
    };
  }

  // The app and a workspace's conversation pages, not api.slack.com or the help centre.
  const matches = (loc) =>
    loc.hostname === "app.slack.com" ||
    (loc.hostname.endsWith(".slack.com") && /^\/(?:client|archives)\//.test(loc.pathname));

  register({ name: "slack", matches, readPage, describeElement });
})();

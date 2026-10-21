// Gmail adapter: the same browser tools, with mail-shaped results.
//
// On a mailbox, read_browser_page returns one line per conversation (unread
// mark, time, sender, subject, snippet) with a short thread id; on an open
// conversation, its messages with sender and date. Opening a conversation is a
// navigate_browser_tab to the address the read gives, not a click: a row's text
// is its subject, and subjects ("Accepted: Standup") trip the click screens
// that keep Yarvis off controls that send or change things.
//
// Gmail's markup is not a public interface. These are the class names and
// attributes it has kept for years; when they don't match, page.js falls back
// to the plain page text and says so.

(() => {
  const { clean, text, first, all, fit, register } = globalThis.__yarvisAdapterKit;

  const MAIN = ['[role="main"]'];
  const ROW = ["tr.zA"];
  const UNREAD_ROW = "zE";
  const SENDERS = ".yX .yP, .yX .zF";
  const SUBJECT = [".bog"];
  const SNIPPET = [".y2"];
  const ROW_TIME = ["td.xW span[title]", "td.xW span"];
  const THREAD_ID = "[data-legacy-thread-id]";

  const THREAD_SUBJECT = ["h2.hP"];
  const MESSAGE = [".adn"];
  const SENDER = [".gD"];
  const DATE = [".g3"];
  const BODY = [".a3s"];

  const SNIPPET_CHARS = 140;

  // Gmail keeps views it has left in the page, hidden, so only what is on screen
  // counts: otherwise a thread you went back from reads as the one that is open.
  function shown(el) {
    const rect = el?.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  }

  /** The mailbox or label being shown, from "Inbox (12) - you@example.com - Mail". */
  const viewName = () => clean(document.title.split(" - ")[0]);

  function readMailbox(maxChars) {
    const main = first(document, MAIN) ?? document;
    const rows = all(main, ROW).filter(shown);
    if (rows.length === 0) return null;
    const lines = rows.map((row) => {
      const senders = [...row.querySelectorAll(SENDERS)]
        .map((el) => clean(el.getAttribute("name") || text(el)))
        .filter(Boolean);
      const subject = text(first(row, SUBJECT));
      const snippet = text(first(row, SNIPPET))
        .replace(/^[-–—]\s*/, "")
        .slice(0, SNIPPET_CHARS);
      const stamp = first(row, ROW_TIME);
      const time = clean(stamp?.getAttribute("title") || text(stamp));
      const id = row.querySelector(THREAD_ID)?.getAttribute("data-legacy-thread-id");
      const unread = row.classList.contains(UNREAD_ROW) ? "● " : "";
      return `${unread}${time} · ${[...new Set(senders)].join(", ") || "(unknown)"} — ${subject || "(no subject)"}${snippet ? ` — ${snippet}` : ""}${id ? ` [id ${id}]` : ""}`;
    });
    const base = `${location.origin}${location.pathname}`;
    const header = [
      `Mailbox: ${viewName()}`,
      `● marks unread. To open a conversation, navigate_browser_tab to ${base}#all/<id>.`,
      "",
    ].join("\n");
    // The newest mail is at the top of a mailbox.
    const { kept, omitted } = fit(lines, maxChars - header.length - 80, { keep: "first" });
    const note = omitted ? `\n(${omitted} older conversations left out to fit.)` : "";
    return { text: `${header}${kept.join("\n")}${note}`, truncated: omitted > 0 };
  }

  function readConversation(maxChars) {
    const heading = all(document, THREAD_SUBJECT).find(shown);
    const subject = text(heading);
    if (!subject) return null;
    const messages = all(first(document, MAIN) ?? document, MESSAGE).filter(shown);
    const lines = messages.map((message) => {
      const senderEl = first(message, SENDER);
      const sender = clean(
        [
          senderEl?.getAttribute("name"),
          senderEl?.getAttribute("email") && `<${senderEl.getAttribute("email")}>`,
        ]
          .filter(Boolean)
          .join(" ") || text(senderEl),
      );
      const dateEl = first(message, DATE);
      const date = clean(dateEl?.getAttribute("title") || text(dateEl));
      // A collapsed message has no body in the page until it is opened.
      const body = text(first(message, BODY)) || "(collapsed; open it to read)";
      return `[${date || "?"}] ${sender || "(unknown)"}:\n${body}`;
    });
    const header = `Conversation: ${subject}\n\n`;
    // The latest reply is what matters most in a long thread.
    const { kept, omitted } = fit(lines, maxChars - header.length - 80, { keep: "last" });
    const note = omitted ? `(${omitted} earlier messages left out to fit.)\n\n` : "";
    return { text: `${header}${note}${kept.join("\n\n")}`, truncated: omitted > 0 };
  }

  function readPage({ maxChars }) {
    return readConversation(maxChars) ?? readMailbox(maxChars);
  }

  register({
    name: "gmail",
    matches: (loc) => loc.hostname === "mail.google.com",
    readPage,
    title: viewName,
  });
})();

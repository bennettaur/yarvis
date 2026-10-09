// Google Calendar adapter: the same browser tools, with one line per event.
//
// read_browser_page returns the events in view instead of the page's text,
// which loses which time goes with which title. Each event chip carries a full
// description for screen readers ("10am to 11am, Standup, Alex Kim, Accepted,
// Room 4, October 4, 2026"), and that is what each line is.
//
// Calendar's markup is not a public interface; when no event chips are found,
// page.js falls back to the plain page text and says so.

(() => {
  const { clean, text, fit, register } = globalThis.__yarvisAdapterKit;

  const EVENT = "[data-eventid]";
  /** The visually hidden description inside a chip, when it isn't on aria-label. */
  const DESCRIPTION = ".XuJrye";

  function describe(chip) {
    const hidden = chip.querySelector(DESCRIPTION);
    return clean(chip.getAttribute("aria-label") || hidden?.textContent || text(chip));
  }

  function readPage({ maxChars }) {
    const chips = [...document.querySelectorAll(EVENT)];
    if (chips.length === 0) return null;
    // A multi-day event has a chip per day; the first one describes it.
    const seen = new Set();
    const lines = [];
    for (const chip of chips) {
      const id = chip.getAttribute("data-eventid");
      const line = describe(chip);
      if (!line || seen.has(id)) continue;
      seen.add(id);
      lines.push(`- ${line}`);
    }
    if (lines.length === 0) return null;
    // "Google Calendar - Week of October 4, 2026" names the range in view.
    const range = clean(document.title.replace(/^Google Calendar\s*-\s*/, ""));
    const header = `Calendar: ${range}\nEvents in view, in page order:\n`;
    const { kept, omitted } = fit(lines, maxChars - header.length - 80, { keep: "first" });
    const note = omitted ? `\n(${omitted} more events left out to fit.)` : "";
    return { text: `${header}${kept.join("\n")}${note}`, truncated: omitted > 0 };
  }

  register({
    name: "calendar",
    matches: (loc) => loc.hostname === "calendar.google.com",
    readPage,
  });
})();

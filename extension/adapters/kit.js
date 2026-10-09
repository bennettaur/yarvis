// Helpers shared by the site adapters. Loaded before them (see PAGE_FILES in
// background.js), into the same isolated world.

(() => {
  const clean = (value) => (value ?? "").replace(/\s+/g, " ").trim();

  /** An element's text, or "" for none. */
  const text = (el) => clean(el?.innerText ?? el?.textContent);

  /** The first match of the first selector that matches anything. */
  function first(root, selectors) {
    for (const selector of selectors) {
      const found = root.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  /** Every match of the first selector that matches anything. */
  function all(root, selectors) {
    for (const selector of selectors) {
      const found = root.querySelectorAll(selector);
      if (found.length > 0) return [...found];
    }
    return [];
  }

  /**
   * As many lines as fit in `budget` characters, taken from the end that
   * matters: the newest messages of a chat sit at the bottom, the newest mail of
   * an inbox at the top. The line at that end is always kept, cut to fit if it
   * has to be, so one long email can't leave nothing to read. Returns the kept
   * lines in their original order and how many were left out.
   */
  function fit(lines, budget, { keep }) {
    const kept = [];
    let used = 0;
    const order = keep === "last" ? [...lines].reverse() : lines;
    for (const line of order) {
      if (used + line.length + 1 > budget) {
        if (kept.length === 0 && budget > 0)
          kept.push(`${line.slice(0, Math.max(budget - 10, 0))}… (cut)`);
        break;
      }
      kept.push(line);
      used += line.length + 1;
    }
    if (keep === "last") kept.reverse();
    return { kept, omitted: lines.length - kept.length };
  }

  // Own properties only, like page.js reads the registry: a page element with
  // one of these ids would otherwise show up on window as a named property.
  if (!Object.hasOwn(globalThis, "__yarvisAdapters")) globalThis.__yarvisAdapters = {};
  const register = (adapter) => {
    globalThis.__yarvisAdapters[adapter.name] = adapter;
  };

  globalThis.__yarvisAdapterKit = { clean, text, first, all, fit, register };
})();

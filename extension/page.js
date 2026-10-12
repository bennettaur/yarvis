// The half of the extension that runs inside the page.
//
// background.js injects this file (after any site adapters, see adapters/) into
// the tab's isolated world before each command, then calls one of the functions
// on globalThis.__yarvis. The isolated world is shared with nothing on the page,
// so the page can't see or call these, and the element refs kept here survive
// between commands for as long as the document does.
//
// Every way of choosing something to click — a ref from a listing, a ref from
// inspect, a CSS selector the agent wrote — ends in the same screens in
// clickTarget(): same site only, no controls that send or change things, no form
// submits. None of it types, and no keyboard or input event is ever sent.

(() => {
  const CLICKABLE =
    'a[href],button,summary,[role="button"],[role="link"],[role="tab"],[role="treeitem"],[role="menuitem"],[role="option"]';

  /**
   * Controls that change a setting or fill in a form. A synthetic click still
   * toggles a checkbox or submits a form, so these are never clicked, and neither
   * is a label that forwards its click to one.
   */
  const FORM_CONTROL =
    'input:not([type="button"]),select,textarea,[contenteditable="true"],[contenteditable=""],[role="checkbox"],[role="switch"],[role="radio"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="textbox"]';

  /** Anything a click can activate on its way up, all of which gets screened. */
  const CONTROL = `${CLICKABLE},label,[onclick],${FORM_CONTROL}`;

  /**
   * Attributes a selector may match on by value. Anything else could be probed a
   * prefix at a time — `[content^="a"]` on a CSRF meta tag — for a value inspect
   * deliberately never returns.
   */
  const MATCHABLE_ATTRIBUTE =
    /^(?:role|id|class|type|title|tabindex|aria-[\w-]+|data-qa[\w-]*|data-testid)$/i;

  /**
   * The only shape an attribute test may take: a plain name, optionally compared
   * to a quoted or bare value. Namespaces (`[*|content]`), escapes and comments
   * are all ways to spell a name the check above wouldn't recognise, so a
   * bracket that isn't exactly this is refused rather than let through.
   */
  const ATTRIBUTE_GROUP =
    /^\s*([A-Za-z][\w-]*)\s*(?:[~|^$*]?=\s*(?:"[^"\\]*"|'[^'\\]*'|[\w-]+)\s*[iIsS]?\s*)?$/;
  const HAS_OPERATOR = /[~|^$*]?=/;

  /**
   * Elements a click activates even when it lands on something inside them: a
   * link follows, a button presses or submits, a label forwards to its control.
   * Any of these above the chosen element is screened too.
   */
  const ACTIVATES = "a[href],button,label,summary,input,select,textarea";

  /** Never shown by inspect: they hold code and boot data, not anything to click. */
  const UNINSPECTABLE = new Set([
    "SCRIPT",
    "STYLE",
    "TEMPLATE",
    "NOSCRIPT",
    "META",
    "LINK",
    "HEAD",
    "TITLE",
  ]);

  /** Longest label kept per element in a listing. */
  const LABEL_CHARS = 120;

  /**
   * A chosen element that isn't a control is only clicked if its own text is
   * about this long or less. Anything bigger is a container — a message pane, a
   * whole sidebar — and a click in its middle lands on whatever is there.
   */
  const MAX_PLAIN_LABEL = 200;

  // Refs outlive re-injection: they sit on window rather than in this closure.
  if (!(window.__yarvisRefs?.byRef instanceof Map)) {
    window.__yarvisRefs = { byRef: new Map(), scrollRefs: new Set(), next: 1 };
  }
  const state = window.__yarvisRefs;

  // The counter keeps climbing, so a ref from an older listing reads as gone
  // rather than quietly naming a different element.
  function resetRefs() {
    state.byRef = new Map();
    state.scrollRefs = new Set();
  }

  function remember(el, { scroll = false } = {}) {
    for (const [ref, known] of state.byRef) {
      if (known !== el) continue;
      if (scroll) state.scrollRefs.add(ref);
      return ref;
    }
    const ref = state.next++;
    state.byRef.set(ref, el);
    if (scroll) state.scrollRefs.add(ref);
    return ref;
  }

  // Own property only: a page element with id="__yarvisAdapters" shows up on
  // window as a named property, and must not stand in for the registry.
  function adapter() {
    const registry = Object.hasOwn(globalThis, "__yarvisAdapters")
      ? globalThis.__yarvisAdapters
      : {};
    return Object.values(registry).find(
      (a) => typeof a?.matches === "function" && a.matches(location),
    );
  }

  const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();
  const labelOf = (el) => clean(el.getAttribute("aria-label") || el.innerText || el.title || "");

  function visible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  /** A same-site link to a page moves around rather than acting; null otherwise. */
  function sameSiteLink(el) {
    if (el.tagName !== "A") return null;
    const raw = el.getAttribute("href");
    if (!raw || raw.startsWith("#")) return null;
    try {
      const url = new URL(el.href);
      return url.origin === location.origin ? url : null;
    } catch {
      return null;
    }
  }

  const isSubmit = (el) =>
    el.tagName === "BUTTON" && el.form && (el.type === "submit" || el.type === "reset");

  /**
   * Why an element may not be offered or clicked, or null if it may. A same-site
   * link is judged by its address, so a channel called "post-mortems" opens but
   * a link to /logout doesn't; anything else is judged by its label.
   */
  function refusal(el, rules, { needsLabel = true } = {}) {
    if (el.disabled) return "That control is disabled.";
    if (isSubmit(el)) return "That control submits or resets a form, so Yarvis won't click it.";
    if (
      el.matches(FORM_CONTROL) ||
      el.isContentEditable ||
      (el.tagName === "LABEL" && el.control)
    ) {
      return "That is a form control; Yarvis doesn't change settings or fill in forms.";
    }
    if (el.tagName === "A" && el.hasAttribute("download")) {
      return "That link downloads a file, so Yarvis won't open it.";
    }
    const link = sameSiteLink(el);
    if (link) {
      return rules.blockedPath.test(link.pathname + link.search)
        ? "That link changes something on the site, so Yarvis won't open it."
        : null;
    }
    const label = labelOf(el);
    if (!label && needsLabel) {
      return "Something without a label would take that click, so Yarvis won't click it.";
    }
    return rules.blocked.test(label)
      ? "That control changes or sends something, so Yarvis won't click it."
      : null;
  }

  function rulesFrom({ blockedSource, blockedPathSource }) {
    return {
      blocked: new RegExp(blockedSource, "i"),
      blockedPath: new RegExp(blockedPathSource, "i"),
    };
  }

  /**
   * Why a selector's attribute tests aren't allowed, or null. Every [...] group
   * is read out, skipping brackets inside quoted strings, and each must parse as
   * a plain attribute test; one that compares a value must be on an attribute
   * whose value isn't something inspect keeps back.
   */
  function attributeRefusal(selector) {
    const allowed =
      "Selectors can match attribute values only on role, id, class, type, title, tabindex, aria-* and data-qa/data-testid";
    if (selector.includes("\\") || selector.includes("/*")) {
      return "Selectors can't contain escapes or comments.";
    }
    let quote = null;
    let start = -1;
    for (let i = 0; i < selector.length; i++) {
      const ch = selector[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "[") {
        if (start !== -1) return "That selector's brackets don't balance.";
        start = i;
      } else if (ch === "]") {
        if (start === -1) return "That selector's brackets don't balance.";
        const group = selector.slice(start + 1, i);
        start = -1;
        const parsed = group.match(ATTRIBUTE_GROUP);
        if (!parsed)
          return `${allowed}, written plainly like [role="button"]; can't use [${group}].`;
        if (HAS_OPERATOR.test(group) && !MATCHABLE_ATTRIBUTE.test(parsed[1])) {
          return `${allowed}, not ${parsed[1]}. [${parsed[1]}] on its own is fine.`;
        }
      }
    }
    if (quote || start !== -1) return "That selector's quotes or brackets don't balance.";
    return null;
  }

  /** querySelectorAll that reports a bad or disallowed selector as an error the agent can fix. */
  function select(selector, root = document) {
    const refused = attributeRefusal(selector);
    if (refused) return { error: refused };
    try {
      return { nodes: [...root.querySelectorAll(selector)] };
    } catch (error) {
      return { error: `That selector isn't valid CSS: ${error.message}` };
    }
  }

  /**
   * The page's title, or the adapter's version of it: Gmail's carries the
   * account's address ("Inbox (2) - you@example.com - Mail"), which no answer
   * needs.
   */
  function pageTitle() {
    try {
      return adapter()?.title?.() ?? document.title;
    } catch {
      return document.title;
    }
  }

  function readPage({ maxChars }) {
    const base = {
      url: location.href,
      title: pageTitle(),
      selection: String(getSelection() ?? ""),
    };
    const site = adapter();
    let adapterNote;
    if (site?.readPage) {
      try {
        // The adapter fits its own text to maxChars, since only it knows which
        // end matters (for a chat, the newest messages).
        const read = site.readPage({ maxChars });
        if (read)
          return { ...base, adapter: site.name, text: read.text, truncated: read.truncated };
        adapterNote = `The ${site.name} reader found nothing it recognises here, so this is the plain page text.`;
      } catch (error) {
        adapterNote = `The ${site.name} reader failed (${String(error?.message).slice(0, 120)}), so this is the plain page text.`;
      }
    }
    const text = document.body?.innerText ?? "";
    return {
      ...base,
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
      ...(adapterNote ? { adapterNote } : {}),
    };
  }

  function describe(el, label) {
    const site = adapter();
    let extra = {};
    try {
      extra = site?.describeElement?.(el) ?? {};
    } catch {
      // An adapter that trips over one element shouldn't lose the listing.
    }
    return {
      // The role is page-controlled text that lands in the listing as-is, so only
      // a plain word is kept: one with quotes or a newline could fake a line.
      kind:
        el.tagName === "A"
          ? "link"
          : /^[a-z]+$/.test(el.getAttribute("role") ?? "")
            ? el.getAttribute("role")
            : "button",
      label,
      ...(el.tagName === "A" ? { href: el.href } : {}),
      ...extra,
    };
  }

  /**
   * Numbers each thing worth clicking and remembers the element, so a later click
   * names a number instead of a selector the page could have changed under us.
   * A custom selector lists what it matches instead of the usual controls, under
   * the same screens; `text` keeps only labels containing it.
   */
  function listElements({ maxElements, selector, text, ...rules }) {
    const screens = rulesFrom(rules);
    resetRefs();
    const found = select(selector || CLICKABLE);
    if (found.error) return { error: found.error };
    const wanted = text ? text.toLowerCase() : null;

    const elements = [];
    let truncated = false;
    let skipped = 0;
    for (const el of found.nodes) {
      if (!visible(el)) continue;
      const label = labelOf(el).slice(0, LABEL_CHARS);
      if (wanted && !label.toLowerCase().includes(wanted)) continue;
      if (refusal(el, screens)) {
        skipped++;
        continue;
      }
      if (elements.length >= maxElements) {
        truncated = true;
        break;
      }
      elements.push({ ref: remember(el), ...describe(el, label) });
    }

    // Message lists and side panels scroll on their own, not with the window.
    if (!selector && !text) {
      let scrollers = 0;
      for (const el of document.querySelectorAll("div,main,section,ul,ol")) {
        if (scrollers >= 10) break;
        if (el.clientHeight < 200 || el.scrollHeight <= el.clientHeight + 50) continue;
        const overflow = getComputedStyle(el).overflowY;
        if (overflow !== "auto" && overflow !== "scroll") continue;
        scrollers++;
        elements.push({
          ref: remember(el, { scroll: true }),
          kind: "scroll",
          label: (el.getAttribute("aria-label") || el.getAttribute("role") || el.tagName).slice(
            0,
            LABEL_CHARS,
          ),
        });
      }
    }

    const site = adapter();
    return {
      url: location.href,
      title: pageTitle(),
      ...(site ? { adapter: site.name } : {}),
      elements,
      truncated,
      ...(skipped ? { skipped } : {}),
    };
  }

  /**
   * Attributes worth showing when working out how a page is built: names, roles,
   * labels, test hooks and ids. Not values that carry data (value, src, content)
   * or arbitrary data-* attributes, which on many sites hold signed URLs and
   * tokens.
   */
  const SHOWN_ATTRIBUTE =
    /^(?:id|class|role|type|name|title|tabindex|href|aria-[\w-]+|data-qa[\w-]*|data-testid|data-[\w-]*-id)$/i;

  function attributesOf(el) {
    const out = {};
    for (const { name, value } of el.attributes) {
      if (!SHOWN_ATTRIBUTE.test(name)) continue;
      // Query strings and fragments carry tokens; the path is enough to tell addresses apart.
      const looksLikeAddress = name === "href" || /^(?:https?:)?\/\//i.test(value);
      out[name] = (looksLikeAddress ? value.replace(/[?#].*$/, "") : value).slice(0, 200);
    }
    return out;
  }

  /**
   * What a selector matches, for an agent working out why a listing or click
   * didn't do what it expected. Each match gets a ref it can click or scroll.
   */
  function inspect({ selector, limit, ...rules }) {
    const screens = rulesFrom(rules);
    const found = select(selector);
    if (found.error) return { error: found.error };
    const inspectable = found.nodes.filter(
      (el) => !UNINSPECTABLE.has(el.tagName) && document.body?.contains(el),
    );
    const matches = inspectable.slice(0, limit).map((el) => {
      const rect = el.getBoundingClientRect();
      const control = el.closest(CLICKABLE);
      const shown = visible(el);
      // The same checks click() runs, without the hit test (which needs the
      // element scrolled into view), so "refused" means a click would be.
      const screened = screenClick(el, el, screens);
      return {
        ref: remember(el),
        tag: el.tagName.toLowerCase(),
        attributes: attributesOf(el),
        // innerText of something not rendered is its raw text, hidden content included.
        text: shown ? clean(el.innerText).slice(0, 200) : "",
        visible: shown,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        clickable: Boolean(control),
        ...(screened.error ? { refused: screened.error } : {}),
        children: [...el.children].slice(0, 10).map((child) => {
          const role = child.getAttribute("role");
          const qa = child.getAttribute("data-qa");
          return [child.tagName.toLowerCase(), role && `[role=${role}]`, qa && `[data-qa=${qa}]`]
            .filter(Boolean)
            .join("");
        }),
        childCount: el.children.length,
      };
    });
    return {
      url: location.href,
      title: pageTitle(),
      count: inspectable.length,
      matches,
    };
  }

  /**
   * Whether a click on `el` that lands on `target` may go ahead. Everything the
   * click can activate on its way up is screened: the target, each control
   * between it and the chosen element's own control, and that control — so an
   * icon-only delete button in a row, or a label that toggles a checkbox, is
   * refused rather than trusted. inspect() runs the same checks to report why a
   * click would be refused.
   */
  function screenClick(el, target, screens) {
    if (!visible(el)) return { error: "That element isn't visible, so Yarvis won't click it." };
    // Any kind of control counts here, labels included: a span inside a
    // <label> passes its click on to the label's checkbox.
    const ownControl = el.closest(CONTROL);
    if (!ownControl && labelOf(el).length > MAX_PLAIN_LABEL) {
      return {
        error:
          "That element holds too much to click safely (it looks like a container). Inspect it and pick something smaller inside it.",
      };
    }
    const stop = ownControl ?? el;
    const reached = new Set([el, stop]);
    for (let node = target; node; node = node.parentElement) {
      if (node.matches(CONTROL)) reached.add(node);
      if (node === stop) break;
    }
    // Past the chosen element's own control, only what a click activates by
    // itself, plus toggle widgets, which act on a click bubbling up from inside
    // them. A whole [onclick] sidebar above a row shouldn't refuse the row.
    for (let node = stop.parentElement; node; node = node.parentElement) {
      if (node.matches(`${ACTIVATES},${FORM_CONTROL}`)) reached.add(node);
    }
    for (const node of reached) {
      const why = refusal(node, screens);
      if (why) return { error: why };
    }

    const anchor = target.closest("a[href]");
    if (anchor) {
      let url;
      try {
        url = new URL(anchor.href);
      } catch {
        return { error: "That link has no usable address." };
      }
      if (url.origin !== location.origin) {
        return { error: "That link leaves this site. Yarvis stays on the current site." };
      }
      if (anchor.target && anchor.target !== "_self") {
        return { error: "That link opens a new tab. Yarvis works in the current tab only." };
      }
      if (anchor.hasAttribute("download")) {
        return { error: "That link downloads a file, so Yarvis won't open it." };
      }
    }
    return {};
  }

  function resolve({ ref, selector, index = 0 }) {
    if (ref !== undefined && ref !== null) {
      const el = state.byRef.get(ref);
      if (!el || !el.isConnected) {
        return { error: "That element is gone. List the page's elements again." };
      }
      return { el, fromScrollRef: state.scrollRefs.has(ref) };
    }
    const found = select(selector);
    if (found.error) return { error: found.error };
    if (found.nodes.length === 0) return { error: `Nothing on the page matches ${selector}.` };
    const el = found.nodes[index];
    if (!el) {
      return {
        error: `${selector} matches ${found.nodes.length} elements; index ${index} is past the end.`,
      };
    }
    return { el, fromScrollRef: false };
  }

  /**
   * Screens and clicks. `center` clicks the element under the middle of the chosen
   * one, which is where a person's click lands: apps like Slack put the handler
   * on something inside a sidebar row, and an event sent to the row itself only
   * bubbles up, never down to it. `direct` sends the events to the chosen element
   * itself, for when something else covers its middle. `hover` only moves the
   * pointer over it, to show menus and buttons that appear on hover.
   */
  function click({ ref, selector, index, mode = "center", ...rules }) {
    const screens = rulesFrom(rules);
    const chosen = resolve({ ref, selector, index });
    if (chosen.error) return chosen;
    const { el } = chosen;
    if (chosen.fromScrollRef) {
      return {
        error: "That ref is a scrollable panel, not something to click. Use scroll_browser_page.",
      };
    }

    el.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    let target = el;
    if (mode === "center") {
      const hit = document.elementFromPoint(x, y);
      // Something covering that point (a toast, a modal) doesn't get the click.
      if (hit && el.contains(hit)) target = hit;
    }
    const screened = screenClick(el, target, screens);
    if (screened.error) return screened;

    const base = {
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      view: window,
    };
    const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true };
    const fire = (type, init) => {
      const Kind = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      const event = new Kind(type, { ...base, ...pointer, bubbles: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    fire("pointerover", { buttons: 0 });
    fire("pointerenter", { buttons: 0, bubbles: false });
    fire("mouseover", { buttons: 0 });
    fire("mouseenter", { buttons: 0, bubbles: false });
    fire("pointermove", { buttons: 0 });
    fire("mousemove", { buttons: 0 });
    const clicked = {
      tag: target.tagName.toLowerCase(),
      label: labelOf(target).slice(0, LABEL_CHARS),
    };
    // A hover leaves the pointer where it is, so whatever it revealed stays up.
    if (mode === "hover") return { ok: true, clicked };

    // The sequence a real mouse click produces; some apps act on pointerdown or
    // mousedown and never look at the click.
    fire("pointerdown", { buttons: 1, detail: 1 });
    const down = fire("mousedown", { buttons: 1, detail: 1 });
    // The browser focuses the nearest focusable element unless mousedown was cancelled.
    // Never a text field: nothing is typed, but a focused composer is one keypress from sending.
    const focusable = target.closest("a[href],button,[tabindex],summary");
    if (!down.defaultPrevented && focusable) focusable.focus({ preventScroll: true });
    fire("pointerup", { buttons: 0, detail: 1 });
    fire("mouseup", { buttons: 0, detail: 1 });
    fire("click", { buttons: 0, detail: 1 });
    // Moved off afterwards, so no hover state is left to reveal buttons on the row.
    fire("pointerout", { buttons: 0 });
    fire("pointerleave", { buttons: 0, bubbles: false });
    fire("mouseout", { buttons: 0 });
    fire("mouseleave", { buttons: 0, bubbles: false });
    return { ok: true, clicked };
  }

  function scroll({ ref, direction }) {
    const el =
      ref === null || ref === undefined
        ? document.scrollingElement || document.documentElement
        : state.byRef.get(ref);
    if (!el || !el.isConnected) {
      return { error: "That element is gone. List the page's elements again." };
    }
    const step = el.clientHeight * 0.8;
    if (direction === "up") el.scrollBy({ top: -step });
    else if (direction === "down") el.scrollBy({ top: step });
    else if (direction === "top") el.scrollTop = 0;
    else if (direction === "bottom") el.scrollTop = el.scrollHeight;
    // Any other direction ("stay") only reports where the panel is.
    return {
      atTop: el.scrollTop <= 0,
      atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
    };
  }

  globalThis.__yarvis = { readPage, listElements, inspect, click, scroll };
})();

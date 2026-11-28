// The page side of the Android terminal. It only ever sees terminal bytes:
// the socket and the device token stay in Kotlin, which feeds output in through
// `window.yarvis` and hears keystrokes and sizes back through `YarvisBridge`.
(() => {
  const bridge = window.YarvisBridge;
  const params = new URLSearchParams(location.search);
  const clampFont = (n) => Math.min(32, Math.max(6, Number(n) || 12));

  const term = new Terminal({
    fontFamily: "monospace",
    fontSize: clampFont(params.get("fontSize")),
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: "#1e1e1e" },
    // OSC 8 links would otherwise confirm() and window.open(), and this page has nowhere to go.
    linkHandler: { activate() {} },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const container = document.getElementById("terminal");
  term.open(container);

  // Keep Android keyboards from composing whole words before xterm sees them.
  const textarea = container.querySelector("textarea");
  if (textarea) {
    for (const [name, value] of [
      ["autocomplete", "off"],
      ["autocorrect", "off"],
      ["autocapitalize", "off"],
      ["spellcheck", "false"],
    ]) {
      textarea.setAttribute(name, value);
    }
  }

  term.onData((data) => bridge.onData(data));
  term.onBinary((data) => bridge.onBinary(data));
  term.onResize(({ cols, rows }) => bridge.onResize(cols, rows));

  let appCursor = false;
  const reportModes = () => {
    const now = term.modes.applicationCursorKeysMode;
    if (now !== appCursor) {
      appCursor = now;
      bridge.onModes(now);
    }
  };

  const refit = () => {
    if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit();
  };
  new ResizeObserver(refit).observe(container);

  // xterm 6 doesn't scroll on touch, so a vertical drag scrolls the scrollback and a tap focuses.
  let touchY = null;
  let moved = false;
  container.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      touchY = e.touches[0].clientY;
      moved = false;
    },
    { passive: true },
  );
  container.addEventListener(
    "touchmove",
    (e) => {
      if (touchY === null || e.touches.length !== 1) return;
      const cellHeight =
        term.element.querySelector(".xterm-rows")?.firstElementChild?.offsetHeight || 16;
      const lines = Math.trunc((touchY - e.touches[0].clientY) / cellHeight);
      if (lines !== 0) {
        moved = true;
        term.scrollLines(lines);
        touchY -= lines * cellHeight;
      }
      e.preventDefault();
    },
    { passive: false },
  );
  container.addEventListener("touchend", () => {
    if (touchY !== null && !moved) {
      term.focus();
      bridge.onTap();
    }
    touchY = null;
  });

  const decode = (b64) => {
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  };

  window.yarvis = {
    write(b64) {
      term.write(decode(b64), reportModes);
    },
    reset() {
      term.reset();
      reportModes();
    },
    setFontSize(size) {
      term.options.fontSize = clampFont(size);
      refit();
    },
    focus() {
      term.focus();
    },
  };

  refit();
  bridge.onResize(term.cols, term.rows);
  bridge.onReady();
})();

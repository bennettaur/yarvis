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
  window.addEventListener("resize", refit);

  // Touch scrolling is done here, in one place. xterm bundles VS Code's gesture
  // handler, which listens on the document and scrolls too; two scrollers on one
  // drag fight and leave the rows half redrawn. So touches stop at the container.
  const cellHeight = () =>
    term.element.querySelector(".xterm-rows")?.firstElementChild?.offsetHeight || 16;

  // Lines in the scrollback, or, for a full-screen app with none (vim, less,
  // htop), wheel events, which xterm turns into mouse reports or arrow keys.
  const scrollBy = (lines) => {
    if (term.buffer.active.type === "normal") {
      term.scrollLines(lines);
    } else {
      const target = term.element.querySelector(".xterm-screen") || term.element;
      for (let i = 0; i < Math.abs(lines); i++) {
        target.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: Math.sign(lines) * cellHeight(),
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    }
  };

  let touchY = null;
  let moved = false;
  let leftover = 0; // Pixels dragged that don't yet make a whole line.
  let velocity = 0; // Pixels a millisecond, positive when dragging up.
  let lastMove = 0;
  let fling = 0;

  const stopFling = () => {
    if (fling) cancelAnimationFrame(fling);
    fling = 0;
  };

  const scrollPixels = (dy) => {
    leftover += dy;
    const lines = Math.trunc(leftover / cellHeight());
    if (lines !== 0) {
      leftover -= lines * cellHeight();
      scrollBy(lines);
    }
  };

  const listen = (type, handler) =>
    container.addEventListener(
      type,
      (e) => {
        e.stopPropagation();
        handler(e);
      },
      { capture: true, passive: false },
    );

  listen("touchstart", (e) => {
    stopFling();
    if (e.touches.length !== 1) return;
    touchY = e.touches[0].clientY;
    moved = false;
    leftover = 0;
    velocity = 0;
    lastMove = e.timeStamp;
  });
  listen("touchmove", (e) => {
    e.preventDefault();
    if (touchY === null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const dy = touchY - y;
    if (!moved && Math.abs(dy) < 8) return; // A tap that wobbled.
    moved = true;
    const dt = Math.max(1, e.timeStamp - lastMove);
    velocity = 0.8 * (dy / dt) + 0.2 * velocity;
    lastMove = e.timeStamp;
    touchY = y;
    scrollPixels(dy);
  });
  listen("touchend", (e) => {
    if (touchY !== null && !moved) {
      term.focus();
      bridge.onTap();
    } else if (moved && e.timeStamp - lastMove < 100 && Math.abs(velocity) > 0.3) {
      // Keep going after a quick swipe, slowing to a stop.
      let last = performance.now();
      const step = (now) => {
        const dt = now - last;
        last = now;
        scrollPixels(velocity * dt);
        velocity *= 0.995 ** dt;
        fling = Math.abs(velocity) > 0.05 ? requestAnimationFrame(step) : 0;
      };
      fling = requestAnimationFrame(step);
    }
    touchY = null;
  });
  listen("touchcancel", () => {
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

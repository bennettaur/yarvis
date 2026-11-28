# Terminal page

The page the terminal screen's WebView loads (`ui/terminal/TerminalWebView.kt`),
served from this folder by `WebViewAssetLoader` and nothing else.

- `terminal.html` and `terminal.js` are ours: the bridge between xterm.js and Kotlin.
- `xterm.js` and `xterm.css` are `@xterm/xterm` 6.0.0 (`lib/xterm.js`, `css/xterm.css`),
  MIT licensed (`LICENSE-xterm`).
- `addon-fit.js` is `@xterm/addon-fit` 0.11.0 (`lib/addon-fit.js`), MIT licensed
  (`LICENSE-addon-fit`).

The xterm files are copied in rather than taken from `node_modules` at build time,
because CI's Android job doesn't run `bun install`. To update them, bump the
packages in the repo root's `package.json`, run `bun install`, then from the repo root:

```sh
cp node_modules/@xterm/xterm/lib/xterm.js node_modules/@xterm/xterm/css/xterm.css \
   node_modules/@xterm/addon-fit/lib/addon-fit.js apps/android/app/src/main/assets/terminal/
cp node_modules/@xterm/xterm/LICENSE apps/android/app/src/main/assets/terminal/LICENSE-xterm
cp node_modules/@xterm/addon-fit/LICENSE apps/android/app/src/main/assets/terminal/LICENSE-addon-fit
```

and update the versions above.

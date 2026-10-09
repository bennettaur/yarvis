# Showcase video

Two animated cuts of the Yarvis showcase, built with [Remotion](https://www.remotion.dev):

- **Reel**: about 90 seconds. Setting the week's priorities, start work,
  parallel workspaces, "where did we leave off", merging main into every PR,
  PR review, alarms, and the Friday wrap-up.
- **Walkthrough**: about 3½ minutes. Everything in the reel, plus projects,
  "what should I work on next", what the assistant can see, Omni Chat and Omni
  view, voice, the integrations, and the habits that make it useful.

The scenes render the app's real React components where they are driven only by
props: the nav rail, `ChatMessages`, `ChatComposer`, `ToolApprovalBar`,
`PrGuidePanel`, the diff parser and highlighter, `WorkspacePrBadges`,
`ReviewCommentCard`, `VoiceControls` and the Omni widget frames. Views that
fetch their own data (the workspace detail, the attention panel, the calendar)
are copies of the app's markup with the same Tailwind classes. Everything shown
is scripted data.

## Licence

Remotion is free for individuals and for companies of up to three people.
Larger for-profit companies need a [company licence](https://www.remotion.pro/license).

## Commands

Run from this directory. It is a separate package from the app, with its own
`bun.lock`. The scenes import from the app's `src/`, so run `bun install` at the
repo root first as well.

```bash
bun install
bun run studio            # Remotion Studio: scrub, edit and preview each scene
bun run render            # both MP4s into out/
bun run player:dev        # the web player page
bun run player:build      # the web player page as static files in dist/
bun run typecheck         # after changing a component the scenes import from src/
bun run publish:videos    # upload out/*.mp4 to the showcase-video release
```

Rendering needs Chrome Headless Shell. Remotion downloads it on first use, or
you can point it at an existing one with `--browser-executable`. Render on a
Mac: the captions use the system font and the terminal uses Menlo, so another OS
lays the text out differently.

## Publishing

The player page is published at <https://bennettaur.github.io/yarvis/video/>,
beside the recorded demos and the slide deck. The `Demo site` workflow
(`.github/workflows/demo-pages.yml`) builds it into the Pages site each time it
runs; see `demo/README.md` for when that is. Locally, `bun run player:build` here,
then `bun run demo` and `bun run demo:site` at the repo root, put it in
`demo/site/video/`.

The MP4s are not in git. Render them on a Mac, then run `bun run publish:videos`
to replace the files on the `showcase-video` release, which the page links to.

## Layout

- `src/videos.tsx`: the scene list. Each scene says how long it runs and
  whether the reel includes it. The walkthrough has every scene.
- `src/scenes/`: one file per scene, or a few related ones per file.
- `src/screens/`: the app views the scenes put in the window.
- `src/components/`: the camera and its preset shots, the app window and the
  scene wrapper around it, the backdrop, captions, the cursor, and the scripted
  terminal.
- `src/lib/timing.ts`: frame rate, sizes, and the easing and typing helpers
  every scene uses.
- `src/lib/chatScript.ts`: turns a scripted conversation into the props
  `ChatMessages` would have at a given frame, so typing, tool calls and
  streaming look live.
- `player/`: the web page that plays both cuts with `@remotion/player`.

Each scene is also its own composition under **Scenes** in the Studio, at its
walkthrough length, so you can work on one without scrubbing through the rest.

## Swapping in screenshots

A scene's window content is ordinary JSX, so a real screenshot can replace a
screen: put the image in `src/assets/`, import it, and render it with
Remotion's `<Img>` in place of the screen component.

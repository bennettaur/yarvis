import { Player } from "@remotion/player";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { FPS, HEIGHT, WIDTH } from "../src/lib/timing";
import { ShowcaseVideo, totalFrames } from "../src/videos";

/** Where `bun run publish:videos` uploads the rendered MP4s. */
const RELEASE = "https://github.com/bennettaur/yarvis/releases/download/showcase-video";

const CUTS = [
  { walkthrough: false, label: "90-second reel", mp4: `${RELEASE}/yarvis-reel.mp4` },
  { walkthrough: true, label: "Full walkthrough", mp4: `${RELEASE}/yarvis-walkthrough.mp4` },
];

const LINK = "text-indigo-400 hover:underline";

/** The showcase page: both cuts of the video in Remotion's player, with a toggle between them. */
function App() {
  const [walkthrough, setWalkthrough] = useState(false);
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-5 px-6 py-10 text-zinc-100">
      <header className="flex flex-wrap items-end gap-4">
        <div className="mr-auto">
          <h1 className="text-3xl font-bold tracking-tight">Yarvis</h1>
          <p className="text-zinc-400">
            Running the week with an assistant that can start the work.
          </p>
        </div>
        <div className="inline-flex overflow-hidden rounded-md border border-zinc-700">
          {CUTS.map((cut) => (
            <button
              key={cut.label}
              type="button"
              onClick={() => setWalkthrough(cut.walkthrough)}
              className={`px-4 py-2 text-sm ${
                cut.walkthrough === walkthrough
                  ? "bg-indigo-600 text-white"
                  : "text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              {cut.label}
            </button>
          ))}
        </div>
      </header>
      <Player
        // A new key per cut restarts the player at frame 0 with the new length.
        key={String(walkthrough)}
        component={ShowcaseVideo}
        inputProps={{ walkthrough }}
        durationInFrames={totalFrames(walkthrough)}
        fps={FPS}
        compositionWidth={WIDTH}
        compositionHeight={HEIGHT}
        style={{ width: "100%", aspectRatio: `${WIDTH} / ${HEIGHT}` }}
        controls
        clickToPlay
        doubleClickToFullscreen
      />
      <p className="text-sm text-zinc-500">
        Rendered from the app's own React components with scripted data. Download the MP4:{" "}
        {CUTS.map((cut, i) => (
          <span key={cut.label}>
            {i > 0 && " · "}
            <a className={LINK} href={cut.mp4}>
              {cut.label.toLowerCase()}
            </a>
          </span>
        ))}
        {/* Relative to the Pages site, where this page is served from video/. */}. More: the{" "}
        <a className={LINK} href="../">
          recorded demos
        </a>
        , the{" "}
        <a className={LINK} href="../showcase/">
          slide deck
        </a>
        , and the source at{" "}
        <a className={LINK} href="https://github.com/bennettaur/yarvis">
          github.com/bennettaur/yarvis
        </a>
        .
      </p>
    </main>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

import { Player } from "@remotion/player";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { FPS, HEIGHT, WIDTH } from "../src/lib/timing";
import { ShowcaseVideo, totalFrames } from "../src/videos";

const CUTS = [
  { walkthrough: false, label: "90-second reel" },
  { walkthrough: true, label: "Full walkthrough" },
];

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
        Rendered from the app's own React components with scripted data.
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

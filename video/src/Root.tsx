import { Composition, Folder } from "remotion";
import "./styles.css";
import { FPS, HEIGHT, WIDTH } from "./lib/timing";
import { SCENES, ShowcaseVideo, totalFrames } from "./videos";

const SIZE = { fps: FPS, width: WIDTH, height: HEIGHT };

/** One scene from the list, at its walkthrough length. */
const SceneOnly = ({ id }: { id: string }) => <>{SCENES.find((s) => s.id === id)?.render(true)}</>;

export const Root = () => (
  <>
    <Composition
      id="Reel"
      component={ShowcaseVideo}
      defaultProps={{ walkthrough: false }}
      durationInFrames={totalFrames(false)}
      {...SIZE}
    />
    <Composition
      id="Walkthrough"
      component={ShowcaseVideo}
      defaultProps={{ walkthrough: true }}
      durationInFrames={totalFrames(true)}
      {...SIZE}
    />
    {/* Each scene on its own, in its walkthrough length, for working on one at a time. */}
    <Folder name="Scenes">
      {SCENES.map((scene) => (
        <Composition
          key={scene.id}
          id={`scene-${scene.id}`}
          component={SceneOnly}
          defaultProps={{ id: scene.id }}
          durationInFrames={scene.frames(true)}
          {...SIZE}
        />
      ))}
    </Folder>
  </>
);

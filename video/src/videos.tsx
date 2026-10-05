import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import type { ReactNode } from "react";
import { Alarm, alarmFrames } from "./scenes/Alarm";
import {
  Friday,
  fridayFrames,
  LeftOff,
  leftOffFrames,
  MergeMain,
  mergeFrames,
  Plan,
  planFrames,
} from "./scenes/ChatMoments";
import { INTRO_FRAMES, Intro } from "./scenes/Intro";
import { Monday, mondayFrames } from "./scenes/Monday";
import { OmniChat, OmniView, omniChatFrames, omniViewFrames } from "./scenes/Omni";
import { OUTRO_FRAMES, Outro } from "./scenes/Outro";
import { Parallel, parallelFrames } from "./scenes/Parallel";
import { Problem, problemFrames } from "./scenes/Problem";
import { Projects, projectsFrames } from "./scenes/Projects";
import { PrReview, prReviewFrames } from "./scenes/PrReview";
import {
  Edges,
  edgesFrames,
  Habits,
  habitsFrames,
  Visibility,
  visibilityFrames,
} from "./scenes/Slides";
import { StartWork, startWorkFrames } from "./scenes/StartWork";
import { Voice, voiceFrames } from "./scenes/Voice";

export interface SceneDef {
  id: string;
  /** Length in frames; the walkthrough gives most scenes longer to read. */
  frames: (full: boolean) => number;
  render: (full: boolean) => ReactNode;
  /** Whether the 90-second reel includes this scene. The walkthrough has them all. */
  inReel: boolean;
}

export const SCENES: SceneDef[] = [
  { id: "intro", frames: () => INTRO_FRAMES, render: () => <Intro />, inReel: true },
  { id: "problem", frames: problemFrames, render: (full) => <Problem full={full} />, inReel: true },
  { id: "monday", frames: mondayFrames, render: (full) => <Monday full={full} />, inReel: true },
  { id: "projects", frames: projectsFrames, render: () => <Projects />, inReel: false },
  {
    id: "start-work",
    frames: startWorkFrames,
    render: (full) => <StartWork full={full} />,
    inReel: true,
  },
  {
    id: "parallel",
    frames: parallelFrames,
    render: (full) => <Parallel full={full} />,
    inReel: true,
  },
  {
    id: "left-off",
    frames: leftOffFrames,
    render: (full) => <LeftOff full={full} />,
    inReel: true,
  },
  { id: "plan", frames: planFrames, render: () => <Plan />, inReel: false },
  {
    id: "merge-main",
    frames: mergeFrames,
    render: (full) => <MergeMain full={full} />,
    inReel: true,
  },
  { id: "visibility", frames: visibilityFrames, render: () => <Visibility />, inReel: false },
  {
    id: "pr-review",
    frames: prReviewFrames,
    render: (full) => <PrReview full={full} />,
    inReel: true,
  },
  { id: "omni-chat", frames: omniChatFrames, render: () => <OmniChat />, inReel: false },
  { id: "omni-view", frames: omniViewFrames, render: () => <OmniView />, inReel: false },
  { id: "voice", frames: voiceFrames, render: () => <Voice />, inReel: false },
  { id: "alarm", frames: alarmFrames, render: (full) => <Alarm full={full} />, inReel: true },
  { id: "edges", frames: edgesFrames, render: () => <Edges />, inReel: false },
  { id: "friday", frames: fridayFrames, render: (full) => <Friday full={full} />, inReel: true },
  { id: "habits", frames: habitsFrames, render: () => <Habits />, inReel: false },
  { id: "outro", frames: () => OUTRO_FRAMES, render: () => <Outro />, inReel: true },
];

const TRANSITION = 12;

const scenesFor = (full: boolean) => SCENES.filter((s) => full || s.inReel);

export function totalFrames(full: boolean) {
  const scenes = scenesFor(full);
  return scenes.reduce((sum, s) => sum + s.frames(full), 0) - TRANSITION * (scenes.length - 1);
}

/** Every scene in order, cross-faded. `full` picks the walkthrough over the reel. */
export function ShowcaseVideo({ full }: { full: boolean }) {
  const scenes = scenesFor(full);
  return (
    <TransitionSeries>
      {scenes.flatMap((scene, i) => [
        <TransitionSeries.Sequence key={scene.id} durationInFrames={scene.frames(full)}>
          {scene.render(full)}
        </TransitionSeries.Sequence>,
        i < scenes.length - 1 ? (
          <TransitionSeries.Transition
            key={`${scene.id}-out`}
            presentation={fade()}
            timing={linearTiming({ durationInFrames: TRANSITION })}
          />
        ) : null,
      ])}
    </TransitionSeries>
  );
}

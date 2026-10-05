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
import { Intro, introFrames } from "./scenes/Intro";
import { Monday, mondayFrames } from "./scenes/Monday";
import { OmniChat, OmniView, omniChatFrames, omniViewFrames } from "./scenes/Omni";
import { Outro, outroFrames } from "./scenes/Outro";
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
  frames: (walkthrough: boolean) => number;
  render: (walkthrough: boolean) => ReactNode;
  /** Whether the 90-second reel includes this scene. The walkthrough has them all. */
  inReel: boolean;
}

export const SCENES: SceneDef[] = [
  { id: "intro", frames: introFrames, render: () => <Intro />, inReel: true },
  {
    id: "problem",
    frames: problemFrames,
    render: (walkthrough) => <Problem walkthrough={walkthrough} />,
    inReel: true,
  },
  {
    id: "monday",
    frames: mondayFrames,
    render: (walkthrough) => <Monday walkthrough={walkthrough} />,
    inReel: true,
  },
  { id: "projects", frames: projectsFrames, render: () => <Projects />, inReel: false },
  {
    id: "start-work",
    frames: startWorkFrames,
    render: (walkthrough) => <StartWork walkthrough={walkthrough} />,
    inReel: true,
  },
  {
    id: "parallel",
    frames: parallelFrames,
    render: (walkthrough) => <Parallel walkthrough={walkthrough} />,
    inReel: true,
  },
  {
    id: "left-off",
    frames: leftOffFrames,
    render: (walkthrough) => <LeftOff walkthrough={walkthrough} />,
    inReel: true,
  },
  { id: "plan", frames: planFrames, render: () => <Plan />, inReel: false },
  {
    id: "merge-main",
    frames: mergeFrames,
    render: (walkthrough) => <MergeMain walkthrough={walkthrough} />,
    inReel: true,
  },
  { id: "visibility", frames: visibilityFrames, render: () => <Visibility />, inReel: false },
  {
    id: "pr-review",
    frames: prReviewFrames,
    render: (walkthrough) => <PrReview walkthrough={walkthrough} />,
    inReel: true,
  },
  { id: "omni-chat", frames: omniChatFrames, render: () => <OmniChat />, inReel: false },
  { id: "omni-view", frames: omniViewFrames, render: () => <OmniView />, inReel: false },
  { id: "voice", frames: voiceFrames, render: () => <Voice />, inReel: false },
  {
    id: "alarm",
    frames: alarmFrames,
    render: (walkthrough) => <Alarm walkthrough={walkthrough} />,
    inReel: true,
  },
  { id: "edges", frames: edgesFrames, render: () => <Edges />, inReel: false },
  {
    id: "friday",
    frames: fridayFrames,
    render: (walkthrough) => <Friday walkthrough={walkthrough} />,
    inReel: true,
  },
  { id: "habits", frames: habitsFrames, render: () => <Habits />, inReel: false },
  { id: "outro", frames: outroFrames, render: () => <Outro />, inReel: true },
];

const TRANSITION_FRAMES = 12;

const scenesFor = (walkthrough: boolean) => SCENES.filter((s) => walkthrough || s.inReel);

export function totalFrames(walkthrough: boolean) {
  const scenes = scenesFor(walkthrough);
  // TransitionSeries overlaps the scenes either side of each transition, so
  // every cross-fade shortens the total.
  const overlap = TRANSITION_FRAMES * (scenes.length - 1);
  return scenes.reduce((sum, s) => sum + s.frames(walkthrough), 0) - overlap;
}

/** Every scene in order, cross-faded: the walkthrough cut, or the reel. */
export function ShowcaseVideo({ walkthrough }: { walkthrough: boolean }) {
  const scenes = scenesFor(walkthrough);
  return (
    <TransitionSeries>
      {scenes.flatMap((scene, i) => [
        <TransitionSeries.Sequence key={scene.id} durationInFrames={scene.frames(walkthrough)}>
          {scene.render(walkthrough)}
        </TransitionSeries.Sequence>,
        i < scenes.length - 1 ? (
          <TransitionSeries.Transition
            key={`${scene.id}-out`}
            presentation={fade()}
            timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
          />
        ) : null,
      ])}
    </TransitionSeries>
  );
}

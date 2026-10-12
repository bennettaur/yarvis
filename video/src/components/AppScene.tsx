import type { ReactNode } from "react";
import { AbsoluteFill } from "remotion";
import type { Tab } from "../../../src/components/shell/nav";
import { AppWindow } from "./AppWindow";
import { Backdrop } from "./Backdrop";
import { Camera, type Shot } from "./Camera";
import { Caption, type CaptionProps } from "./Caption";
import { Cursor, type CursorStop } from "./Cursor";

/** Stage x where the window fades out, so a close-up never runs under the caption. */
const CAPTION_EDGE = 640;

/**
 * One scene inside the app: the backdrop, the window under a moving camera,
 * and a caption column on the left.
 */
export function AppScene({
  tab,
  attention,
  shots,
  cursor = [],
  caption,
  overlay,
  stage,
  hideCursorAfter,
  tint,
  children,
}: {
  tab: Tab;
  attention?: number;
  shots: Shot[];
  cursor?: CursorStop[];
  caption?: CaptionProps;
  overlay?: ReactNode;
  /** Drawn over the whole stage rather than inside the window, so the camera doesn't move it. */
  stage?: ReactNode;
  hideCursorAfter?: number;
  tint?: "indigo" | "red";
  children: ReactNode;
}) {
  return (
    <AbsoluteFill>
      <Backdrop tint={tint} />
      <Camera shots={shots} fadeLeft={caption ? CAPTION_EDGE : undefined}>
        <AppWindow tab={tab} attention={attention} overlay={overlay}>
          {children}
        </AppWindow>
        <Cursor stops={cursor} hideAfter={hideCursorAfter} />
      </Camera>
      {caption && <Caption {...caption} />}
      {stage}
    </AbsoluteFill>
  );
}

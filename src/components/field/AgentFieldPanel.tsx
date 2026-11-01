import { useEffect, useRef } from "react";
import { subscribeActivity } from "../../lib/activity";
import { type AgentField, createAgentField, type FieldEvent } from "./engine";

export type FieldSubscribe = (
  onEvent: (ev: FieldEvent) => void,
  onStatus: (connected: boolean) => void,
) => () => void;

interface Props {
  /** The live event feed. Returns the unsubscribe. */
  subscribe?: FieldSubscribe;
}

/** AGENT//FIELD: a chiptune visualizer of agent activity, filling its parent. */
export default function AgentFieldPanel({ subscribe = subscribeActivity }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);
  const nodeListRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const manualRef = useRef<HTMLLabelElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<AgentField | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const hud = hudRef.current;
    const meter = meterRef.current;
    const stats = statsRef.current;
    const nodeList = nodeListRef.current;
    const log = logRef.current;
    const manual = manualRef.current;
    const slider = sliderRef.current;
    const startOverlay = startRef.current;
    if (
      !host ||
      !canvas ||
      !hud ||
      !meter ||
      !stats ||
      !nodeList ||
      !log ||
      !manual ||
      !slider ||
      !startOverlay
    )
      return;
    const field = createAgentField({
      host,
      canvas,
      hud,
      meter,
      stats,
      nodeList,
      log,
      manual,
      slider,
      startOverlay,
    });
    fieldRef.current = field;
    host.focus({ preventScroll: true });
    const unsubscribe = subscribe(field.push, field.setLive);
    return () => {
      unsubscribe();
      field.destroy();
      fieldRef.current = null;
    };
  }, [subscribe]);

  return (
    <div
      ref={hostRef}
      // Focusable so the page's keys work right after its tab is picked.
      tabIndex={-1}
      className="relative h-full w-full overflow-hidden bg-black font-mono text-white outline-none"
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ imageRendering: "pixelated" }}
      />
      <div className="agent-field-scan pointer-events-none absolute inset-0" />
      <div className="agent-field-vignette pointer-events-none absolute inset-0" />
      <div
        ref={hudRef}
        className="pointer-events-none absolute inset-0 text-[12px] uppercase tracking-[.08em]"
      >
        <div className="absolute top-[14px] left-4">
          <div className="agent-field-glow font-bold text-[18px]">{"AGENT//FIELD"}</div>
          <div ref={meterRef} className="mt-2 flex gap-0.5" />
          <div ref={statsRef} className="mt-1.5 whitespace-pre text-[#ff8a94] text-[11px]" />
        </div>
        <div
          ref={nodeListRef}
          className="absolute top-[14px] right-4 text-right text-[11px] leading-[1.6]"
        />
        <div
          ref={logRef}
          className="absolute bottom-[14px] left-4 max-w-[60%] text-[11px] leading-[1.55]"
        />
        <div className="absolute right-4 bottom-[14px] text-right text-[#6a6a6a] text-[10px] leading-[1.6]">
          {"[S] sound  [D] demo  [A] manual"}
          <br />
          {"[1-8] test events  [H] hud  [F] fullscreen"}
        </div>
      </div>
      <label
        ref={manualRef}
        hidden
        className="absolute right-4 bottom-24 flex items-center gap-2 text-[#ff8a94] text-[11px] uppercase"
      >
        intensity
        <input
          ref={sliderRef}
          type="range"
          min={0}
          max={100}
          defaultValue={40}
          className="w-[180px] accent-[#ff2a3a]"
        />
      </label>
      <button
        ref={startRef}
        type="button"
        onClick={() => fieldRef.current?.start()}
        className="absolute inset-0 z-[5] flex cursor-pointer flex-col items-center justify-center gap-3.5 bg-black/72 uppercase tracking-[.2em]"
      >
        <b className="agent-field-glow agent-field-blink text-[26px]">{"> jack in_"}</b>
        <span className="text-[#8a8a8a] text-[11px]">click or press any key to start audio</span>
      </button>
    </div>
  );
}

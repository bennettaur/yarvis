import { useState } from "react";
import CalendarPanel from "../CalendarPanel";
import DayTimeline, { type Orientation } from "./DayTimeline";
import MonthView from "./MonthView";
import WeekView from "./WeekView";

type View = "agenda" | "week" | "month" | "day";

const VIEWS: { id: View; label: string }[] = [
  { id: "agenda", label: "Agenda" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "day", label: "Day" },
];

/**
 * The Calendar tab's container: a segmented switcher over the agenda, week,
 * month, and day timeline views. The day view adds an orientation toggle.
 */
export default function CalendarView() {
  const [view, setView] = useState<View>("agenda");
  const [orientation, setOrientation] = useState<Orientation>("vertical");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-zinc-700">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className={`px-3 py-1.5 text-sm ${
                view === v.id
                  ? "bg-indigo-600 text-white"
                  : "text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        {view === "day" && (
          <div className="inline-flex overflow-hidden rounded-md border border-zinc-700">
            {(["vertical", "horizontal"] as Orientation[]).map((o) => (
              <button
                key={o}
                onClick={() => setOrientation(o)}
                className={`px-3 py-1.5 text-sm capitalize ${
                  orientation === o
                    ? "bg-zinc-700 text-white"
                    : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {o}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {view === "agenda" && <CalendarPanel />}
        {view === "week" && <WeekView />}
        {view === "month" && <MonthView />}
        {view === "day" && <DayTimeline orientation={orientation} />}
      </div>
    </div>
  );
}

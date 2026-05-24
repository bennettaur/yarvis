import WidgetFrame from "./WidgetFrame";

/**
 * Placeholder for the meetings widget. Google Calendar integration is still on
 * the roadmap; this lets layouts that ask for meetings (e.g. "tasks and
 * meetings side by side") render structurally until the data source exists.
 */
export default function MeetingsWidget({ title }: { title?: string }) {
  return (
    <WidgetFrame
      title={title ?? "Meetings"}
      bodyClassName="flex items-center justify-center p-6 text-center"
    >
      <div className="text-sm text-zinc-500">
        <p>Calendar isn't connected yet.</p>
        <p className="mt-1 text-xs">
          Meetings appear here once Google Calendar integration lands.
        </p>
      </div>
    </WidgetFrame>
  );
}

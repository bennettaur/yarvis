import { defineRegistry } from "@json-render/react";
import AlarmsPanel from "../components/AlarmsPanel";
import CalendarPanel from "../components/CalendarPanel";
import ChatPanel from "../components/ChatPanel";
import DayTimeline from "../components/calendar/DayTimeline";
import MonthView from "../components/calendar/MonthView";
import WeekView from "../components/calendar/WeekView";
import Dashboard from "../components/Dashboard";
import MemoryPanel from "../components/MemoryPanel";
import PrsPanel from "../components/PrsPanel";
import PrChecks from "../components/pr/PrChecks";
import PrDescription from "../components/pr/PrDescription";
import PrFileDiffs from "../components/pr/PrFileDiffs";
import PrFileList from "../components/pr/PrFileList";
import SessionsPanel from "../components/SessionsPanel";
import TasksPanel from "../components/TasksPanel";
import TerminalPanel from "../components/TerminalPanel";
import { catalog } from "./catalog";
import { Column, Divider, Grid, Heading, Panel, Row, Text } from "./primitives";
import WidgetFrame from "./WidgetFrame";

/**
 * Maps each catalog component to its React implementation. Feature widgets
 * reuse the existing static panels verbatim (one implementation, rendered both
 * on the static pages and inside Omni layouts), wrapped in a titled frame so
 * they fill their pane.
 */
const { registry } = defineRegistry(catalog, {
  components: {
    Row: ({ props, children }) => <Row gap={props.gap}>{children}</Row>,
    Column: ({ props, children }) => <Column gap={props.gap}>{children}</Column>,
    Grid: ({ props, children }) => (
      <Grid columns={props.columns} gap={props.gap}>
        {children}
      </Grid>
    ),
    Panel: ({ props, children }) => (
      <Panel title={props.title} name="Panel" height={props.height}>
        {children}
      </Panel>
    ),
    Heading: ({ props }) => <Heading text={props.text} level={props.level} />,
    Text: ({ props }) => <Text text={props.text} muted={props.muted} />,
    Divider: () => <Divider />,
    Tasks: ({ props }) => (
      <WidgetFrame title={props.title ?? "Tasks"} name="Tasks" height={props.height}>
        <TasksPanel />
      </WidgetFrame>
    ),
    Calendar: ({ props }) => (
      <WidgetFrame title={props.title ?? "Calendar"} name="Calendar" height={props.height}>
        <CalendarPanel />
      </WidgetFrame>
    ),
    CalendarWeek: ({ props }) => (
      <WidgetFrame title={props.title ?? "Week"} name="CalendarWeek" height={props.height}>
        <WeekView />
      </WidgetFrame>
    ),
    CalendarMonth: ({ props }) => (
      <WidgetFrame title={props.title ?? "Month"} name="CalendarMonth" height={props.height}>
        <MonthView />
      </WidgetFrame>
    ),
    CalendarDay: ({ props }) => (
      <WidgetFrame title={props.title ?? "Day"} name="CalendarDay" height={props.height}>
        <DayTimeline orientation={props.orientation} />
      </WidgetFrame>
    ),
    Memory: ({ props }) => (
      <WidgetFrame title={props.title ?? "Memory"} name="Memory" height={props.height}>
        <MemoryPanel />
      </WidgetFrame>
    ),
    PullRequests: ({ props }) => (
      <WidgetFrame title={props.title ?? "Pull Requests"} name="PullRequests" height={props.height}>
        <PrsPanel />
      </WidgetFrame>
    ),
    PrDescription: ({ props }) => (
      <WidgetFrame
        title={props.title ?? `Description #${props.number}`}
        name="PrDescription"
        height={props.height}
      >
        <PrDescription owner={props.owner} repo={props.repo} number={props.number} />
      </WidgetFrame>
    ),
    PrChecks: ({ props }) => (
      <WidgetFrame
        title={props.title ?? `Checks #${props.number}`}
        name="PrChecks"
        height={props.height}
      >
        <PrChecks owner={props.owner} repo={props.repo} number={props.number} />
      </WidgetFrame>
    ),
    PrFileList: ({ props }) => (
      <WidgetFrame
        title={props.title ?? `Files #${props.number}`}
        name="PrFileList"
        height={props.height}
      >
        <PrFileList owner={props.owner} repo={props.repo} number={props.number} />
      </WidgetFrame>
    ),
    PrFileDiffs: ({ props }) => (
      <WidgetFrame
        title={props.title ?? `Diff #${props.number}`}
        name="PrFileDiffs"
        height={props.height}
      >
        <PrFileDiffs owner={props.owner} repo={props.repo} number={props.number} />
      </WidgetFrame>
    ),
    Sessions: ({ props }) => (
      <WidgetFrame title={props.title ?? "Sessions"} name="Sessions" height={props.height}>
        <SessionsPanel />
      </WidgetFrame>
    ),
    Alarms: ({ props }) => (
      <WidgetFrame title={props.title ?? "Alarms"} name="Alarms" height={props.height}>
        <AlarmsPanel />
      </WidgetFrame>
    ),
    Settings: ({ props }) => (
      <WidgetFrame title={props.title ?? "Settings"} name="Settings" height={props.height}>
        <Dashboard />
      </WidgetFrame>
    ),
    Chat: ({ props }) => (
      <WidgetFrame title={props.title ?? "Chat"} name="Chat" height={props.height}>
        <ChatPanel />
      </WidgetFrame>
    ),
    Terminal: ({ props }) => (
      <WidgetFrame title={props.title ?? "Terminal"}>
        <TerminalPanel sessionId={props.sessionId ? `omni:${props.sessionId}` : undefined} />
      </WidgetFrame>
    ),
  },
});

export { registry };

import { defineRegistry } from "@json-render/react";
import AlarmsPanel from "../components/AlarmsPanel";
import ChatPanel from "../components/ChatPanel";
import Dashboard from "../components/Dashboard";
import PrsPanel from "../components/PrsPanel";
import SessionsPanel from "../components/SessionsPanel";
import TasksPanel from "../components/TasksPanel";
import { catalog } from "./catalog";
import MeetingsWidget from "./MeetingsWidget";
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
    Panel: ({ props, children }) => <Panel title={props.title}>{children}</Panel>,
    Heading: ({ props }) => <Heading text={props.text} level={props.level} />,
    Text: ({ props }) => <Text text={props.text} muted={props.muted} />,
    Divider: () => <Divider />,
    Tasks: ({ props }) => (
      <WidgetFrame title={props.title ?? "Tasks"} bodyClassName="p-4">
        <TasksPanel />
      </WidgetFrame>
    ),
    Meetings: ({ props }) => <MeetingsWidget title={props.title} />,
    PullRequests: ({ props }) => (
      <WidgetFrame title={props.title ?? "Pull Requests"} bodyClassName="p-4">
        <PrsPanel />
      </WidgetFrame>
    ),
    Sessions: ({ props }) => (
      <WidgetFrame title={props.title ?? "Sessions"} bodyClassName="p-4">
        <SessionsPanel />
      </WidgetFrame>
    ),
    Alarms: ({ props }) => (
      <WidgetFrame title={props.title ?? "Alarms"} bodyClassName="p-4">
        <AlarmsPanel />
      </WidgetFrame>
    ),
    Settings: ({ props }) => (
      <WidgetFrame title={props.title ?? "Settings"} bodyClassName="p-4">
        <Dashboard />
      </WidgetFrame>
    ),
    Chat: ({ props }) => (
      <WidgetFrame title={props.title ?? "Chat"}>
        <ChatPanel />
      </WidgetFrame>
    ),
  },
});

export { registry };

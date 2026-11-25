import SwiftUI
import YarvisClient

/// The Calendar page: a switcher over the agenda, week, month and day views,
/// behind the Google Calendar connection.
struct CalendarView: View {
    @Bindable var model: CalendarModel

    var body: some View {
        Group {
            if let status = model.status {
                if !status.configured {
                    CalendarNotConfigured()
                } else if !status.connected {
                    CalendarConnect(model: model)
                } else {
                    connectedContent
                }
            } else if let error = model.connectError {
                VStack(spacing: 8) {
                    Text(error).foregroundStyle(.red)
                    Button("Try Again") { Task { await model.loadStatus() } }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear { model.appeared() }
    }

    private var connectedContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Picker("View", selection: $model.mode) {
                    ForEach(CalendarModel.Mode.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                if model.mode == .day {
                    Picker("Orientation", selection: $model.orientation) {
                        ForEach(CalendarModel.Orientation.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                }
                Spacer()
                if model.loading { ProgressView().controlSize(.small) }
            }
            if let error = model.error {
                Text(error).foregroundStyle(.red).font(.callout)
            }
            switch model.mode {
            case .agenda: CalendarAgendaView(model: model)
            case .week: CalendarWeekView(model: model)
            case .month: CalendarMonthView(model: model)
            case .day: CalendarDayView(model: model)
            }
        }
        .padding(12)
    }
}

private struct CalendarNotConfigured: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Google Calendar isn't configured. Add a Google Cloud OAuth client (Desktop app) under "
                + "Settings → Google client id / secret in the web UI to connect your calendar.")
            Text("The redirect URI to register is http://127.0.0.1:<sidecar-port>/oauth/google/callback "
                + "(loopback; any port is accepted for Desktop clients).")
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .padding(20)
        .frame(maxWidth: 560, maxHeight: .infinity, alignment: .topLeading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct CalendarConnect: View {
    let model: CalendarModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect your Google Calendar to see upcoming meetings and arm alarms for them.")
                .foregroundStyle(.secondary)
            HStack {
                Button("Connect Google Calendar") { Task { await model.connect() } }
                Button("I've connected — refresh") { Task { await model.loadStatus() } }
                    .buttonStyle(.link)
            }
            if let error = model.connectError { Text(error).foregroundStyle(.red) }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Shared pieces

enum CalendarLayout {
    /// Where the hour grids rest when not showing now, so the work day shows first.
    static let startHour = 6
}

/// Redraws its content every 30 seconds with the time. Kept around the parts
/// that show the time, so the event grids don't redraw with it.
struct CalendarNow<Content: View>: View {
    @ViewBuilder let content: (Date) -> Content

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in content(context.date) }
    }
}

/// The alarm control for one event. Nothing for an event that can't have one
/// (all-day or started). `compact` is a bell alone, for the grids.
struct CalendarAlarmButton: View {
    let event: CalendarEvent
    let armed: Bool
    var compact = false
    let arm: () -> Void

    var body: some View {
        if MeetingAlarm.isArmable(event) {
            if compact {
                Button(action: arm) {
                    Image(systemName: armed ? "bell.fill" : "bell")
                        .font(.system(size: 10))
                        .foregroundStyle(armed ? .green : .secondary)
                }
                .buttonStyle(.borderless)
                .disabled(armed)
                .help(armed ? "Alarm set" : "Set alarm")
            } else if armed {
                Label("Alarm set", systemImage: "bell.fill").font(.caption).foregroundStyle(.green)
            } else {
                Button(action: arm) { Label("Set alarm", systemImage: "bell") }
                    .controlSize(.small)
            }
        }
    }
}

/// The meeting's join link, opened only if it's http(s).
struct CalendarJoinLink: View {
    let link: String

    var body: some View {
        Button("Join") { openExternal(link) }
            .buttonStyle(.link)
            .help(link)
    }
}

/// One timed event placed on a grid.
struct CalendarEventBlock: View {
    let event: CalendarEvent
    let model: CalendarModel

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .top, spacing: 2) {
                Text(event.title).fontWeight(.medium).lineLimit(1)
                Spacer(minLength: 0)
                CalendarAlarmButton(event: event, armed: model.isArmed(event), compact: true) { model.arm(event) }
            }
            HStack(spacing: 3) {
                if let start = event.startDate { Text(start, format: .dateTime.hour().minute()) }
                if let link = event.meetLink {
                    Text("·")
                    CalendarJoinLink(link: link)
                }
            }
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .font(.system(size: 11))
        .padding(.horizontal, 5)
        .padding(.vertical, 3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: 5))
        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Color.accentColor.opacity(0.5)))
        .clipped()
        .help(event.title)
    }
}

/// The title with Previous, Today and Next, and room for more controls after.
struct CalendarStepper<Trailing: View>: View {
    let title: Text
    let step: (Int) -> Void
    let today: () -> Void
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack {
            title.font(.headline)
            Spacer()
            Button { step(-1) } label: { Image(systemName: "chevron.left") }.help("Previous")
            Button("Today", action: today)
            Button { step(1) } label: { Image(systemName: "chevron.right") }.help("Next")
            trailing()
        }
    }
}

extension CalendarStepper where Trailing == EmptyView {
    init(title: Text, step: @escaping (Int) -> Void, today: @escaping () -> Void) {
        self.init(title: title, step: step, today: today) { EmptyView() }
    }
}

/// The red current-time marker, across a vertical grid or down a horizontal one.
struct CalendarNowLine: View {
    let vertical: Bool

    var body: some View {
        if vertical {
            HStack(spacing: 0) {
                Circle().fill(.red).frame(width: 7, height: 7)
                Rectangle().fill(.red).frame(height: 2)
            }
            .offset(x: -3, y: -3.5)
        } else {
            VStack(spacing: 0) {
                Circle().fill(.red).frame(width: 7, height: 7)
                Rectangle().fill(.red).frame(width: 2)
            }
            .offset(x: -3.5, y: -3)
        }
    }
}

// MARK: - Agenda

struct CalendarAgendaView: View {
    let model: CalendarModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Upcoming (\(model.upcoming.count))").font(.headline)
                Spacer()
                Button("Set alarms for all") { model.armAll() }
                Button("Disconnect", role: .destructive) { Task { await model.disconnect() } }
                    .buttonStyle(.link)
            }
            if model.upcoming.isEmpty {
                Text("No upcoming events.").foregroundStyle(.secondary)
                Spacer()
            } else {
                List {
                    ForEach(model.upcomingByDay, id: \.day) { group in
                        SwiftUI.Section(header: Text(dayHeader(group.day))) {
                            ForEach(group.events) { event in row(event) }
                        }
                    }
                }
            }
        }
    }

    private func dayHeader(_ day: Date) -> String {
        let label = day.formatted(.dateTime.weekday(.wide).month(.wide).day())
        let today = Date()
        if model.grid.sameDay(day, today) { return "Today · \(label)" }
        if model.grid.sameDay(day, model.grid.addDays(today, 1)) { return "Tomorrow · \(label)" }
        return label
    }

    private func row(_ event: CalendarEvent) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title).lineLimit(1)
                HStack(spacing: 4) {
                    if event.allDay {
                        Text("All day")
                    } else if let start = event.startDate {
                        Text(start, format: .dateTime.hour().minute())
                    } else {
                        Text(event.start)
                    }
                    if let link = event.meetLink {
                        Text("·")
                        CalendarJoinLink(link: link)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            CalendarAlarmButton(event: event, armed: model.isArmed(event)) { model.arm(event) }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Week

struct CalendarWeekView: View {
    let model: CalendarModel

    private static let hourHeight: CGFloat = 48
    private static let gutter: CGFloat = 56

    var body: some View {
        let grid = model.grid
        let days = grid.weekDays(model.weekAnchor)
        VStack(spacing: 0) {
            CalendarStepper(title: Text(weekTitle(days))) { step in
                model.weekAnchor = grid.addDays(model.weekAnchor, 7 * step)
            } today: { model.weekAnchor = Date() }
            .padding(.bottom, 6)
            HStack(spacing: 0) {
                Color.clear.frame(width: Self.gutter)
                ForEach(days, id: \.self) { day in
                    CalendarNow { now in
                        let isToday = grid.sameDay(day, now)
                        VStack(spacing: 0) {
                            Text(day, format: .dateTime.weekday(.abbreviated)).font(.caption)
                            Text(day, format: .dateTime.day()).fontWeight(isToday ? .bold : .regular)
                        }
                        .foregroundStyle(isToday ? Color.accentColor : .primary)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            Divider()
            HStack(alignment: .top, spacing: 0) {
                Text("all-day").font(.system(size: 9)).foregroundStyle(.secondary)
                    .frame(width: Self.gutter, alignment: .trailing).padding(.trailing, 4)
                ForEach(days, id: \.self) { day in
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(model.bucket(day).allDay) { event in
                            Text(event.title).font(.system(size: 10)).lineLimit(1)
                                .padding(.horizontal, 3)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 3))
                                .help(event.title)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 20, alignment: .top)
                    .padding(1)
                }
            }
            Divider()
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    HStack(alignment: .top, spacing: 0) {
                        CalendarHourGutter(hourHeight: Self.hourHeight)
                            .frame(width: Self.gutter)
                        ForEach(days, id: \.self) { day in
                            CalendarDayColumn(model: model, day: day, laid: model.bucket(day).laid,
                                              hourHeight: Self.hourHeight)
                        }
                    }
                }
                .onAppear { proxy.scrollTo(CalendarHourGutter.anchor(CalendarLayout.startHour), anchor: .top) }
            }
        }
    }

    private func weekTitle(_ days: [Date]) -> String {
        guard let first = days.first, let last = days.last else { return "" }
        let style = Date.FormatStyle.dateTime.month(.abbreviated).day()
        return "\(first.formatted(style)) – \(last.formatted(style))"
    }
}

/// Hour labels down the side of a vertical grid. Each hour has a scroll anchor.
struct CalendarHourGutter: View {
    let hourHeight: CGFloat

    static func anchor(_ hour: Int) -> String { "hour-\(hour)" }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                Text(hour == 0 ? "" : hourLabel(hour))
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .offset(y: -6)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(.trailing, 4)
                    .frame(height: hourHeight)
                    .id(Self.anchor(hour))
            }
        }
    }
}

/// One day's column in the week grid: hour lines, events side by side where
/// they overlap, and the current-time line on today.
struct CalendarDayColumn: View {
    let model: CalendarModel
    let day: Date
    let laid: [LaidOutEvent]
    let hourHeight: CGFloat

    var body: some View {
        let perMinute = hourHeight / 60
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                ForEach(0..<24, id: \.self) { hour in
                    Rectangle().fill(.separator).frame(height: 0.5)
                        .offset(y: CGFloat(hour) * hourHeight)
                }
                ForEach(laid) { item in
                    let place = model.grid.placement(item.event, day: day)
                    let width = geo.size.width / CGFloat(item.lanes)
                    CalendarEventBlock(event: item.event, model: model)
                        .frame(width: max(width - 2, 0), height: CGFloat(place.minutes) * perMinute)
                        .offset(x: width * CGFloat(item.lane) + 1, y: CGFloat(place.startMinute) * perMinute)
                }
                CalendarNow { now in
                    if model.grid.sameDay(day, now) {
                        CalendarNowLine(vertical: true)
                            .offset(y: CGFloat(model.grid.minutesIntoDay(now)) * perMinute)
                    }
                }
            }
        }
        .frame(height: hourHeight * 24)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .leading) { Rectangle().fill(.separator).frame(width: 0.5) }
    }
}

// MARK: - Month

struct CalendarMonthView: View {
    let model: CalendarModel

    /// Events listed per cell before the rest collapse into "+N more".
    private static let maxPerCell = 4

    var body: some View {
        let grid = model.grid
        let days = grid.monthGridDays(model.monthAnchor)
        VStack(spacing: 0) {
            CalendarStepper(title: Text(model.monthAnchor, format: .dateTime.month(.wide).year())) { step in
                model.monthAnchor = grid.addMonths(model.monthAnchor, step)
            } today: { model.monthAnchor = Date() }
            .padding(.bottom, 6)
            HStack(spacing: 0) {
                ForEach(days.prefix(7), id: \.self) { day in
                    Text(day, format: .dateTime.weekday(.abbreviated))
                        .font(.caption2).textCase(.uppercase).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.bottom, 2)
            Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(0..<6, id: \.self) { week in
                    GridRow {
                        ForEach(0..<7, id: \.self) { weekday in
                            let day = days[week * 7 + weekday]
                            cell(day: day, events: model.bucket(day).all)
                        }
                    }
                }
            }
            .overlay(Rectangle().strokeBorder(.separator, lineWidth: 0.5))
        }
    }

    private func cell(day: Date, events: [CalendarEvent]) -> some View {
        let grid = model.grid
        let inMonth = grid.sameMonth(day, model.monthAnchor)
        let shown = events.prefix(Self.maxPerCell)
        return VStack(alignment: .leading, spacing: 1) {
            CalendarNow { now in
                let isToday = grid.sameDay(day, now)
                Text(day, format: .dateTime.day())
                    .font(.caption)
                    .fontWeight(isToday ? .bold : .regular)
                    .foregroundStyle(isToday ? Color.accentColor : inMonth ? Color.primary : Color.secondary.opacity(0.6))
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            ForEach(shown) { event in
                HStack(spacing: 3) {
                    if !event.allDay, let start = event.startDate {
                        Text(start, format: .dateTime.hour().minute()).foregroundStyle(.secondary).monospacedDigit()
                    }
                    Text(event.title).lineLimit(1).help(event.title)
                    Spacer(minLength: 0)
                    CalendarAlarmButton(event: event, armed: model.isArmed(event), compact: true) { model.arm(event) }
                }
                .font(.system(size: 11))
            }
            if events.count > shown.count {
                Text("+\(events.count - shown.count) more").font(.system(size: 10)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(inMonth ? Color.clear : Color.secondary.opacity(0.06))
        .border(Color(nsColor: .separatorColor), width: 0.5)
        .clipped()
    }
}

// MARK: - Day

/// One day as a scrolling timeline, vertical or horizontal. Viewing today
/// keeps the current time centred, so meetings move toward the middle as they
/// come up; another day rests at the start of the work day.
struct CalendarDayView: View {
    let model: CalendarModel

    /// Room across the time axis kept for the hour labels.
    private static let labelBand: CGFloat = 52

    private var vertical: Bool { model.orientation == .vertical }
    /// Points per minute along the time axis.
    private var pointsPerMinute: CGFloat { vertical ? 1.1 : 2 }

    var body: some View {
        let grid = model.grid
        let day = model.dayAnchor
        let bucket = model.bucket(day)
        VStack(alignment: .leading, spacing: 6) {
            CalendarStepper(title: dayTitle(day, allDay: bucket.allDay)) { step in
                model.dayAnchor = grid.addDays(day, step)
            } today: {
                model.dayAnchor = Date()
            } trailing: {
                DatePicker("Pick a day", selection: Binding(get: { model.dayAnchor }, set: { model.dayAnchor = $0 }),
                           displayedComponents: .date)
                    .labelsHidden()
                    .fixedSize()
            }
            Divider()
            ScrollViewReader { proxy in
                ScrollView(vertical ? .vertical : .horizontal) {
                    timeline(laid: bucket.laid, day: day)
                }
                .onAppear { scroll(proxy, now: Date(), animated: false) }
                .onChange(of: grid.dayKey(day)) { scroll(proxy, now: Date(), animated: false) }
                .onChange(of: model.orientation) { scroll(proxy, now: Date(), animated: false) }
                .background {
                    // Follows the clock while today shows, apart from the timeline.
                    CalendarNow { now in
                        Color.clear.onChange(of: grid.minutesIntoDay(now)) { scroll(proxy, now: now, animated: true) }
                    }
                }
            }
        }
    }

    private func dayTitle(_ day: Date, allDay: [CalendarEvent]) -> Text {
        let date = Text(day, format: .dateTime.weekday(.wide).month(.wide).day())
        guard !allDay.isEmpty else { return date }
        return date + Text("  · " + allDay.map(\.title).joined(separator: ", ")).foregroundColor(.secondary)
    }

    /// Minute markers every 5 minutes, which is as close as scrolling to an id gets.
    private static func anchor(_ minute: Int) -> String { "minute-\(minute / 5 * 5)" }

    private func scroll(_ proxy: ScrollViewProxy, now: Date, animated: Bool) {
        let showsNow = model.grid.sameDay(model.dayAnchor, now)
        let target = Self.anchor(showsNow ? model.grid.minutesIntoDay(now) : CalendarLayout.startHour * 60)
        let anchor: UnitPoint = showsNow ? .center : (vertical ? .top : .leading)
        if animated {
            guard showsNow else { return }
            withAnimation { proxy.scrollTo(target, anchor: anchor) }
        } else {
            proxy.scrollTo(target, anchor: anchor)
        }
    }

    /// An offset given as a distance along the time axis and across it.
    private func shift(along: CGFloat, across: CGFloat) -> CGSize {
        vertical ? CGSize(width: across, height: along) : CGSize(width: along, height: across)
    }

    private func size(along: CGFloat, across: CGFloat) -> CGSize {
        vertical ? CGSize(width: across, height: along) : CGSize(width: along, height: across)
    }

    private func timeline(laid: [LaidOutEvent], day: Date) -> some View {
        let axisLength = CGFloat(CalendarGrid.minutesPerDay) * pointsPerMinute
        return GeometryReader { geo in
            let crossLength = max((vertical ? geo.size.width : geo.size.height) - Self.labelBand, 0)
            ZStack(alignment: .topLeading) {
                ForEach(Array(stride(from: 0, to: CalendarGrid.minutesPerDay, by: 5)), id: \.self) { minute in
                    Color.clear.frame(width: 1, height: 1)
                        .offset(shift(along: CGFloat(minute) * pointsPerMinute, across: 0))
                        .id(Self.anchor(minute))
                }
                ForEach(0..<25, id: \.self) { hour in
                    let along = CGFloat(hour * 60) * pointsPerMinute
                    let line = size(along: 0.5, across: vertical ? geo.size.width : geo.size.height)
                    Rectangle().fill(.separator)
                        .frame(width: line.width, height: line.height)
                        .offset(shift(along: along, across: 0))
                    if hour > 0 && hour < 24 {
                        Text(hourLabel(hour)).font(.system(size: 10)).foregroundStyle(.secondary)
                            .offset(shift(along: along + (vertical ? -7 : 4), across: 4))
                    }
                }
                ForEach(laid) { item in
                    let place = model.grid.placement(item.event, day: day)
                    let share = crossLength / CGFloat(item.lanes)
                    let frame = size(along: CGFloat(place.minutes) * pointsPerMinute, across: max(share - 2, 0))
                    CalendarEventBlock(event: item.event, model: model)
                        .frame(width: frame.width, height: frame.height)
                        .offset(shift(along: CGFloat(place.startMinute) * pointsPerMinute,
                                      across: Self.labelBand + share * CGFloat(item.lane)))
                }
                CalendarNow { now in
                    if model.grid.sameDay(day, now) {
                        CalendarNowLine(vertical: vertical)
                            .frame(maxWidth: vertical ? .infinity : nil, maxHeight: vertical ? nil : .infinity)
                            .offset(shift(along: CGFloat(model.grid.minutesIntoDay(now)) * pointsPerMinute, across: 0))
                    }
                }
                .zIndex(1)
            }
        }
        .frame(width: vertical ? nil : axisLength, height: vertical ? axisLength : nil)
        .frame(maxWidth: vertical ? .infinity : nil, maxHeight: vertical ? nil : .infinity)
    }
}

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
                    connected
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

    private var connected: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Picker("View", selection: $model.view) {
                    ForEach(CalendarModel.View.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                if model.view == .day {
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
            switch model.view {
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
                + "Settings → Google client id / secret to connect your calendar.")
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
                Label("alarm set", systemImage: "bell.fill").font(.caption).foregroundStyle(.green)
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
        Button("join") { openExternal(link) }
            .buttonStyle(.link)
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

/// Previous, Today and Next, for the grid views.
struct CalendarStepper: View {
    let title: String
    let step: (Int) -> Void
    let today: () -> Void

    var body: some View {
        HStack {
            Text(title).font(.headline)
            Spacer()
            Button { step(-1) } label: { Image(systemName: "chevron.left") }.help("Previous")
            Button("Today", action: today)
            Button { step(1) } label: { Image(systemName: "chevron.right") }.help("Next")
        }
    }
}

// MARK: - Agenda

struct CalendarAgendaView: View {
    let model: CalendarModel

    var body: some View {
        let groups = model.grid.groupByDay(model.upcoming)
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
                    ForEach(groups, id: \.day) { group in
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
    /// Where the grid starts scrolled, so the work day shows first.
    private static let startHour = 6

    var body: some View {
        let grid = model.grid
        let days = grid.weekDays(model.weekAnchor)
        let events = model.events(for: grid.weekRange(model.weekAnchor))
        let byDay = days.map { grid.eventsForDay(events, day: $0) }
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let now = context.date
            VStack(spacing: 0) {
                CalendarStepper(title: weekTitle(days)) { step in
                    model.weekAnchor = grid.addDays(model.weekAnchor, 7 * step)
                } today: { model.weekAnchor = Date() }
                .padding(.bottom, 6)
                HStack(spacing: 0) {
                    Color.clear.frame(width: Self.gutter)
                    ForEach(days, id: \.self) { day in
                        let isToday = grid.sameDay(day, now)
                        VStack(spacing: 0) {
                            Text(day, format: .dateTime.weekday(.abbreviated)).font(.caption)
                            Text(day, format: .dateTime.day()).fontWeight(isToday ? .bold : .regular)
                        }
                        .foregroundStyle(isToday ? Color.accentColor : .primary)
                        .frame(maxWidth: .infinity)
                    }
                }
                Divider()
                HStack(alignment: .top, spacing: 0) {
                    Text("all-day").font(.system(size: 9)).foregroundStyle(.secondary)
                        .frame(width: Self.gutter, alignment: .trailing).padding(.trailing, 4)
                    ForEach(Array(days.enumerated()), id: \.offset) { index, _ in
                        VStack(alignment: .leading, spacing: 1) {
                            ForEach(byDay[index].allDay) { event in
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
                            ForEach(Array(days.enumerated()), id: \.offset) { index, day in
                                CalendarDayColumn(model: model, day: day, laid: assignLanes(byDay[index].timed),
                                                  hourHeight: Self.hourHeight, now: now)
                            }
                        }
                    }
                    .onAppear { proxy.scrollTo(CalendarHourGutter.anchor(Self.startHour), anchor: .top) }
                }
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
    let now: Date

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
                if model.grid.sameDay(day, now) {
                    CalendarNowLine(vertical: true)
                        .offset(y: CGFloat(model.grid.minutesIntoDay(now)) * perMinute)
                }
            }
        }
        .frame(height: hourHeight * 24)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .leading) { Rectangle().fill(.separator).frame(width: 0.5) }
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

// MARK: - Month

struct CalendarMonthView: View {
    let model: CalendarModel

    /// Events listed per cell before the rest collapse into "+N more".
    private static let maxPerCell = 4

    var body: some View {
        let grid = model.grid
        let days = grid.monthGridDays(model.monthAnchor)
        let events = model.events(for: grid.monthRange(model.monthAnchor))
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(spacing: 0) {
                CalendarStepper(title: model.monthAnchor.formatted(.dateTime.month(.wide).year())) { step in
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
                                let split = grid.eventsForDay(events, day: day)
                                cell(day: day, events: split.allDay + split.timed, now: context.date)
                            }
                        }
                    }
                }
                .overlay(Rectangle().strokeBorder(.separator, lineWidth: 0.5))
            }
        }
    }

    private func cell(day: Date, events: [CalendarEvent], now: Date) -> some View {
        let grid = model.grid
        let inMonth = grid.sameMonth(day, model.monthAnchor)
        let isToday = grid.sameDay(day, now)
        let shown = events.prefix(Self.maxPerCell)
        return VStack(alignment: .leading, spacing: 1) {
            Text(day, format: .dateTime.day())
                .font(.caption)
                .fontWeight(isToday ? .bold : .regular)
                .foregroundStyle(isToday ? Color.accentColor : inMonth ? Color.primary : Color.secondary.opacity(0.6))
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

    private static let startHour = 6
    /// Gap across the time axis kept for the hour labels.
    private static let gutter: CGFloat = 52

    private var vertical: Bool { model.orientation == .vertical }
    /// Points per minute along the time axis.
    private var perMinute: CGFloat { vertical ? 1.1 : 2 }

    var body: some View {
        let grid = model.grid
        let day = model.dayAnchor
        let split = grid.eventsForDay(model.events(for: grid.dayRange(day)), day: day)
        let laid = assignLanes(split.timed)
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let now = context.date
            let showNow = grid.sameDay(day, now)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(day, format: .dateTime.weekday(.wide).month(.wide).day()).font(.headline)
                    if !split.allDay.isEmpty {
                        let titles = split.allDay.map(\.title).joined(separator: ", ")
                        Text("· \(titles)").foregroundStyle(.secondary).lineLimit(1).help(titles)
                    }
                    Spacer()
                    Button { model.dayAnchor = grid.addDays(day, -1) } label: { Image(systemName: "chevron.left") }
                        .help("Previous day")
                    Button("Today") { model.dayAnchor = Date() }
                    Button { model.dayAnchor = grid.addDays(day, 1) } label: { Image(systemName: "chevron.right") }
                        .help("Next day")
                    DatePicker("Pick a day", selection: Binding(get: { model.dayAnchor }, set: { model.dayAnchor = $0 }),
                               displayedComponents: .date)
                        .labelsHidden()
                        .fixedSize()
                }
                Divider()
                ScrollViewReader { proxy in
                    ScrollView(vertical ? .vertical : .horizontal) {
                        timeline(laid: laid, day: day, now: showNow ? now : nil)
                    }
                    .onAppear { scroll(proxy, showNow: showNow, now: now, animated: false) }
                    .onChange(of: grid.minutesIntoDay(now)) { scroll(proxy, showNow: showNow, now: now, animated: true) }
                    .onChange(of: grid.dayKey(day)) { scroll(proxy, showNow: showNow, now: now, animated: false) }
                    .onChange(of: model.orientation) { scroll(proxy, showNow: showNow, now: now, animated: false) }
                }
            }
        }
    }

    /// Minute markers every 5 minutes, which is as close as scrolling to an id gets.
    private static func anchor(_ minute: Int) -> String { "minute-\(minute / 5 * 5)" }

    private func scroll(_ proxy: ScrollViewProxy, showNow: Bool, now: Date, animated: Bool) {
        let target = showNow ? Self.anchor(model.grid.minutesIntoDay(now)) : Self.anchor(Self.startHour * 60)
        let anchor: UnitPoint = showNow ? .center : (vertical ? .top : .leading)
        if animated {
            withAnimation { proxy.scrollTo(target, anchor: anchor) }
        } else {
            proxy.scrollTo(target, anchor: anchor)
        }
    }

    private func timeline(laid: [LaidOutEvent], day: Date, now: Date?) -> some View {
        let axis = CGFloat(CalendarGrid.minutesPerDay) * perMinute
        return GeometryReader { geo in
            let cross = (vertical ? geo.size.width : geo.size.height) - Self.gutter
            ZStack(alignment: .topLeading) {
                ForEach(Array(stride(from: 0, to: CalendarGrid.minutesPerDay, by: 5)), id: \.self) { minute in
                    Color.clear.frame(width: 1, height: 1)
                        .offset(x: vertical ? 0 : CGFloat(minute) * perMinute,
                                y: vertical ? CGFloat(minute) * perMinute : 0)
                        .id(Self.anchor(minute))
                }
                ForEach(0..<25, id: \.self) { hour in
                    let pos = CGFloat(hour * 60) * perMinute
                    if vertical {
                        Rectangle().fill(.separator).frame(height: 0.5).offset(y: pos)
                    } else {
                        Rectangle().fill(.separator).frame(width: 0.5).offset(x: pos)
                    }
                    if hour > 0 && hour < 24 {
                        Text(hourLabel(hour)).font(.system(size: 10)).foregroundStyle(.secondary)
                            .offset(x: vertical ? 4 : pos + 4, y: vertical ? pos - 7 : 4)
                    }
                }
                ForEach(laid) { item in
                    let place = model.grid.placement(item.event, day: day)
                    let along = CGFloat(place.minutes) * perMinute
                    let start = CGFloat(place.startMinute) * perMinute
                    let share = max(cross, 0) / CGFloat(item.lanes)
                    let across = Self.gutter + share * CGFloat(item.lane)
                    CalendarEventBlock(event: item.event, model: model)
                        .frame(width: vertical ? max(share - 2, 0) : along,
                               height: vertical ? along : max(share - 2, 0))
                        .offset(x: vertical ? across : start, y: vertical ? start : across)
                }
                if let now {
                    let pos = CGFloat(model.grid.minutesIntoDay(now)) * perMinute
                    CalendarNowLine(vertical: vertical)
                        .frame(maxWidth: vertical ? .infinity : nil, maxHeight: vertical ? nil : .infinity)
                        .offset(x: vertical ? 0 : pos, y: vertical ? pos : 0)
                        .zIndex(1)
                }
            }
        }
        .frame(width: vertical ? nil : axis, height: vertical ? axis : nil)
        .frame(maxWidth: vertical ? .infinity : nil, maxHeight: vertical ? nil : .infinity)
    }
}

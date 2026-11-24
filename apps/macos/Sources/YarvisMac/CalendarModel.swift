import Foundation
import Observation
import YarvisClient

/// The Calendar page: the Google connection, and the events for whichever of
/// the agenda, week, month and day views is showing.
@MainActor @Observable
final class CalendarModel {
    enum View: String, CaseIterable, Identifiable {
        case agenda, week, month, day
        var id: String { rawValue }
        var title: String { rawValue.capitalized }
    }

    enum Orientation: String, CaseIterable, Identifiable {
        case vertical, horizontal
        var id: String { rawValue }
        var title: String { rawValue.capitalized }
    }

    private unowned let app: AppModel
    private let client: YarvisClient
    let grid = CalendarGrid()

    /// Nil until the first status read answers.
    private(set) var status: CalendarStatus?
    /// A failed status read or connect.
    var connectError: String?

    var view: View = .agenda {
        didSet { if view != oldValue { load() } }
    }
    var orientation: Orientation = .vertical
    /// The week, month or day being shown. Each view keeps its own, as the
    /// web's do, so switching views starts each on today.
    var weekAnchor = Date() { didSet { if view == .week { load() } } }
    var monthAnchor = Date() { didSet { if view == .month { load() } } }
    var dayAnchor = Date() { didSet { if view == .day { load() } } }

    private(set) var upcoming: [CalendarEvent] = []
    private(set) var rangeEvents: [CalendarEvent] = []
    /// The range `rangeEvents` holds, so a view never shows another range's events.
    private(set) var loadedRange: Range<Date>?
    private(set) var loading = false
    var error: String?
    /// Bumped per load, so an older answer that lands last is dropped.
    private var generation = 0

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
    }

    func stop() {
        generation += 1
    }

    func handle(_ event: ServerEvent) {
        if event.kind == "sidecar.started" { resync() }
    }

    func resync() {
        guard status != nil else { return }
        Task { await loadStatus() }
    }

    /// The page came on screen.
    func appeared() {
        Task { await loadStatus() }
    }

    var connected: Bool { status?.configured == true && status?.connected == true }

    func loadStatus() async {
        do {
            status = try await client.calendarStatus()
            connectError = nil
            if connected { load() }
        } catch {
            connectError = error.localizedDescription
        }
    }

    /// Opens Google's consent page in the browser. Its redirect lands on the
    /// sidecar, so the user comes back and refreshes.
    func connect() async {
        do {
            openExternal(try await client.calendarAuthURL())
        } catch {
            connectError = error.localizedDescription
        }
    }

    func disconnect() async {
        do {
            try await client.disconnectCalendar()
            upcoming = []
            rangeEvents = []
            loadedRange = nil
            await loadStatus()
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: Loading

    /// The range the current grid view needs; nil for the agenda.
    var currentRange: Range<Date>? {
        switch view {
        case .agenda: return nil
        case .week: return grid.weekRange(weekAnchor)
        case .month: return grid.monthRange(monthAnchor)
        case .day: return grid.dayRange(dayAnchor)
        }
    }

    func load() {
        guard connected else { return }
        generation += 1
        let generation = generation
        let range = currentRange
        loading = true
        Task {
            do {
                if let range {
                    let events = try await client.calendarEvents(from: range.lowerBound, to: range.upperBound)
                    guard generation == self.generation else { return }
                    rangeEvents = events
                    loadedRange = range
                } else {
                    let events = try await client.upcomingCalendarEvents()
                    guard generation == self.generation else { return }
                    upcoming = events
                }
                error = nil
            } catch {
                guard generation == self.generation else { return }
                self.error = error.localizedDescription
            }
            loading = false
        }
    }

    /// The events loaded for `range`, or none while another range is loading.
    func events(for range: Range<Date>) -> [CalendarEvent] {
        loadedRange == range ? rangeEvents : []
    }

    // MARK: Alarms

    func isArmed(_ event: CalendarEvent) -> Bool { app.alarms?.isArmed(event) ?? false }

    func arm(_ event: CalendarEvent) {
        Task { await app.alarms?.arm(event) }
    }

    /// Sets alarms for every upcoming meeting that can have one, one at a time
    /// so each sees the alarms the last one set.
    func armAll() {
        let events = upcoming.filter { MeetingAlarm.isArmable($0) }
        Task {
            for event in events { await app.alarms?.arm(event) }
        }
    }
}

import AppKit
import SwiftUI
import YarvisClient

/// Something that hangs below a line: its comment threads and composer, or
/// its questions and answers.
struct CodeAnnotationSlot: Hashable {
    enum Kind: Hashable { case comment, insight }
    var kind: Kind
    var side: DiffSide
    var line: Int

    var id: String { "\(kind):\(side.rawValue):\(line)" }
}

/// How the verification report marks a new-file line.
struct CodeLineMark: Equatable {
    var mustRead = false
    /// The report's notes on the line, shown on hover.
    var notes: String?
}

/// A gutter action on one line or a selected range.
struct CodeLineAction: Equatable {
    enum Kind { case comment, ask }
    var kind: Kind
    var side: DiffSide
    var startLine: Int
    var endLine: Int
    /// Shift-click: stretch the open composer to this line.
    var extend = false
}

/// A request to scroll a line into view; a new `key` scrolls again.
struct CodeReveal: Equatable {
    var line: Int
    var key: Int
}

/// Go to definition and find references for a code view.
struct CodeSymbols {
    enum Outcome {
        case matches([ReviewSymbolMatch])
        case message(String)
    }

    var search: @MainActor (_ kind: ReviewSymbolKind, _ word: String, _ line: Int?) async -> Outcome
    var open: @MainActor (ReviewSymbolMatch) -> Void
}

/// A read-only code view for a whole file or a diff, built on `NSTableView`
/// so a file of thousands of lines lays out and scrolls lazily. Code rows are
/// drawn, wrapped at the view's width; what hangs below a line is SwiftUI.
struct ReviewCodeView: NSViewRepresentable {
    let document: ReviewCodeDocument
    var folded = false
    var slots: [CodeAnnotationSlot] = []
    var marks: [Int: CodeLineMark] = [:]
    var reveal: CodeReveal?
    var annotation: @MainActor (CodeAnnotationSlot) -> AnyView = { _ in AnyView(EmptyView()) }
    var onLineAction: (@MainActor (CodeLineAction) -> Void)?
    var symbols: CodeSymbols?

    func makeCoordinator() -> CodeViewCoordinator { CodeViewCoordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true
        scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        let table = CodeTableView()
        table.coordinator = context.coordinator
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("code"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.headerView = nil
        table.style = .plain
        table.intercellSpacing = .zero
        table.selectionHighlightStyle = .none
        table.gridStyleMask = []
        table.backgroundColor = .textBackgroundColor
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.usesAutomaticRowHeights = false
        table.dataSource = context.coordinator
        table.delegate = context.coordinator
        scroll.documentView = table
        context.coordinator.attach(table: table, scroll: scroll)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.update(self)
    }

    static func dismantleNSView(_ scroll: NSScrollView, coordinator: CodeViewCoordinator) {
        coordinator.detach()
    }
}

// MARK: - Layout

/// Where things sit across one row: one lane for a file or a unified diff,
/// two side by side for a split diff.
struct CodeLane {
    var side: DiffSide
    var x: CGFloat
    var width: CGFloat
    /// One number column, or old and new for a unified diff.
    var numberXs: [CGFloat]
    var actionsX: CGFloat
    var markerX: CGFloat?
    var textX: CGFloat
    var columns: Int
}

@MainActor
struct CodeMetrics {
    static let font = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular)
    static let charWidth: CGFloat = ("M" as NSString).size(withAttributes: [.font: font]).width
    static let lineHeight: CGFloat = ceil(font.ascender - font.descender + font.leading) + 3
    static let actionWidth: CGFloat = 38
    static let markerWidth: CGFloat = charWidth + 6
    static let foldHeight: CGFloat = 26
    /// Wide enough that thread text stays readable on a wide window.
    static let maxAnnotationWidth: CGFloat = 820
}

// MARK: - Coordinator

@MainActor
final class CodeViewCoordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    enum Row: Equatable {
        case pair(Int)
        case fold(id: Int, hidden: Int)
        case annotation(CodeAnnotationSlot)
    }

    struct Selection: Equatable {
        var side: DiffSide
        var anchor: Int
        var head: Int
        var range: ClosedRange<Int> { min(anchor, head)...max(anchor, head) }
    }

    private(set) weak var table: CodeTableView?
    private weak var scroll: NSScrollView?
    private var frameObserver: NSObjectProtocol?

    private(set) var view: ReviewCodeView?
    var document: ReviewCodeDocument? { view?.document }
    private(set) var rows: [Row] = []
    private var reveals: [Int: FoldReveal] = [:]
    private var revealedKey: Int?
    private var pendingReveal: Int?
    private var lanes: [CodeLane] = []
    private var laneWidth: CGFloat = 0
    /// Measured SwiftUI heights by slot id.
    private var heights: [String: CGFloat] = [:]
    /// One host per slot for as long as the slot exists, so a reload or a
    /// scroll away never drops what's typed in its composer.
    private var hosts: [CodeAnnotationSlot: CodeHostRowView] = [:]

    private var oldSpans: [[SyntaxSpan]]?
    private var newSpans: [[SyntaxSpan]]?
    private var texts: [String: NSAttributedString] = [:]

    var selection: Selection? { didSet { if selection != oldValue { redrawCode() } } }
    var hover: (row: Int, side: DiffSide)?
    /// Where the last plain click landed, for F12 and the context menu.
    var caret: (side: DiffSide, line: Int, offset: Int)?
    private var popover: NSPopover?

    func attach(table: CodeTableView, scroll: NSScrollView) {
        self.table = table
        self.scroll = scroll
        scroll.contentView.postsFrameChangedNotifications = true
        frameObserver = NotificationCenter.default.addObserver(
            forName: NSView.frameDidChangeNotification, object: scroll.contentView, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.widthChanged() }
        }
    }

    func detach() {
        if let frameObserver { NotificationCenter.default.removeObserver(frameObserver) }
        popover?.close()
    }

    func update(_ next: ReviewCodeView) {
        let previous = view
        view = next
        let documentChanged = previous?.document.id != next.document.id
        if documentChanged {
            reveals = [:]
            selection = nil
            caret = nil
            texts = [:]
            oldSpans = nil
            newSpans = nil
            layoutLanes(force: true)
            highlight(next.document)
        }
        if let reveal = next.reveal, reveal.key != revealedKey {
            revealedKey = reveal.key
            pendingReveal = reveal.line
        }
        let newRows = buildRows()
        if newRows != rows || documentChanged {
            rows = newRows
            let live = Set(next.slots)
            hosts = hosts.filter { live.contains($0.key) }
            table?.reloadData()
        } else {
            refreshAnnotations()
            if previous?.marks != next.marks { redrawCode() }
        }
        applyPendingReveal()
    }

    /// Scrolls to an asked-for line once the view has its real width, since
    /// row heights (wrapping) depend on it.
    private func applyPendingReveal() {
        guard let line = pendingReveal, let scroll, scroll.contentView.bounds.width > 1, !rows.isEmpty else { return }
        pendingReveal = nil
        DispatchQueue.main.async { [weak self] in self?.scrollTo(line: line) }
    }

    // MARK: Rows

    private func buildRows() -> [Row] {
        guard let view else { return [] }
        let doc = view.document
        var keep = Set<Int>()
        for slot in view.slots {
            if let i = doc.pairIndex(side: slot.side, line: slot.line) { keep.insert(i) }
        }
        if let line = view.reveal?.line, let i = doc.newIndex[line] { keep.insert(i) }
        let codeRows = view.folded && doc.mode != .file
            ? foldedRows(doc.pairs, keep: keep, reveals: reveals)
            : doc.pairs.indices.map { CodeRow.pair($0) }
        var bySide: [DiffSide: [Int: [CodeAnnotationSlot]]] = [.left: [:], .right: [:]]
        for slot in view.slots { bySide[slot.side]?[slot.line, default: []].append(slot) }
        var out: [Row] = []
        out.reserveCapacity(codeRows.count + view.slots.count)
        for row in codeRows {
            switch row {
            case .fold(let id, let hidden):
                out.append(.fold(id: id, hidden: hidden))
            case .pair(let i):
                out.append(.pair(i))
                let pair = doc.pairs[i]
                if let o = pair.old, doc.mode != .file { out += (bySide[.left]?[o] ?? []).map(Row.annotation) }
                if let n = pair.new { out += (bySide[.right]?[n] ?? []).map(Row.annotation) }
            }
        }
        return out
    }

    func expand(fold id: Int, _ how: FoldExpansion) {
        var r = reveals[id] ?? FoldReveal()
        switch how {
        case .up: r.top += foldExpandStep
        case .down: r.bottom += foldExpandStep
        case .all: r = .all
        }
        reveals[id] = r
        rows = buildRows()
        table?.reloadData()
    }

    enum FoldExpansion { case up, down, all }

    // MARK: Lanes and heights

    private func widthChanged() {
        layoutLanes(force: false)
    }

    private func layoutLanes(force: Bool) {
        guard let scroll, let doc = document else { return }
        let width = max(200, scroll.contentView.bounds.width)
        if !force && abs(width - laneWidth) < 0.5 { return }
        let oldColumns = lanes.map(\.columns)
        laneWidth = width
        let cw = CodeMetrics.charWidth
        let digits = max(3, String(max(doc.new.lines.count, doc.old?.lines.count ?? 0)).count)
        let numberWidth = CGFloat(digits) * cw + 12
        func lane(_ side: DiffSide, x: CGFloat, width: CGFloat, numbers: Int, marker: Bool) -> CodeLane {
            let numberXs = (0..<numbers).map { x + CGFloat($0) * numberWidth }
            let actionsX = x + CGFloat(numbers) * numberWidth
            let markerX: CGFloat? = marker ? actionsX + CodeMetrics.actionWidth : nil
            let textX = (markerX.map { $0 + CodeMetrics.markerWidth } ?? actionsX + CodeMetrics.actionWidth)
            let columns = max(10, Int((x + width - textX - 8) / cw))
            return CodeLane(side: side, x: x, width: width, numberXs: numberXs, actionsX: actionsX,
                            markerX: markerX, textX: textX, columns: columns)
        }
        switch doc.mode {
        case .file: lanes = [lane(.right, x: 0, width: width, numbers: 1, marker: false)]
        case .unified: lanes = [lane(.right, x: 0, width: width, numbers: 2, marker: true)]
        case .split:
            let half = floor(width / 2)
            lanes = [lane(.left, x: 0, width: half, numbers: 1, marker: true),
                     lane(.right, x: half, width: width - half, numbers: 1, marker: true)]
        }
        guard let table else { return }
        // Annotation heights stay: a hosted view reports a new height itself
        // when the width changes it, and never re-reports an unchanged one.
        if force || lanes.map(\.columns) != oldColumns {
            NSAnimationContext.beginGrouping()
            NSAnimationContext.current.duration = 0
            table.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<rows.count))
            NSAnimationContext.endGrouping()
        }
        table.enumerateAvailableRowViews { rowView, _ in
            rowView.subviews.forEach { $0.needsDisplay = true }
        }
        refreshAnnotations()
        applyPendingReveal()
    }

    func lane(_ side: DiffSide) -> CodeLane? {
        lanes.first { $0.side == side } ?? lanes.first
    }

    var allLanes: [CodeLane] { lanes }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        guard row < rows.count, let doc = document else { return CodeMetrics.lineHeight }
        switch rows[row] {
        case .fold: return CodeMetrics.foldHeight
        case .annotation(let slot): return heights[slot.id] ?? 44
        case .pair(let i):
            let pair = doc.pairs[i]
            var wraps = 1
            switch doc.mode {
            case .file:
                wraps = wrappedRows(columns: doc.new.columns(pair.new), perRow: lanes.first?.columns ?? 80)
            case .unified:
                let cols = pair.new != nil ? doc.new.columns(pair.new) : (doc.old?.columns(pair.old) ?? 0)
                wraps = wrappedRows(columns: cols, perRow: lanes.first?.columns ?? 80)
            case .split:
                let left = wrappedRows(columns: doc.old?.columns(pair.old) ?? 0, perRow: lanes.first?.columns ?? 80)
                let right = wrappedRows(columns: doc.new.columns(pair.new), perRow: lanes.last?.columns ?? 80)
                wraps = max(left, right)
            }
            return CGFloat(wraps) * CodeMetrics.lineHeight
        }
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { false }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < rows.count else { return nil }
        switch rows[row] {
        case .pair(let i):
            let id = NSUserInterfaceItemIdentifier("codeRow")
            let cell = tableView.makeView(withIdentifier: id, owner: nil) as? CodeRowView ?? CodeRowView()
            cell.identifier = id
            cell.coordinator = self
            cell.pairIndex = i
            cell.row = row
            cell.needsDisplay = true
            return cell
        case .fold(let id, let hidden):
            let cell = CodeHostRowView()
            cell.setContent(AnyView(CodeFoldBar(hidden: hidden) { [weak self] how in self?.expand(fold: id, how) }),
                            frame: nil)
            return cell
        case .annotation(let slot):
            let cell = hosts[slot] ?? CodeHostRowView()
            hosts[slot] = cell
            configure(cell, slot: slot)
            return cell
        }
    }

    private func configure(_ cell: CodeHostRowView, slot: CodeAnnotationSlot) {
        guard let view, let lane = lane(slot.side) else { return }
        let start = document?.mode == .split ? lane.x + 8 : lane.textX
        let width = min(CodeMetrics.maxAnnotationWidth, lane.x + lane.width - start - 12)
        // Identified by slot, so a recycled row neither carries another line's
        // state (an open reply box) nor skips reporting its height.
        let content = view.annotation(slot)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
            .fixedSize(horizontal: false, vertical: true)
            .background(GeometryReader { proxy in
                Color.clear.preference(key: CodeHeightKey.self, value: proxy.size.height)
            })
            .onPreferenceChange(CodeHeightKey.self) { [weak self] height in
                MainActor.assumeIsolated { self?.measured(slot, height) }
            }
            .id(slot.id)
        cell.setContent(AnyView(content), frame: (start, max(200, width)))
    }

    private func measured(_ slot: CodeAnnotationSlot, _ height: CGFloat) {
        guard height > 0, abs((heights[slot.id] ?? -1) - height) > 0.5 else { return }
        heights[slot.id] = height
        guard let index = rows.firstIndex(of: .annotation(slot)) else { return }
        NSAnimationContext.beginGrouping()
        NSAnimationContext.current.duration = 0
        table?.noteHeightOfRows(withIndexesChanged: IndexSet(integer: index))
        NSAnimationContext.endGrouping()
    }

    /// Re-renders the visible annotations with the latest content builder.
    private func refreshAnnotations() {
        guard let table else { return }
        table.enumerateAvailableRowViews { rowView, row in
            guard row < rows.count, case .annotation(let slot) = rows[row],
                  let cell = rowView.view(atColumn: 0) as? CodeHostRowView else { return }
            configure(cell, slot: slot)
        }
    }

    func redrawCode() {
        table?.enumerateAvailableRowViews { rowView, row in
            if let cell = rowView.view(atColumn: 0) as? CodeRowView {
                cell.row = row
                cell.needsDisplay = true
            }
        }
    }

    // MARK: Text

    private func highlight(_ doc: ReviewCodeDocument) {
        let id = doc.id
        Task { [weak self] in
            let n = await ReviewCodeCache.shared.highlights(doc.new)
            var o: [[SyntaxSpan]]?
            if let old = doc.old { o = await ReviewCodeCache.shared.highlights(old) }
            guard let self, self.document?.id == id else { return }
            self.oldSpans = o
            self.newSpans = n
            self.texts = [:]
            self.redrawCode()
        }
    }

    /// The drawn text for a line, coloured once its spans are in.
    func attributedLine(side: DiffSide, line: Int) -> NSAttributedString? {
        guard let doc = document else { return nil }
        let source = side == .left ? doc.old : doc.new
        guard let text = source?.line(line) else { return nil }
        let key = "\(side.rawValue):\(line)"
        if let cached = texts[key] { return cached }
        let out = NSMutableAttributedString(string: text, attributes: CodeRowView.textAttributes)
        let spans = side == .left ? oldSpans : newSpans
        if let spans, line - 1 < spans.count {
            let length = out.length
            // A span can run over the "\r" the line lost, so it's clamped.
            for span in spans[line - 1] where span.start < length {
                out.addAttribute(.foregroundColor, value: CodeRowView.color(span.kind),
                                 range: NSRange(location: span.start, length: min(span.length, length - span.start)))
            }
        }
        texts[key] = out
        return out
    }

    func mark(newLine: Int?) -> CodeLineMark? {
        guard let newLine else { return nil }
        return view?.marks[newLine]
    }

    /// The report's notes on the line a row shows, for its hover text.
    func tooltip(row: Int) -> String? {
        guard let doc = document, row >= 0, row < rows.count, case .pair(let i) = rows[row] else { return nil }
        return mark(newLine: doc.pairs[i].new)?.notes
    }

    // MARK: Reveal

    func scrollTo(line: Int) {
        guard let table, let scroll, let doc = document else { return }
        if let i = doc.newIndex[line], !rows.contains(.pair(i)) {
            rows = buildRows()
            table.reloadData()
        }
        guard let i = doc.newIndex[line] ?? doc.newIndex[max(1, min(line, doc.new.lines.count))],
              let row = rows.firstIndex(of: .pair(i)) else { return }
        let rect = table.rect(ofRow: row)
        let visible = scroll.contentView.bounds.height
        let y = max(0, min(rect.midY - visible / 2, table.bounds.height - visible))
        scroll.contentView.scroll(to: NSPoint(x: 0, y: y))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    // MARK: Actions

    /// The line on `side` that `row` shows, if any.
    func line(row: Int, side: DiffSide) -> Int? {
        guard row >= 0, row < rows.count, case .pair(let i) = rows[row], let doc = document else { return nil }
        let pair = doc.pairs[i]
        return side == .left ? pair.old : pair.new
    }

    /// Which sides take gutter actions on this row: the new file only, except
    /// in a split diff, where the old side does too.
    func actionSides(row: Int) -> [DiffSide] {
        guard let doc = document, row < rows.count, case .pair(let i) = rows[row] else { return [] }
        let pair = doc.pairs[i]
        switch doc.mode {
        case .file, .unified: return pair.new != nil ? [.right] : []
        case .split: return [pair.old != nil ? DiffSide.left : nil, pair.new != nil ? .right : nil].compactMap { $0 }
        }
    }

    func lineAction(_ kind: CodeLineAction.Kind, side: DiffSide, line: Int, extend: Bool) {
        guard let handler = view?.onLineAction else { return }
        var start = line, end = line
        if let selection, selection.side == side, selection.range.contains(line) {
            start = selection.range.lowerBound
            end = selection.range.upperBound
        }
        handler(CodeLineAction(kind: kind, side: side, startLine: start, endLine: end, extend: extend))
    }

    var canAct: Bool { view?.onLineAction != nil }

    /// The text of the selected lines, or of the clicked line.
    func copyText() -> String? {
        guard let doc = document else { return nil }
        let source = { (side: DiffSide) in side == .left ? doc.old : doc.new }
        if let selection {
            return selection.range.compactMap { source(selection.side)?.line($0) }.joined(separator: "\n")
        }
        if let caret { return source(caret.side)?.line(caret.line) }
        return nil
    }

    func word(side: DiffSide, line: Int, offset: Int) -> String? {
        guard let text = (side == .left ? document?.old : document?.new)?.line(line) else { return nil }
        return identifier(in: text, at: offset)
    }

    var hasSymbols: Bool { view?.symbols != nil }

    /// Runs a symbol search for the word at the caret and shows where it leads.
    func findSymbol(_ kind: ReviewSymbolKind, at rect: NSRect? = nil) {
        guard let symbols = view?.symbols, let caret, let table,
              let word = word(side: caret.side, line: caret.line, offset: caret.offset) else { return }
        let anchor = rect ?? caretRect() ?? NSRect(x: 0, y: table.visibleRect.midY, width: 1, height: 1)
        let model = CodeSymbolPopoverModel(kind: kind, word: word)
        popover?.close()
        let pop = NSPopover()
        pop.behavior = .transient
        pop.contentViewController = NSHostingController(rootView: CodeSymbolList(model: model) { [weak self] match in
            self?.popover?.close()
            symbols.open(match)
        })
        popover = pop
        pop.show(relativeTo: anchor, of: table, preferredEdge: .maxY)
        let line = caret.side == .right ? caret.line : nil
        Task { [weak self] in
            let outcome = await symbols.search(kind, word, line)
            if case .matches(let matches) = outcome, matches.count == 1 {
                self?.popover?.close()
                symbols.open(matches[0])
                return
            }
            model.outcome = outcome
        }
    }

    private func caretRect() -> NSRect? {
        guard let caret, let table, let doc = document,
              let i = doc.pairIndex(side: caret.side, line: caret.line),
              let row = rows.firstIndex(of: .pair(i)), let lane = lane(caret.side) else { return nil }
        let r = table.rect(ofRow: row)
        return NSRect(x: lane.textX, y: r.minY, width: 40, height: CodeMetrics.lineHeight)
    }
}

private struct CodeHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

// MARK: - Table

/// Takes the code rows' mouse and key handling, since the drawn rows don't
/// hit-test; hosted SwiftUI rows get their own events.
final class CodeTableView: NSTableView {
    weak var coordinator: CodeViewCoordinator?
    private var tracking: NSTrackingArea?
    private var dragging: DiffSide?

    override var acceptsFirstResponder: Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow,
                                                         .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    /// Which lane and part of it a point is over.
    private enum Spot { case number, comment, ask, text, other }

    private func locate(_ point: NSPoint) -> (row: Int, side: DiffSide, spot: Spot)? {
        guard let coordinator else { return nil }
        let row = row(at: point)
        guard row >= 0 else { return nil }
        guard let lane = coordinator.allLanes.first(where: { point.x >= $0.x && point.x < $0.x + $0.width })
            ?? coordinator.allLanes.first else { return nil }
        let spot: Spot
        if point.x < lane.actionsX { spot = .number }
        else if point.x < lane.actionsX + CodeMetrics.actionWidth {
            spot = point.x < lane.actionsX + CodeMetrics.actionWidth / 2 ? .comment : .ask
        } else if point.x >= lane.textX { spot = .text }
        else { spot = .other }
        return (row, lane.side, spot)
    }

    private func textOffset(_ point: NSPoint, row: Int, side: DiffSide, line: Int) -> Int? {
        guard let coordinator, let lane = coordinator.lane(side),
              let text = (side == .left ? coordinator.document?.old : coordinator.document?.new)?.line(line) else {
            return nil
        }
        let top = rect(ofRow: row).minY
        let visualRow = Int((point.y - top) / CodeMetrics.lineHeight)
        let column = visualRow * lane.columns + Int((point.x - lane.textX) / CodeMetrics.charWidth)
        return utf16Offset(atColumn: column, in: text)
    }

    override func mouseMoved(with event: NSEvent) {
        guard let coordinator else { return }
        let point = convert(event.locationInWindow, from: nil)
        let note = coordinator.tooltip(row: row(at: point))
        if toolTip != note { toolTip = note }
        let previous = coordinator.hover
        if let at = locate(point), coordinator.actionSides(row: at.row).contains(at.side) {
            coordinator.hover = (at.row, at.side)
        } else {
            coordinator.hover = nil
        }
        if previous?.row != coordinator.hover?.row || previous?.side != coordinator.hover?.side {
            for r in [previous?.row, coordinator.hover?.row].compactMap({ $0 }) where r < numberOfRows {
                view(atColumn: 0, row: r, makeIfNecessary: false)?.needsDisplay = true
            }
        }
        if let at = locate(point), at.spot == .text, event.modifierFlags.contains(.command) {
            NSCursor.pointingHand.set()
        } else {
            NSCursor.arrow.set()
        }
    }

    override func mouseExited(with event: NSEvent) {
        guard let coordinator, let row = coordinator.hover?.row else { return }
        coordinator.hover = nil
        if row < numberOfRows { view(atColumn: 0, row: row, makeIfNecessary: false)?.needsDisplay = true }
    }

    override func mouseDown(with event: NSEvent) {
        guard let coordinator else { return }
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        guard let at = locate(point) else {
            coordinator.selection = nil
            return
        }
        let shift = event.modifierFlags.contains(.shift)
        switch at.spot {
        case .comment, .ask:
            guard coordinator.actionSides(row: at.row).contains(at.side),
                  let line = coordinator.line(row: at.row, side: at.side) else { return }
            coordinator.lineAction(at.spot == .comment ? .comment : .ask, side: at.side, line: line, extend: shift)
        case .number:
            guard coordinator.actionSides(row: at.row).contains(at.side),
                  let line = coordinator.line(row: at.row, side: at.side) else { return }
            if shift, let current = coordinator.selection, current.side == at.side {
                coordinator.selection = .init(side: at.side, anchor: current.anchor, head: line)
            } else {
                coordinator.selection = .init(side: at.side, anchor: line, head: line)
            }
            dragging = at.side
        case .text:
            guard let line = coordinator.line(row: at.row, side: at.side),
                  let offset = textOffset(point, row: at.row, side: at.side, line: line) else {
                coordinator.selection = nil
                return
            }
            coordinator.caret = (at.side, line, offset)
            if !shift { coordinator.selection = nil }
            if event.modifierFlags.contains(.command) {
                coordinator.findSymbol(.definitions, at: NSRect(x: point.x, y: point.y, width: 1, height: 1))
            }
        case .other:
            coordinator.selection = nil
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard let coordinator, let side = dragging, var selection = coordinator.selection else { return }
        autoscroll(with: event)
        let point = convert(event.locationInWindow, from: nil)
        let row = row(at: point)
        guard let line = coordinator.line(row: row, side: side) else { return }
        selection.head = line
        coordinator.selection = selection
    }

    override func mouseUp(with event: NSEvent) {
        dragging = nil
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        guard let coordinator else { return nil }
        let point = convert(event.locationInWindow, from: nil)
        guard let at = locate(point), let line = coordinator.line(row: at.row, side: at.side) else { return nil }
        if at.spot == .text, let offset = textOffset(point, row: at.row, side: at.side, line: line) {
            coordinator.caret = (at.side, line, offset)
        } else {
            coordinator.caret = (at.side, line, -1)
        }
        let menu = NSMenu()
        if coordinator.hasSymbols, let caret = coordinator.caret,
           let word = coordinator.word(side: caret.side, line: caret.line, offset: caret.offset) {
            menu.addItem(item("Go to Definition of “\(word)”", #selector(goToDefinition), key: "\u{F70F}"))
            let refs = item("Find References", #selector(findReferences), key: "\u{F70F}")
            refs.keyEquivalentModifierMask = .shift
            menu.addItem(refs)
            menu.addItem(.separator())
        }
        if coordinator.canAct, coordinator.actionSides(row: at.row).contains(at.side) {
            let inSelection = coordinator.selection.map { $0.side == at.side && $0.range.contains(line) } ?? false
            let lines = inSelection ? "Lines" : "Line"
            let comment = item("Comment on \(lines)…", #selector(commentFromMenu(_:)))
            comment.representedObject = [at.side.rawValue, line] as [Any]
            menu.addItem(comment)
            let ask = item("Ask About \(lines)…", #selector(askFromMenu(_:)))
            ask.representedObject = [at.side.rawValue, line] as [Any]
            menu.addItem(ask)
            menu.addItem(.separator())
        }
        menu.addItem(item(coordinator.selection == nil ? "Copy Line" : "Copy Lines", #selector(copy(_:))))
        return menu
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = []
        item.target = self
        return item
    }

    @objc private func goToDefinition() { coordinator?.findSymbol(.definitions) }
    @objc private func findReferences() { coordinator?.findSymbol(.references) }

    private func menuTarget(_ sender: NSMenuItem) -> (DiffSide, Int)? {
        guard let values = sender.representedObject as? [Any], let raw = values.first as? String,
              let side = DiffSide(rawValue: raw), let line = values.last as? Int else { return nil }
        return (side, line)
    }

    @objc private func commentFromMenu(_ sender: NSMenuItem) {
        guard let (side, line) = menuTarget(sender) else { return }
        coordinator?.lineAction(.comment, side: side, line: line, extend: false)
    }

    @objc private func askFromMenu(_ sender: NSMenuItem) {
        guard let (side, line) = menuTarget(sender) else { return }
        coordinator?.lineAction(.ask, side: side, line: line, extend: false)
    }

    @objc func copy(_ sender: Any?) {
        guard let text = coordinator?.copyText() else { return }
        copyToPasteboard(text)
    }

    override func keyDown(with event: NSEvent) {
        let f12 = event.charactersIgnoringModifiers?.unicodeScalars.first?.value == 0xF70F
        if f12, coordinator?.hasSymbols == true {
            coordinator?.findSymbol(event.modifierFlags.contains(.shift) ? .references : .definitions)
            return
        }
        if event.keyCode == 53, coordinator?.selection != nil {
            coordinator?.selection = nil
            return
        }
        super.keyDown(with: event)
    }
}

// MARK: - Rows

/// One code row, drawn: line numbers, gutter actions on hover, the change
/// marker and the wrapped, coloured text, for one lane or two.
final class CodeRowView: NSView {
    weak var coordinator: CodeViewCoordinator?
    var pairIndex: Int?
    var row = 0

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    static let paragraph: NSParagraphStyle = {
        let p = NSMutableParagraphStyle()
        p.lineBreakMode = .byCharWrapping
        p.minimumLineHeight = CodeMetrics.lineHeight
        p.maximumLineHeight = CodeMetrics.lineHeight
        p.tabStops = []
        p.defaultTabInterval = CodeMetrics.charWidth * CGFloat(codeTabWidth)
        return p
    }()

    static let textAttributes: [NSAttributedString.Key: Any] = [
        .font: CodeMetrics.font, .foregroundColor: NSColor.textColor, .paragraphStyle: paragraph,
    ]

    private static let numberAttributes: [NSAttributedString.Key: Any] = [
        .font: CodeMetrics.font, .foregroundColor: NSColor.tertiaryLabelColor,
    ]

    static func color(_ kind: SyntaxTokenKind) -> NSColor {
        switch kind {
        case .keyword: return .systemPink
        case .string: return .systemRed
        case .comment: return .systemGreen
        case .number: return .systemBlue
        case .type: return .systemTeal
        case .literal: return .systemPurple
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let coordinator, let doc = coordinator.document, let i = pairIndex, i < doc.pairs.count else { return }
        let pair = doc.pairs[i]
        let lanes = coordinator.allLanes
        let selection = coordinator.selection
        let mark = coordinator.mark(newLine: pair.new)
        for lane in lanes {
            let line: Int?
            let side: DiffSide
            let kind: Character?
            switch doc.mode {
            case .file:
                line = pair.new
                side = .right
                kind = nil
            case .unified:
                line = pair.new ?? pair.old
                side = pair.new != nil ? .right : .left
                kind = pair.changed ? (pair.new != nil ? "+" : "-") : nil
            case .split:
                side = lane.side
                line = lane.side == .left ? pair.old : pair.new
                kind = pair.changed && line != nil ? (lane.side == .left ? "-" : "+") : nil
            }
            let laneRect = NSRect(x: lane.x, y: 0, width: lane.width, height: bounds.height)
            if line == nil {
                NSColor.quaternaryLabelColor.withAlphaComponent(0.08).setFill()
                laneRect.fill()
                continue
            }
            if kind == "+" {
                NSColor.systemGreen.withAlphaComponent(0.13).setFill()
                laneRect.fill()
            } else if kind == "-" {
                NSColor.systemRed.withAlphaComponent(0.13).setFill()
                laneRect.fill()
            }
            // Only the new side takes a selection outside a split diff.
            let selectable = doc.mode == .split ? line : pair.new
            if let selection, let selectable, selection.side == lane.side, selection.range.contains(selectable) {
                NSColor.controlAccentColor.withAlphaComponent(0.22).setFill()
                laneRect.fill()
            }
            if side == .right, let mark {
                if mark.mustRead {
                    NSColor.systemOrange.withAlphaComponent(0.10).setFill()
                    laneRect.fill()
                }
                if mark.notes != nil {
                    NSColor.systemOrange.withAlphaComponent(0.16).setFill()
                    laneRect.fill()
                }
                NSColor.systemOrange.setFill()
                NSRect(x: lane.x, y: 0, width: mark.notes != nil ? 3 : 2, height: bounds.height).fill()
            }

            // Numbers: old and new in a unified lane, one otherwise.
            let numbers: [Int?] = doc.mode == .unified ? [pair.old, pair.new] : [line]
            for (n, x) in zip(numbers, lane.numberXs) {
                guard let n else { continue }
                let s = String(n) as NSString
                let w = s.size(withAttributes: Self.numberAttributes).width
                let width = (lane.numberXs.count > 1 ? lane.numberXs[1] - lane.numberXs[0] : lane.actionsX - x)
                s.draw(at: NSPoint(x: x + width - w - 6, y: 1), withAttributes: Self.numberAttributes)
            }

            if let hover = coordinator.hover, hover.row == row, hover.side == lane.side, coordinator.canAct {
                drawAction("+", at: lane.actionsX + 2, tint: .controlAccentColor)
                drawAction("?", at: lane.actionsX + CodeMetrics.actionWidth / 2 + 1, tint: .systemPurple)
            }
            if let markerX = lane.markerX, let kind {
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: CodeMetrics.font,
                    .foregroundColor: kind == "+" ? NSColor.systemGreen : NSColor.systemRed,
                ]
                (String(kind) as NSString).draw(at: NSPoint(x: markerX + 2, y: 1), withAttributes: attrs)
            }
            if let line, let text = coordinator.attributedLine(side: side, line: line), text.length > 0 {
                let rect = NSRect(x: lane.textX, y: 0, width: CGFloat(lane.columns) * CodeMetrics.charWidth + 0.5,
                                  height: bounds.height)
                text.draw(with: rect, options: [.usesLineFragmentOrigin])
            }
        }
    }

    private func drawAction(_ glyph: String, at x: CGFloat, tint: NSColor) {
        let size = CodeMetrics.lineHeight - 2
        let rect = NSRect(x: x, y: 1, width: size + 1, height: size)
        let path = NSBezierPath(roundedRect: rect, xRadius: 3, yRadius: 3)
        NSColor.controlBackgroundColor.setFill()
        path.fill()
        tint.withAlphaComponent(0.6).setStroke()
        path.stroke()
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: tint,
        ]
        let s = glyph as NSString
        let w = s.size(withAttributes: attrs)
        s.draw(at: NSPoint(x: rect.midX - w.width / 2, y: rect.midY - w.height / 2), withAttributes: attrs)
    }
}

/// A row that hosts SwiftUI: a fold bar, or what hangs below a line, placed
/// at an x offset and width within the row.
final class CodeHostRowView: NSView {
    private var host: NSHostingView<AnyView>?
    private var placement: (x: CGFloat, width: CGFloat)?

    override var isFlipped: Bool { true }

    func setContent(_ view: AnyView, frame: (CGFloat, CGFloat)?) {
        placement = frame.map { (x: $0.0, width: $0.1) }
        if let host {
            host.rootView = view
        } else {
            let host = NSHostingView(rootView: view)
            host.sizingOptions = []
            addSubview(host)
            self.host = host
        }
        placeHost()
    }

    override func layout() {
        super.layout()
        placeHost()
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        super.resizeSubviews(withOldSize: oldSize)
        placeHost()
    }

    private func placeHost() {
        guard let host else { return }
        if let placement {
            host.frame = NSRect(x: placement.x, y: 0, width: placement.width, height: bounds.height)
        } else {
            host.frame = bounds
        }
    }
}

private struct CodeFoldBar: View {
    let hidden: Int
    let expand: (CodeViewCoordinator.FoldExpansion) -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text("⋯ \(hidden) unchanged \(hidden == 1 ? "line" : "lines")").foregroundStyle(.secondary)
            if hidden > foldExpandStep {
                Button("↑ Show \(foldExpandStep) more") { expand(.up) }
                Button("↓ Show \(foldExpandStep) more") { expand(.down) }
            }
            Button("Show all") { expand(.all) }
            Spacer()
        }
        .buttonStyle(.link)
        .font(.caption)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.secondary.opacity(0.08))
    }
}

// MARK: - Symbol results

@MainActor @Observable
final class CodeSymbolPopoverModel {
    let kind: ReviewSymbolKind
    let word: String
    var outcome: CodeSymbols.Outcome?

    init(kind: ReviewSymbolKind, word: String) {
        self.kind = kind
        self.word = word
    }
}

private struct CodeSymbolList: View {
    let model: CodeSymbolPopoverModel
    let open: (ReviewSymbolMatch) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.kind == .definitions ? "Definitions of \(model.word)" : "References to \(model.word)")
                .font(.caption.weight(.semibold))
            switch model.outcome {
            case nil:
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Searching…").foregroundStyle(.secondary)
                }
            case .message(let text):
                Text(text).foregroundStyle(.secondary)
            case .matches(let matches):
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(matches.enumerated()), id: \.offset) { _, match in
                            Button { open(match) } label: {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text("\(match.path):\(match.line)").font(.caption.monospaced())
                                    Text(match.preview.trimmingCharacters(in: .whitespaces))
                                        .font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .padding(.vertical, 2)
                        }
                    }
                }
                .frame(maxHeight: 320)
            }
        }
        .padding(10)
        .frame(width: 420, alignment: .leading)
    }
}

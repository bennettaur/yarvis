import SwiftUI
import YarvisClient

/// The guide agent's graph of the code it read, collapsed until asked for.
struct ReviewFlowGraphSection: View {
    let graph: PrGuideGraph
    let stale: Bool
    @State private var open = false

    var body: some View {
        let changed = graph.nodes.filter { $0.changed == true }.count
        VStack(alignment: .leading, spacing: 8) {
            Button {
                open.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: open ? "chevron.down" : "chevron.right").font(.caption)
                    Text("Flow diagram · \(graph.nodes.count) \(graph.nodes.count == 1 ? "piece" : "pieces") of code, \(changed) changed\(stale ? " · out of date" : "")")
                        .font(.callout)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "expanded" : "collapsed")
            if open {
                Text("Drawn by the review agent from what it read in this pull request. It can be incomplete or wrong, and its labels come from code the author wrote.")
                    .font(.caption).foregroundStyle(.secondary)
                ReviewFlowGraphView(layout: FlowGraphLayout(graph))
                    .frame(height: 360)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.25)))
            }
        }
    }
}

/// The graph drawn natively: boxes in columns, arrows from one box's right
/// edge to the next one's left, scrollable and zoomable.
struct ReviewFlowGraphView: View {
    let layout: FlowGraphLayout
    @State private var zoom: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    private let margin: CGFloat = 20

    var body: some View {
        let scale = min(max(zoom * pinch, 0.3), 3)
        VStack(spacing: 0) {
            ScrollView([.horizontal, .vertical]) {
                diagram
                    .scaleEffect(scale, anchor: .topLeading)
                    .frame(width: (layout.width + margin * 2) * scale, height: (layout.height + margin * 2) * scale,
                           alignment: .topLeading)
            }
            .gesture(MagnifyGesture().updating($pinch) { value, state, _ in state = value.magnification }
                .onEnded { zoom = min(max(zoom * $0.magnification, 0.3), 3) })
            HStack {
                Spacer()
                Button { zoom = max(zoom / 1.25, 0.3) } label: { Image(systemName: "minus.magnifyingglass") }
                Button { zoom = 1 } label: { Text("\(Int((scale * 100).rounded()))%").monospacedDigit() }
                Button { zoom = min(zoom * 1.25, 3) } label: { Image(systemName: "plus.magnifyingglass") }
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .padding(4)
        }
    }

    private var diagram: some View {
        let w = FlowGraphLayout.boxWidth, h = FlowGraphLayout.boxHeight
        return ZStack(alignment: .topLeading) {
            Canvas { ctx, _ in
                for arrow in layout.arrows {
                    let a = layout.boxes[arrow.from], b = layout.boxes[arrow.to]
                    let start = CGPoint(x: a.x + w + margin, y: a.y + h / 2 + margin)
                    let end = CGPoint(x: b.x + margin, y: b.y + h / 2 + margin)
                    var path = Path()
                    path.move(to: start)
                    path.addLine(to: end)
                    ctx.stroke(path, with: .color(.gray), lineWidth: 1.5)
                    let angle = atan2(end.y - start.y, end.x - start.x)
                    var head = Path()
                    head.move(to: end)
                    head.addLine(to: CGPoint(x: end.x - 9 * cos(angle - .pi / 7), y: end.y - 9 * sin(angle - .pi / 7)))
                    head.addLine(to: CGPoint(x: end.x - 9 * cos(angle + .pi / 7), y: end.y - 9 * sin(angle + .pi / 7)))
                    head.closeSubpath()
                    ctx.fill(head, with: .color(.gray))
                }
            }
            .frame(width: layout.width + margin * 2, height: layout.height + margin * 2)
            ForEach(Array(layout.arrows.enumerated()), id: \.offset) { _, arrow in
                let a = layout.boxes[arrow.from], b = layout.boxes[arrow.to]
                Text(arrow.label)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.horizontal, 3)
                    .background(.background)
                    .position(x: (a.x + w + b.x) / 2 + margin, y: (a.y + b.y + h) / 2 + margin)
            }
            ForEach(layout.boxes, id: \.index) { box in
                VStack(spacing: 2) {
                    Text(box.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
                    if let location = box.location {
                        Text(location).font(.system(size: 11).monospaced()).foregroundStyle(.secondary).lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .multilineTextAlignment(.center)
                .padding(6)
                .frame(width: w, height: h)
                .background(box.changed ? Color.blue.opacity(0.2) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8)
                    .stroke(box.changed ? Color.blue : Color.gray,
                            style: StrokeStyle(lineWidth: 1.5, dash: box.changed ? [] : [5, 4])))
                .help([box.title, box.location].compactMap { $0 }.joined(separator: "\n"))
                .offset(x: box.x + margin, y: box.y + margin)
            }
        }
        .frame(width: layout.width + margin * 2, height: layout.height + margin * 2, alignment: .topLeading)
    }
}

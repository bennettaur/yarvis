import SwiftUI
import YarvisClient

/// The flow check's newest diagram, with how its last run went.
struct ReviewDiagramTab: View {
    let context: ReviewTabContext

    private var pr: ReviewPrModel { context.pr }

    var body: some View {
        let item = pr.checklist.value?.items.first { $0.section == "flow" }
        let running = item?.latest?.status == "running"
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header(item)
                content(item)
            }
            .padding(16)
            .frame(maxWidth: 820, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .onAppear { pr.loadChecklist() }
        .reviewPoll(context, while: running) { pr.loadChecklist(force: true) }
    }

    private func header(_ item: ChecklistItem?) -> some View {
        HStack(spacing: 8) {
            Text("Flow diagram").font(.headline)
            if let result = item?.result {
                Text("at \(reportSha(result.headSha))\(result.costUsd.map { " · \(reportMoney($0))" } ?? "")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Open checklist") { context.openTab(ReviewTabSpec(kind: .verification, prId: pr.prId)) }
        }
    }

    @ViewBuilder private func content(_ item: ChecklistItem?) -> some View {
        let checklist = pr.checklist
        if checklist.value == nil {
            if let error = checklist.error { ReviewErrorText(error) } else { ReviewWaiting("Loading the flow diagram…") }
        } else if let item, item.latest != nil || item.result != nil {
            status(item)
            if item.result != nil, let flow = checklist.value?.report?.flow {
                if item.result?.current == false {
                    Text("This diagram is for an older head; the pull request has moved to \(reportSha(pr.pr.headSha)).")
                        .font(.callout).foregroundStyle(.orange)
                }
                ReviewFlowView(flow: flow)
            }
        } else {
            Text("No diagram yet. Run Flow diagram from the verification checklist: an agent finds the flow the change sits in, follows it up to what starts it and down to where it ends, and draws it as a flowchart with the changed steps marked.")
                .font(.callout).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func status(_ item: ChecklistItem) -> some View {
        if let latest = item.latest {
            switch latest.status {
            case "running":
                ReviewWaiting(latest.live ? "Tracing the flow…" : "Being drawn by another Yarvis instance…")
                if let result = item.result { Text("Below is the last diagram, from \(reportSha(result.headSha)).").font(.callout) }
            case "failed":
                ReviewErrorText("The last run failed: \(latest.error ?? "no reason given")")
            case "cancelled":
                Text("The last run was cancelled.").font(.callout).foregroundStyle(.secondary)
            default:
                if latest.id != item.result?.id {
                    Text("The last run gave no diagram.").font(.callout).foregroundStyle(.secondary)
                }
            }
        }
    }
}

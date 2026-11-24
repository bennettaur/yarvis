import SwiftUI
import YarvisClient

/// One provider review thread with its reply and resolve actions. Used by
/// the Comments tab, inline in diffs, and by the re-review summary.
struct PrThreadView: View {
    let context: ReviewTabContext
    let thread: PrThread
    var showsLocation = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(thread.comments) { comment in
                Text("\(comment.author): \(comment.body)").textSelection(.enabled)
            }
        }
    }
}

import SwiftUI
import YarvisClient

struct ReviewDescriptionTab: View {
    let context: ReviewTabContext

    var body: some View {
        Text("ReviewDescriptionTab").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ReviewReviewersTab: View {
    let context: ReviewTabContext

    var body: some View {
        Text("ReviewReviewersTab").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ReviewChecksTab: View {
    let context: ReviewTabContext

    var body: some View {
        Text("ReviewChecksTab").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ReviewCommentsTab: View {
    let context: ReviewTabContext

    var body: some View {
        Text("ReviewCommentsTab").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

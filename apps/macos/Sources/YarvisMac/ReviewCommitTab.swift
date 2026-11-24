import SwiftUI
import YarvisClient

struct ReviewCommitTab: View {
    let context: ReviewTabContext
    let spec: ReviewTabSpec

    var body: some View {
        Text("ReviewCommitTab").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

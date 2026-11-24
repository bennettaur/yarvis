import SwiftUI
import YarvisClient

struct ReviewDiffTab: View {
    let context: ReviewTabContext
    let spec: ReviewTabSpec

    var body: some View {
        Text("ReviewDiffTab").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ReviewFileTab: View {
    let context: ReviewTabContext
    let spec: ReviewTabSpec

    var body: some View {
        Text("ReviewFileTab").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

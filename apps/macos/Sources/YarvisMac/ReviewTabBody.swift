import SwiftUI
import YarvisClient

/// The body for one tab kind. Each kind's view lives in its own file.
struct ReviewTabBody: View {
    let spec: ReviewTabSpec
    let context: ReviewTabContext

    var body: some View {
        switch spec.kind {
        case .description: ReviewDescriptionTab(context: context)
        case .reviewers: ReviewReviewersTab(context: context)
        case .checks: ReviewChecksTab(context: context)
        case .comments: ReviewCommentsTab(context: context)
        case .claude: ReviewClaudeTab(context: context)
        case .diff: ReviewDiffTab(context: context, spec: spec)
        case .file: ReviewFileTab(context: context, spec: spec)
        case .sinceFile: ReviewSinceFileTab(context: context, spec: spec)
        case .commit: ReviewCommitTab(context: context, spec: spec)
        case .sinceReview: ReviewSinceReviewTab(context: context)
        case .guide: ReviewGuideTab(context: context)
        case .story: ReviewStoryTab(context: context)
        case .verification: ReviewVerificationTab(context: context)
        case .diagram: ReviewDiagramTab(context: context)
        case .mutation: ReviewMutationTab(context: context)
        }
    }
}

import CryptoKit
import Foundation
import Testing
@testable import YarvisClient

/// The text of each `<script>` element in `page`.
private func scripts(_ page: String) -> [String] {
    page.components(separatedBy: "<script>").dropFirst().map { $0.components(separatedBy: "</script>")[0] }
}

private func hash(_ s: String) -> String {
    "'sha256-\(Data(SHA256.hash(data: Data(s.utf8))).base64EncodedString())'"
}

@Suite struct MermaidPageTests {
    @Test func drawsOnlyFlowcharts() {
        #expect(isDrawableFlowchart("flowchart LR\n a-->b"))
        #expect(isDrawableFlowchart("graph TD\n a-->b"))
        #expect(!isDrawableFlowchart("sequenceDiagram\n a->>b: hi"))
        #expect(!isDrawableFlowchart("%%{init: {}}%%\nflowchart LR"))
    }

    @Test func theCSPAllowsExactlyThePagesOwnTwoScripts() throws {
        let page = mermaidPage(script: "var mermaid={};", source: "flowchart LR\n a-->b", dark: true)
        let inline = scripts(page)
        #expect(inline.count == 2)
        let csp = try #require(page.components(separatedBy: "script-src ").dropFirst().first?
            .components(separatedBy: ";").first)
        #expect(Set(csp.split(separator: " ").map(String.init)) == Set(inline.map(hash)))
        #expect(page.contains("default-src 'none'"))
        #expect(!page.contains("http://") && !page.contains("https://") && !page.contains("file:"))
        #expect(page.contains("securityLevel: \"strict\""))
    }

    @Test func neitherTheLibraryNorTheSourceCanCloseTheirScriptElement() {
        let page = mermaidPage(script: "var s='</script>';var mermaid={};",
                               source: "flowchart LR\n a[\"</SCRIPT><script>alert(2)</script>\"]", dark: false)
        #expect(scripts(page).count == 2)
        #expect(page.components(separatedBy: "</script>").count == 3)
    }

    @Test func onlyTheLoadedPageIsAllowed() {
        #expect(mermaidNavigation(isLinkClick: false, url: URL(string: "about:blank")) == .allow)
        #expect(mermaidNavigation(isLinkClick: true, url: URL(string: "about:blank")) == .cancel)
        #expect(mermaidNavigation(isLinkClick: true, url: URL(string: "https://example.com")) == .cancel)
        #expect(mermaidNavigation(isLinkClick: false, url: URL(string: "https://example.com")) == .cancel)
        #expect(mermaidNavigation(isLinkClick: false, url: URL(string: "file:///etc/passwd")) == .cancel)
        #expect(mermaidNavigation(isLinkClick: false, url: nil) == .cancel)
    }

    @Test func clampsTheReportedHeight() {
        #expect(mermaidHeight(189) == 189)
        #expect(mermaidHeight(0) == 40)
        #expect(mermaidHeight(1e9) == 4_000)
        #expect(mermaidHeight(.nan) == 200)
    }
}

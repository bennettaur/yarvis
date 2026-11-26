import Testing
@testable import YarvisClient

@Suite struct YarvisPlaceTests {
    let uuid = "0F8E2B1C-1234-4ABC-9DEF-0123456789AB"

    @Test func readsEachKindOfPlace() {
        #expect(YarvisPlace("yarvis://tab/prs") == .tab("prs"))
        #expect(YarvisPlace("yarvis://settings") == .settings(nil))
        #expect(YarvisPlace("yarvis://settings/devices/") == .settings("devices"))
        #expect(YarvisPlace("yarvis://setup") == .setup)
        #expect(YarvisPlace("yarvis://tour/") == .tour)
        #expect(YarvisPlace("yarvis://workspace/\(uuid)") == .workspace(id: uuid.lowercased()))
        #expect(YarvisPlace("yarvis://artifact/\(uuid)") == .artifact(id: uuid.lowercased()))
    }

    @Test func leavesAnythingElseInert() {
        for bad in ["https://example.com", "yarvis://", "yarvis://tab", "yarvis://tab/prs/extra", "yarvis://setup/x",
                    "yarvis://workspace/not-a-uuid", "yarvis://artifact/", "yarvis://unknown/thing", "yarvis://tab//"] {
            #expect(YarvisPlace(bad) == nil, "\(bad)")
        }
    }
}

// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "YarvisMac",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "YarvisClient", targets: ["YarvisClient"]),
        .executable(name: "YarvisMac", targets: ["YarvisMac"]),
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.99.3"),
    ],
    targets: [
        // Networking and API models only, no UI, so an iOS app (or the
        // Android client's authors) can read and reuse it as the reference.
        .target(name: "YarvisClient"),
        .executableTarget(
            name: "YarvisMac",
            dependencies: [
                "YarvisClient",
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ]
        ),
        .testTarget(name: "YarvisClientTests", dependencies: ["YarvisClient"]),
    ]
)

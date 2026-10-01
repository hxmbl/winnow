// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "winnow-native",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "winnow", targets: ["winnow"])
    ],
    targets: [
        // Module name must stay `winnow` so the test suite's
        // `@testable import winnow` keeps compiling unchanged.
        .target(
            name: "winnow",
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ]
        ),
        .testTarget(
            name: "winnowTests",
            dependencies: ["winnow"],
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ]
        )
    ]
)
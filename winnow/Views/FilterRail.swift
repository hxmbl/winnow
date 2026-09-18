import SwiftUI

/// Full-width translucent bar at the bottom of the canvas: horizontally
/// scrollable filter pills, with vertical wheel input rerouted to horizontal
/// scrolling while the cursor is over the rail.
struct FilterRail: View {
    @Bindable var store: WinnowStore

    var body: some View {
        // The rail floats; the material keeps its own full-width backdrop.
        ZStack(alignment: .leading) {
            Rectangle()
                .fill(.ultraThinMaterial)
                .overlay(alignment: .top) {
                    Rectangle().frame(height: 1).foregroundStyle(Color.winnowBorder.opacity(0.6))
                }
                .ignoresSafeArea(edges: .bottom)

            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(store.railItems) { item in
                            let filter = item.filter
                            let on = store.activeFilters.contains(.builtin(filter.id))
                            PillButton(
                                label: filter.label,
                                iconName: filter.id.iconName,
                                palette: filter.id.palette,
                                on: on
                            ) {
                                withAnimation(.easeOut(duration: 0.18)) {
                                    store.toggleFilter(.builtin(filter.id))
                                }
                            }
                            .id(item.id)
                        }
                    }
                    .padding(.horizontal, 16)
                    // reserve leading space so first pills don't sit under fixed Inbox
                    .padding(.leading, 132)
                    .padding(.vertical, 8)
                }
                .onChange(of: store.focusedRailIndex) { _, index in
                    guard let index else { return }
                    withAnimation(.easeOut(duration: 0.18)) {
                        proxy.scrollTo(index, anchor: .center)
                    }
                }
            }
            .overlay(FilterRailWheelOverlay())
        }
    }
}

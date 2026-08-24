import AppKit
import SwiftUI

/// Wheel behavior only — maps vertical wheel to horizontal scrolling for the
/// filter rail. Attach as an overlay on the rail's scroll view.
struct FilterRailWheelOverlay: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { FilterRailWheelHostView() }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// Inert host: never hit-testable, so it cannot join the responder/event chain.
/// It only owns the lifetime of a local scroll-wheel monitor that is scoped by
/// geometry — the cursor must sit within the rail's window-frame rectangle.
/// Per-event work is O(1); the rail lookup happens once and is cached.
private final class FilterRailWheelHostView: NSView {
    private var monitor: Any?
    private weak var rail: NSScrollView?

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window, monitor == nil {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                guard let self, event.window === window else { return event }
                return self.rerouted(event: event, in: window)
            }
        } else if window == nil, let monitor {
            NSEvent.removeMonitor(monitor)
            self.monitor = nil
        }
    }

    deinit {
        if let monitor { NSEvent.removeMonitor(monitor) }
    }

    private func rerouted(event: NSEvent, in window: NSWindow) -> NSEvent? {
        let vertical = event.scrollingDeltaY
        let horizontal = event.scrollingDeltaX
        guard abs(vertical) > abs(horizontal), vertical != 0 else { return event }

        guard let rail = currentRail(in: window) else { return event }
        let railFrame = rail.convert(rail.bounds, to: nil)
        guard railFrame.contains(event.locationInWindow) else { return event }

        let delta: CGFloat = event.hasPreciseScrollingDeltas ? vertical : event.deltaY * 12
        var origin = rail.contentView.bounds.origin
        origin.x -= delta
        let maxX = max(0, (rail.documentView?.frame.width ?? 0) - rail.contentView.bounds.width)
        origin.x = min(max(0, origin.x), maxX)
        rail.contentView.scroll(to: origin)
        rail.reflectScrolledClipView(rail.contentView)
        return nil
    }

    private func currentRail(in window: NSWindow) -> NSScrollView? {
        // Cached rail stays valid while it lives in this window and still
        // looks like the rail: short clip, horizontally overflowing document.
        if let rail, rail.window === window,
           rail.frame.height < 80,
           (rail.documentView?.frame.width ?? 0) > rail.bounds.width {
            return rail
        }
        self.rail = nil
        guard let contentView = window.contentView else { return nil }

        var found: NSScrollView?
        func visit(_ view: NSView) {
            guard found == nil else { return }
            if let scrollView = view as? NSScrollView,
               scrollView.frame.height < 80,
               (scrollView.documentView?.frame.width ?? 0) > scrollView.bounds.width {
                found = scrollView
                return
            }
            for sub in view.subviews { visit(sub) }
        }
        visit(contentView)
        rail = found
        return found
    }
}

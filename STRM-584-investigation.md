# STRM-584: Android Return Path Investigation

## Background

This investigation is for issue STRM-584, which is a subtask of STRM-568 (blank screen after clicking on a link). The fix in PR #78 added a `ResumeRepaint` mechanism to handle the blank screen issue by invalidating the WebView on `onResume` and `onWindowFocusChanged` after an `onStop`.

## Goal

Verify the primary HTTPS-link return path using both browser Back and Recents, recording:
1. The lifecycle callback order
2. Whether the same WebView instance survives the stop/resume cycle
3. That the redraw logic works as expected

## Return Path Being Tested

The reported path:
1. User opens an email in Winnow
2. User taps an HTTPS link in the email
3. Link opens via Rust `open_external` and Tauri's opener plugin in the system browser
4. User returns via browser Back OR selects Winnow from Recents
5. Activity should foreground the existing task through stop/resume/focus lifecycle

## Changes Made for Investigation

### MainActivity.kt
- Added logging to track lifecycle callbacks (`onCreate`, `onStop`, `onResume`, `onWindowFocusChanged`, `onNewIntent`)
- Added WebView instance ID tracking using `System.identityHashCode()` to verify instance survival
- All logs use tag "STRM-584" for easy filtering

### ResumeRepaint.kt
- Added logging to track state changes and redraw decisions
- Logs when `stopped` flag is set, checked, and cleared

### commands.rs (Rust)
- Added debug log entry when `open_external` is called to track when links are opened

## Expected Behavior

### Browser Back Return Path
1. User taps link → `open_external` called → browser opens
2. MainActivity receives `onPause` → `onStop` (activity stopped)
3. User presses Back → MainActivity receives `onResume` → `onWindowFocusChanged(true)`
4. `ResumeRepaint` should trigger redraw on both `onResume` and `onWindowFocusChanged`
5. Same WebView instance should be used throughout

### Recents Return Path
1. User taps link → `open_external` called → browser opens
2. MainActivity receives `onPause` → `onStop` (activity stopped)
3. User opens Recents and selects Winnow → MainActivity receives `onResume` → `onWindowFocusChanged(true)`
4. `ResumeRepaint` should trigger redraw on both `onResume` and `onWindowFocusChanged`
5. Same WebView instance should be used throughout

## Out of Scope (per issue description)

The following return paths are distinct and should NOT be investigated unless they reproduce the blank screen:

- **System UI overlays / permission dialogs**: typically pause or change focus without stopping the activity
- **Process reclaimed while browser is open**: returning creates a new activity/process (cold-start restoration)
- **winnow:// notification/deep link**: reaches existing `singleTask` activity through `onNewIntent` (inbound navigation)
- **Multi-window**: focus can return without activity stop

## Testing Instructions

1. Build the APK with these changes
2. Install on Android device
3. Enable debug logging in Dev Options
4. Open an email with an HTTPS link
5. Tap the link to open in browser
6. Return via browser Back
7. Check logcat for "STRM-584" tag logs
8. Repeat steps 4-7, but return via Recents instead
9. Analyze logs to verify:
   - Lifecycle callback order matches expected
   - WebView instance ID remains constant
   - `ResumeRepaint` triggers redraw correctly

## Log Analysis Checklist

- [ ] WebView instance ID is consistent throughout (not recreated)
- [ ] `onStop` is called when browser opens
- [ ] `onResume` is called when returning
- [ ] `onWindowFocusChanged(true)` is called when returning
- [ ] `ResumeRepaint.onStop` sets `stopped = true`
- [ ] `ResumeRepaint.onResume` returns `true` (should redraw)
- [ ] `ResumeRepaint.onFocus` returns `true` and clears `stopped` flag
- [ ] `redraw()` is called and invalidates WebView
- [ ] Same behavior for both Back and Recents return paths

## Notes

- Debug logs require Dev Options → Debug log to be enabled
- Filter logcat with: `adb logcat -s STRM-584:D`
- The debug log also captures `open_external` calls with tag "android" area

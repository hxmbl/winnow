    /// Waits for the browser to land on the loopback URL. Returns the `code`
    /// after validating `state`. Throws on Google-reported errors, state
    /// mismatch, or timeout.
    func awaitCode(expectedState: String, timeout: TimeInterval) async throws -> String {
        let target: URL = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            lock.lock()
            // Store the continuation immediately to ensure it's available before unlocking
            // This avoids race conditions where settle() is called before the continuation is used
            self.continuation = continuation
            
            // Check if redirect already landed before awaitCode — resume immediately.
            if let captured = capturedTarget {
                // Redirect already landed before awaitCode — resume immediately.
                settled = true
                lock.unlock()
                listener?.cancel()
                continuation.resume(returning: captured)
                return
            }
            
            // Release lock before scheduling settlement to avoid race conditions
            // between lock.unlock() and continuation usage.
            lock.unlock()
            
            // Schedule settlement after a short delay to ensure redirect processing
            // has completed before we notify failure.
            queue.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                self?.settle(.failure(GmailAPIError.transport(
                    "Sign-in timed out after \(Int(timeout))s. Close the browser tab and try again."
                ))
            }
        }
    }
/**
 * The end of a native sign-in, made to survive a WebView that was asleep.
 *
 * On Android the redirect lands on the loopback listener while the browser is in
 * front and Winnow's WebView is paused behind it. `oauth_await` resolves, the code
 * reaches the web layer, and the token exchange — then the profile read that names
 * the account — go out from the paused WebView, where `fetch` rejects with a bare
 * `TypeError: Failed to fetch` before any HTTP response.
 *
 * So, before each attempt, the platform gets a chance to wait until the app is in
 * the foreground again (`waitForForeground`), and an attempt that never got a
 * response is sent again after a short backoff. Anything Google actually *answered*
 * — `invalid_grant`, `invalid_client`, a 5xx — is thrown as is, at once: a code is
 * single-use, and resending one Google already rejected cannot help.
 *
 * When every attempt is unreachable, the user gets one plain sentence
 * (`SignInUnreachable`) rather than the browser's "Failed to fetch".
 */

import { GmailError, GoogleUnreachable } from "../gmail/dto";

/** What the user reads when Google could not be reached at all. */
export const EXCHANGE_UNREACHABLE_MESSAGE =
  "Couldn't reach Google to finish signing in. Check your connection and try again.";

/** Pauses before the second, third and fourth attempts. Four attempts in all. */
export const EXCHANGE_RETRY_DELAYS_MS: readonly number[] = [500, 1_500, 3_000];

/** Every attempt to finish a sign-in failed before Google could answer. */
export class SignInUnreachable extends GmailError {
  constructor() {
    super(EXCHANGE_UNREACHABLE_MESSAGE, 0, "network");
    this.name = "SignInUnreachable";
  }
}

export type RetryOptions = {
  /** Resolves once the app is in front (or the platform gives up waiting). */
  waitForForeground?: () => Promise<unknown>;
  /** Which failures may be sent again. Defaults to `isUnreachable`. */
  retryable?: (error: unknown) => boolean;
  /** Backoff before each retry; its length is the number of retries. */
  delaysMs?: readonly number[];
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The token exchange's own "no HTTP response" failure (see `TokenManager.exchangeCode`). */
export function isUnreachable(error: unknown): boolean {
  return error instanceof GoogleUnreachable;
}

/**
 * Also a bare `fetch` rejection, which is how the Gmail client reports one: it does
 * not wrap the `TypeError`. Only for idempotent reads such as the profile.
 */
export function isFetchRejection(error: unknown): boolean {
  return isUnreachable(error) || error instanceof TypeError;
}

/** Run `operation`, waiting for the foreground first and resending unreachable attempts. */
export async function retryWhileUnreachable<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? EXCHANGE_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const retryable = options.retryable ?? isUnreachable;
  const waitForForeground = options.waitForForeground ?? (() => Promise.resolve());

  for (let attempt = 0; ; attempt++) {
    // A platform that cannot tell, or a wait that throws, must not cost the sign-in.
    await waitForForeground().catch(() => undefined);
    try {
      return await operation();
    } catch (error) {
      if (!retryable(error)) throw error;
      if (attempt >= delays.length) throw new SignInUnreachable();
      await sleep(delays[attempt]);
    }
  }
}

/**
 * The authorization-code exchange: resent only when it never got an HTTP response.
 * `invalid_grant` and every other answer from Google are final.
 */
export function exchangeWithRetry<T>(
  exchange: () => Promise<T>,
  options: Omit<RetryOptions, "retryable"> = {},
): Promise<T> {
  return retryWhileUnreachable(exchange, { ...options, retryable: isUnreachable });
}

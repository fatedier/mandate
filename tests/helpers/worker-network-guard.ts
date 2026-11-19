/**
 * Preloaded into every worker a test starts (tests/setup.ts). A worker has
 * a fetch of its own, which the test thread's refusal does not reach, and
 * no test can mock it: so it may reach this machine's loopback, where the
 * tests' stub servers listen, and nothing else. Fetch would follow a
 * redirect to wherever it points without asking, so a redirect it would
 * follow is refused instead: the stubs answer directly.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** The statuses fetch follows (when the response names a Location). */
const FOLLOWED = new Set([301, 302, 303, 307, 308]);
const realFetch = globalThis.fetch.bind(globalThis);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (process.env.MANDATE_TEST_ALLOW_NETWORK === "1") return realFetch(input, init);
  const request = input instanceof Request ? input : undefined;
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!LOOPBACK.has(hostOf(url))) {
    throw new Error(`Test attempted a real network request${url ? ` to ${url}` : ""} from a worker. Use a stub server on 127.0.0.1 instead.`);
  }
  if ((init?.redirect ?? request?.redirect ?? "follow") !== "follow") return realFetch(input, init);
  // Unfollowed, the answer is the same unless it is a redirect fetch would follow.
  const response = await realFetch(input, { ...init, redirect: "manual" });
  const location = response.headers.get("location");
  if (!FOLLOWED.has(response.status) || !location) return response;
  await response.body?.cancel();
  throw new Error(`Test attempted to follow a redirect from ${url} to ${location} from a worker. Stub servers should answer directly.`);
}

globalThis.fetch = Object.assign(guardedFetch, { preconnect: realFetch.preconnect }) as typeof fetch;

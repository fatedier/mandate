/** An Anthropic API root with its version segment. The SDK adds `/v1` only to
 *  Anthropic's own host, so a gateway configured as `https://gw.example` would
 *  be called at `/messages`, while Settings lists its models at `/v1/models`.
 *  Both go through here, so a gateway that lists its models also answers the
 *  agent. Empty is Anthropic's own host. */
export function anthropicApiBase(baseURL: string | undefined): string {
  const base = (baseURL || "https://api.anthropic.com").replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

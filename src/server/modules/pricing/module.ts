import type { Context } from "hono";
import { getBunServer } from "hono/bun";
import type { MandateModule } from "../module.js";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import type {
  PriceCatalogResponse,
  PriceMatchDto,
  PriceMatchResponse,
  PricingStatusResponse,
  ProviderPricingResponse
} from "../../../shared/api/pricing.js";
import type { ProviderConfig } from "../../config/types.js";
import { providerModelsWithBuiltins } from "../settings/provider-models.js";
import { refKey, type PriceCatalog, type PriceMatch } from "./catalog.js";

const SEARCH_LIMIT = 20;
/** How long Settings waits for price data on its way before answering with
 *  what there is. */
const DOWNLOAD_WAIT_MS = 15_000;

export function priceMatchDto(match: PriceMatch): PriceMatchDto {
  return {
    ref: refKey(match.ref),
    label: match.label,
    origin: match.ref.origin === "models.dev" ? "models.dev" : "litellm",
    rates: match.rates,
    dataDate: match.ref.dataDate
  };
}

/** What Automatic finds for a model on a connection; a suggestion only when
 *  it finds nothing. */
function matchFor(catalog: PriceCatalog, provider: ProviderConfig, model: string): PriceMatchResponse {
  const found = catalog.match(model, provider.baseURL, provider.type);
  // At a plan's address the way forward is its Billing, not a list price.
  const suggestion = found || catalog.isPlanProvider(provider.baseURL) ? null : catalog.suggest(model);
  return { found: found ? priceMatchDto(found) : null, suggestion: suggestion ? priceMatchDto(suggestion) : null };
}

function providerNamed(providers: Record<string, ProviderConfig> | undefined, name: string | undefined): ProviderConfig | null {
  return providers && name && Object.hasOwn(providers, name) ? providers[name]! : null;
}

/** What Settings shows about prices: per connection and model, a catalog
 *  search for Price as, and the data's date. Asking for any of it downloads
 *  the price data when it is missing. */
export const pricingModule: MandateModule = {
  id: "pricing",
  mountRoutes: (app, { deps }) => {
    const catalog = async (c: Context) => {
      deps.priceData?.ensure?.();
      // Bun closes a request that writes nothing for 10 s; this one may wait
      // longer for the download. In-process app.request() has no Bun server.
      const server = c.env ? getBunServer<{ timeout?: (request: Request, seconds: number) => void }>(c) : undefined;
      server?.timeout?.(c.req.raw, DOWNLOAD_WAIT_MS / 1000 + 5);
      await deps.priceData?.whenSettled?.(DOWNLOAD_WAIT_MS);
      return deps.priceData?.catalog() ?? null;
    };

    app.get(API_ROUTES.pricingProvider, async (c) => {
      const provider = providerNamed(deps.config?.models.providers, c.req.param("name"));
      const prices = await catalog(c);
      if (!provider || !prices) return c.json({ error: "not found" }, 404);
      const models: ProviderPricingResponse["models"] = {};
      for (const model of providerModelsWithBuiltins(provider)) models[model.id] = matchFor(prices, provider, model.id);
      return c.json({ planSuggested: prices.isPlanProvider(provider.baseURL), models } satisfies ProviderPricingResponse);
    });

    app.get(API_ROUTES.pricingMatch, async (c) => {
      const provider = providerNamed(deps.config?.models.providers, c.req.query("provider"));
      const model = c.req.query("model")?.trim();
      const prices = await catalog(c);
      if (!provider || !prices || !model) return c.json({ error: "not found" }, 404);
      return c.json(matchFor(prices, provider, model) satisfies PriceMatchResponse);
    });

    app.get(API_ROUTES.pricingCatalog, async (c) => {
      const prices = await catalog(c);
      const query = c.req.query("q") ?? "";
      return c.json({ results: prices ? prices.search(query, SEARCH_LIMIT).map(priceMatchDto) : [] } satisfies PriceCatalogResponse);
    });

    app.get(API_ROUTES.pricingStatus, async (c) => {
      const info = (await catalog(c))?.dataInfo();
      return c.json({
        autoUpdate: deps.config?.models.prices?.autoUpdate !== false,
        litellmDate: info?.litellmDate ?? null,
        modelsDevDate: info?.modelsDevDate ?? null
      } satisfies PricingStatusResponse);
    });
  }
};

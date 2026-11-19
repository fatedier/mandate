import { useEffect, useState } from "react";
import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";
import type {
  PriceCatalogResponse,
  PriceMatchDto,
  PriceMatchResponse,
  PricingStatusResponse,
  ProviderPricingResponse
} from "@shared/api/pricing";

/** Reads a pricing endpoint while `url` names one; null until it answers, and
 *  when it cannot (a provider not saved yet answers 404). */
function usePricingJson<T>(url: string | null): T | null {
  const [state, setState] = useState<{ url: string | null; value: T | null }>({ url: null, value: null });
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then((res) => (res.ok ? readJson<T>(res) : null))
      .then((value) => { if (!controller.signal.aborted) setState({ url, value }); })
      .catch(() => { if (!controller.signal.aborted) setState({ url, value: null }); });
    return () => controller.abort();
  }, [url]);
  return state.url === url ? state.value : null;
}

/** What Automatic finds for a model id on a saved connection. */
export function usePriceMatch(providerName: string, modelId: string): PriceMatchResponse | null {
  const id = modelId.trim();
  return usePricingJson<PriceMatchResponse>(providerName && id ? api.pricingMatch(providerName, id) : null);
}

/** Per saved model: what Automatic finds or a suggestion; and the plan hint.
 *  `version` re-reads it when the connection is saved again. */
export function useProviderPricing(providerName: string | null, version: string): ProviderPricingResponse | null {
  const url = providerName ? `${api.pricingProvider(providerName)}#${encodeURIComponent(version)}` : null;
  return usePricingJson<ProviderPricingResponse>(url);
}

export function usePricingStatus(): PricingStatusResponse | null {
  return usePricingJson<PricingStatusResponse>(api.pricingStatus);
}

export async function searchPriceCatalog(query: string, signal?: AbortSignal): Promise<PriceMatchDto[]> {
  const res = await fetch(api.pricingCatalog(query), { signal });
  if (!res.ok) return [];
  return (await readJson<PriceCatalogResponse>(res)).results;
}

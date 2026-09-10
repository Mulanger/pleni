import { parseSearchV2Request, parseSearchV2Response, parseSearchSuggestions,
  type SearchV2Request, type SearchSuggestion } from "./v2-types.ts";

export class SearchV2ApiError extends Error {
  readonly kind: "network" | "rate_limited" | "cursor_expired" | "unavailable";
  constructor(kind: SearchV2ApiError["kind"]) {super(kind);this.kind=kind;}
}
export function createSearchV2Client(options: {supabaseUrl: string; publishableKey: string; fetcher?: typeof fetch}) {
  async function post(body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!options.supabaseUrl || !options.publishableKey) throw new SearchV2ApiError("unavailable");
    let response: Response;
    try {
      response=await (options.fetcher ?? fetch)(`${options.supabaseUrl.replace(/\/$/u,"")}/functions/v1/clip-search-v2`,{
        method:"POST",headers:{apikey:options.publishableKey,"Content-Type":"application/json"},
        body:JSON.stringify(body),signal,cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer"});
    } catch(error) {if (signal?.aborted) throw error;throw new SearchV2ApiError("network");}
    if (!response.ok) throw new SearchV2ApiError(response.status===429 ? "rate_limited" : response.status===409 ? "cursor_expired" : "unavailable");
    try {return await response.json();} catch {throw new SearchV2ApiError("unavailable");}
  }
  return {
    async search(request: SearchV2Request,signal?: AbortSignal) {
      const body=await post(parseSearchV2Request(request),signal);
      try {return parseSearchV2Response(body);} catch {throw new SearchV2ApiError("unavailable");}
    },
    async suggest(query: string,kind?: SearchSuggestion["kind"],signal?: AbortSignal) {
      const body=await post({operation:"suggest",query,...(kind ? {kind} : {})},signal) as {suggestions: unknown};
      try {return parseSearchSuggestions(body.suggestions);} catch {throw new SearchV2ApiError("unavailable");}
    }
  };
}

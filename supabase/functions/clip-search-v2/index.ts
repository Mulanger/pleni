import { allowedOrigins } from "../_shared/cors.ts";
import { callServiceRpc } from "../_shared/db.ts";
import { createSearchV2Handler } from "../_shared/search/api-v2.ts";
import { createOpenAIEmbeddings } from "../_shared/search/openai.ts";

Deno.serve(createSearchV2Handler({
  prepare: (key,catalog,purpose)=>callServiceRpc("prepare_search_v2",{p_key:key,p_catalog:catalog,p_purpose:purpose}),
  reserveTokens: tokens=>callServiceRpc("reserve_search_provider_tokens",{p_token_count:tokens}),
  async embed(topic) {
    const response=await createOpenAIEmbeddings([topic],{apiKey:Deno.env.get("OPENAI_API_KEY") ?? "",
      baseUrl:Deno.env.get("OPENAI_EMBEDDINGS_BASE_URL"),timeoutMs:1200});
    return response.embeddings[0];
  },
  retrieve: parameters=>callServiceRpc("search_clips_v2",parameters),
  suggest: (query,kind)=>callServiceRpc("search_suggestions_v2",{p_query:query,p_kind:kind}),
  log: summary=>console.log(JSON.stringify(summary)),
},{allowedOrigins:allowedOrigins(Deno.env.get("ALLOWED_ORIGINS")),
  secret:Deno.env.get("SEARCH_RATE_LIMIT_SECRET") ?? ""}));

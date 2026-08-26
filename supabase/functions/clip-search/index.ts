import { allowedOrigins } from "../_shared/cors.ts";
import { callServiceRpc } from "../_shared/db.ts";
import { createClipSearchHandler } from "../_shared/search/api.ts";
import { createOpenAIEmbeddings } from "../_shared/search/openai.ts";

const handler = createClipSearchHandler(
  {
    prepareRequest: (keyHash) => callServiceRpc(
      "prepare_clip_search_request",
      { p_key_hash: keyHash },
    ),
    consumeRequestLimit: (keyHash) => callServiceRpc(
      "consume_search_request_limit",
      { p_key_hash: keyHash },
    ),
    reserveProviderTokens: (tokenCount) => callServiceRpc(
      "reserve_search_provider_tokens",
      { p_token_count: tokenCount },
    ),
    async embedTopic(topic) {
      const result = await createOpenAIEmbeddings([topic], {
        apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
        baseUrl: Deno.env.get("OPENAI_EMBEDDINGS_BASE_URL"),
        timeoutMs: 10_000,
      });
      return result.embeddings[0];
    },
    searchCandidates: (request) => callServiceRpc(
      "search_clip_candidates_v2",
      {
        p_topic: request.topic,
        p_query_embedding: request.queryEmbedding,
        p_limit: request.limit,
        p_politician_id: request.politicianId,
        p_party: request.party,
        p_date_from: request.dateFrom,
        p_date_to: request.dateTo,
        p_source_ids: request.sourceIds,
      },
    ),
    loadEventDestination: (eventId) => callServiceRpc(
      "get_search_event_destination",
      { p_event_id: eventId },
    ),
    log: (summary) => console.log(JSON.stringify(summary)),
  },
  {
    allowedOrigins: allowedOrigins(Deno.env.get("ALLOWED_ORIGINS")),
    rateLimitSecret: Deno.env.get("SEARCH_RATE_LIMIT_SECRET") ?? "",
  },
);

Deno.serve(handler);

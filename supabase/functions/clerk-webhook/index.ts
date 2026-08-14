import { callServiceRpc, ServiceDatabaseError } from "../_shared/db.ts";
import { verifySvixSignature } from "../_shared/svix.ts";

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await request.text();
  const secret = Deno.env.get("CLERK_WEBHOOK_SIGNING_SECRET") ?? "";
  try {
    if (!secret) throw new Error("webhook_not_configured");
    await verifySvixSignature(request.headers, body, secret);
    const event = JSON.parse(body) as { type?: unknown; data?: { id?: unknown } };
    if (event.type === "user.deleted") {
      const subject = typeof event.data?.id === "string" ? event.data.id : "";
      if (!subject) throw new Error("missing_subject");
      await callServiceRpc("delete_recommendation_subject", { p_subject: subject });
    }
    return new Response("ok", { status: 200 });
  } catch (error) {
    const status = error instanceof ServiceDatabaseError ? 503 : 401;
    return new Response(error instanceof Error ? error.message : "webhook_failed", { status });
  }
});

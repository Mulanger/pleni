import { supabaseRest } from "./supabase";

export const COMMENT_MAX_LENGTH = 500;
export const COMMENT_USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

export type CommentReportReason =
  | "spam"
  | "harassment"
  | "hate"
  | "private_information"
  | "illegal"
  | "other";

export interface VideoComment {
  id: string;
  clipId: string;
  authorUsername: string;
  body: string;
  createdAt: string;
  isOwn: boolean;
}

export interface CommentThread {
  count: number;
  comments: VideoComment[];
}

interface RawVideoComment {
  id: string;
  clip_id: string;
  author_username: string;
  body: string;
  created_at: string;
  is_own: boolean;
}

interface RawCommentThread {
  count: number;
  comments: RawVideoComment[];
}

interface RawCommentProfile {
  username: string;
}

/** A stable error code emitted by the database RPC, safe to map to Swedish UI copy. */
export class CommentApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
    this.name = "CommentApiError";
  }
}

export async function loadVideoComments(
  clipId: string,
  accessToken: string | null = null
): Promise<CommentThread> {
  let response = await commentRpc("list_video_comments", { p_clip_id: clipId, p_limit: 100 }, accessToken);
  // Reading is public. A stale Clerk token should only lose the `isOwn` marker,
  // never make the discussion unavailable to a signed-in viewer.
  if (response.status === 401 && accessToken) {
    response = await commentRpc("list_video_comments", { p_clip_id: clipId, p_limit: 100 }, null);
  }
  const payload = await decodeResponse<RawCommentThread>(response);
  return {
    count: Number(payload.count ?? 0),
    comments: Array.isArray(payload.comments) ? payload.comments.map(mapComment) : []
  };
}

export async function loadMyCommentUsername(accessToken: string): Promise<string | null> {
  const response = await commentRpc("get_my_comment_profile", {}, accessToken);
  const payload = await decodeResponse<RawCommentProfile | null>(response);
  return payload?.username?.trim() || null;
}

export async function createVideoComment(
  clipId: string,
  body: string,
  username: string | null,
  accessToken: string
): Promise<VideoComment> {
  const response = await commentRpc(
    "create_video_comment",
    { p_clip_id: clipId, p_body: body, p_username: username },
    accessToken
  );
  return mapComment(await decodeResponse<RawVideoComment>(response));
}

export async function deleteVideoComment(commentId: string, accessToken: string): Promise<void> {
  const response = await commentRpc(
    "delete_video_comment",
    { p_comment_id: commentId },
    accessToken
  );
  await decodeResponse<boolean>(response);
}

export async function reportVideoComment(
  commentId: string,
  reason: CommentReportReason,
  accessToken: string | null
): Promise<void> {
  const response = await commentRpc(
    "report_video_comment",
    { p_comment_id: commentId, p_reason: reason },
    accessToken
  );
  await decodeResponse<boolean>(response);
}

export function normalizeCommentUsername(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "");
}

export function commentErrorMessage(error: unknown): string {
  if (!(error instanceof CommentApiError)) {
    return "Något gick fel. Försök igen.";
  }
  const messages: Record<string, string> = {
    authentication_required: "Logga in för att kommentera.",
    username_invalid: "Använd 3–24 små bokstäver, siffror eller understreck.",
    username_reserved: "Det användarnamnet är reserverat.",
    username_taken: "Användarnamnet är redan taget.",
    comment_account_suspended: "Ditt konto kan inte kommentera just nu.",
    comment_body_required: "Skriv en kommentar först.",
    comment_too_long: `Kommentaren får vara högst ${COMMENT_MAX_LENGTH} tecken.`,
    comment_links_not_allowed: "Länkar är inte tillåtna i kommentarer ännu.",
    comment_clip_unavailable: "Det här klippet går inte att kommentera.",
    comment_rate_limited: "Du kommenterar för snabbt. Vänta en stund.",
    comment_not_owned_or_missing: "Kommentaren kunde inte tas bort.",
    comment_missing: "Kommentaren finns inte längre.",
    report_reason_invalid: "Välj en anledning till rapporten."
  };
  return messages[error.code] ?? "Något gick fel. Försök igen.";
}

async function commentRpc(
  name: string,
  body: Record<string, unknown>,
  accessToken: string | null
): Promise<Response> {
  return supabaseRest(`rpc/${name}`, {
    method: "POST",
    body,
    accessToken
  });
}

async function decodeResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const fallback = `comment_request_failed_${response.status}`;
    try {
      const payload = (await response.json()) as { message?: string };
      throw new CommentApiError(payload.message?.trim() || fallback, response.status);
    } catch (error) {
      if (error instanceof CommentApiError) {
        throw error;
      }
      throw new CommentApiError(fallback, response.status);
    }
  }
  return (await response.json()) as T;
}

function mapComment(row: RawVideoComment): VideoComment {
  return {
    id: row.id,
    clipId: row.clip_id,
    authorUsername: row.author_username,
    body: row.body,
    createdAt: row.created_at,
    isOwn: row.is_own === true
  };
}

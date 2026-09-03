export type ViewerUserIdentity = {
  id: string;
  createdAt?: Date | null;
  lastSignInAt?: Date | null;
  username?: string | null;
};

export type ViewerIdentity = {
  signedIn: boolean;
  userId: string | null;
  createdAt: number | null;
  lastSignInAt: number | null;
  suggestedUsername: string | null;
};

export const SIGNED_OUT_VIEWER: ViewerIdentity = {
  signedIn: false,
  userId: null,
  createdAt: null,
  lastSignInAt: null,
  suggestedUsername: null
};

function signedInViewer(user: ViewerUserIdentity): ViewerIdentity {
  return {
    signedIn: true,
    userId: user.id,
    createdAt: user.createdAt?.getTime() ?? null,
    lastSignInAt: user.lastSignInAt?.getTime() ?? null,
    suggestedUsername: user.username ?? null
  };
}

/**
 * Reduce one Clerk resource emission into settled viewer state.
 *
 * Undefined resources are transitional and must not briefly sign the viewer
 * out. Null resources are Clerk's settled signed-out state. A signed-in
 * emission contains both the user and its active session.
 */
export function nextViewerIdentity(
  current: ViewerIdentity,
  user: ViewerUserIdentity | null | undefined,
  session: unknown | null | undefined
): ViewerIdentity {
  if (user === undefined || session === undefined) {
    return current;
  }
  if (user === null || session === null) {
    return SIGNED_OUT_VIEWER;
  }
  return signedInViewer(user);
}

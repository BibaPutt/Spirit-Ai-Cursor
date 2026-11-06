// Current-reference screenshot tracker. Annotation tags and the describe_region
// tool both reference "the image currently attached to the conversation". This
// module tracks that image so tools can crop/describe it without plumbing a
// base64 through every call. Set at submit (handlers.ts, with the actual turn
// image) and whenever an agentic see_screen attaches a fresh shot (router.ts).
// Cleared at the start of every new query run via clearCurrentImage().

let currentImageB64: string | null = null;

export function setCurrentImage(b64: string | null): void {
  currentImageB64 = b64 && b64.length > 0 ? b64 : null;
}

export function getCurrentImage(): string | null {
  return currentImageB64;
}

export function clearCurrentImage(): void {
  currentImageB64 = null;
}
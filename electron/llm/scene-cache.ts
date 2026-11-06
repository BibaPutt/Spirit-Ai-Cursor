// Main-side stash of the most recent scene elements. ui_read/ui_click/drag all
// build a fresh accessibility scene per call; this module remembers the last
// one so the answering model can reference real elements in its annotation
// stream ([BOX:el123:label] → the exact UIA/AX/OCR frame) without re-walking
// the tree. Cleared at the start of every new query run so stale ids never
// resolve into boxes from a previous task.

import { resolveElementById, type SceneElement } from '../capture/scene';

let lastElements: SceneElement[] | null = null;

// A resolved element frame in the SAME coordinate space ui_click clicks in
// (absolute screen DIP, primary-monitor origin).
export type ResolvedElementFrame = {
  bounds: [number, number, number, number];
  center: [number, number];
};

export function rememberSceneElements(elements: SceneElement[]): void {
  lastElements = elements.length > 0 ? elements : null;
}

export function clearSceneElements(): void {
  lastElements = null;
}

export function hasSceneElements(): boolean {
  return lastElements !== null;
}

export function getSceneElements(): SceneElement[] | null {
  return lastElements;
}

// Resolve an element id to its human-friendly identity (control type + name /
// visible text) so approval prompts and UI labels can say `Click "Downloads"`
// instead of `Clicking element el74d19…`. Returns null when the id is unknown
// or no scene has been seen — callers then fall back to the raw id.
export function resolveSceneElementLabel(id: unknown): { type: string; name: string } | null {
  if (!lastElements) return null;
  const el = resolveElementById(lastElements, id);
  if (!el) return null;
  return { type: el.type, name: el.name };
}

// Resolve a "[BOX:el<id>:label]" reference to a real element frame. Returns
// null when the id is unknown, looks like a hallucinated container, or no
// scene has been seen yet — the caller drops the tag silently then.
export function resolveSceneElementFrame(id: unknown): ResolvedElementFrame | null {
  if (!lastElements) return null;
  const el = resolveElementById(lastElements, id);
  if (!el) return null;
  const b = el.bounds;
  return { bounds: [b[0], b[1], b[2], b[3]], center: el.center };
}
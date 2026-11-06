// macOS Accessibility (AX) scene walk — the ui_read/ui_click element tree for
// macOS, the counterpart of the Windows UIA walk. Implemented as a bounded JXA
// (`osascript -l JavaScript`) script over the AXUIElement C API via the ObjC
// bridge. Requires the user to grant Spirit Accessibility permission; without
// it every copy call fails and the walk yields an empty tree — the OCR layer
// still carries the scene, so ui_read degrades gracefully instead of erroring.
//
// Coordinate space: AX bounds are in the global point space CGEvent (click /
// move_mouse) uses — the same space Electron reports in DIPs on macOS — so no
// scaling is applied (unlike Windows UIA's physical pixels).
//
// The role→type mapping is kept here as pure functions so vitest can cover it
// without Electron.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface RawAxElement {
  role: string;
  name: string;
  enabled: boolean;
  bounds: [number, number, number, number];
  center: [number, number];
}

export interface AxScene {
  title: string;
  elements: RawAxElement[];
}

// Bounded AX tree walk. Each element keeps its role/name/enabled and its
// AXPosition/AXSize decoded via AXValueGetValue (with a description-parse
// fallback). AXValueType constants: 1 = kAXValueCGPointType, 2 = kAXValueCGSizeType.
function axWalkScript(pid: number, maxDepth: number, maxElements: number): string {
  return `
ObjC.import('ApplicationServices');
ObjC.import('Foundation');
const targetPid = ${pid};
const maxDepth = ${maxDepth};
const maxElements = ${maxElements};

function getAttr(el, name) {
  try {
    const out = Ref();
    const err = $.AXUIElementCopyAttributeValue(el, name, out);
    if (err !== 0) return null;
    return out[0];
  } catch (e) { return null; }
}
function str(v) {
  if (v === null || v === undefined) return '';
  try {
    const u = ObjC.unwrap(v);
    return typeof u === 'string' ? u : String(u);
  } catch (e) { return String(v); }
}
function boolAttr(el, name, fallback) {
  const v = getAttr(el, name);
  if (v === null || v === undefined) return fallback;
  try {
    const u = ObjC.unwrap(v);
    if (typeof u === 'boolean') return u;
    if (typeof u === 'number') return u !== 0;
    return fallback;
  } catch (e) { return fallback; }
}
function pointAttr(el, name) {
  const v = getAttr(el, name);
  if (!v) return null;
  try {
    const ref = Ref();
    const err = $.AXValueGetValue(v, 1, ref); // kAXValueCGPointType
    if (err === 0 && typeof ref[0] === 'number' && typeof ref[1] === 'number') return [ref[0], ref[1]];
  } catch (e) {}
  try {
    const m = String(v.description).match(/x=([-\\d.]+)\\s*y=([-\\d.]+)/);
    if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  } catch (e) {}
  return null;
}
function sizeAttr(el, name) {
  const v = getAttr(el, name);
  if (!v) return null;
  try {
    const ref = Ref();
    const err = $.AXValueGetValue(v, 2, ref); // kAXValueCGSizeType
    if (err === 0 && typeof ref[0] === 'number' && typeof ref[1] === 'number') return [ref[0], ref[1]];
  } catch (e) {}
  try {
    const m = String(v.description).match(/width=([-\\d.]+)\\s*height=([-\\d.]+)/);
    if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  } catch (e) {}
  return null;
}

const app = $.AXUIElementCreateApplication(targetPid);
const out = [];
let title = '';

const queue = [];
const wins = getAttr(app, 'AXWindows');
if (wins) {
  let arr = null;
  try { arr = ObjC.unwrap(wins); } catch (e) {}
  if (Array.isArray(arr)) { for (let i = 0; i < arr.length; i++) queue.push([arr[i], 0]); }
  else queue.push([wins, 0]);
}
if (queue.length === 0) queue.push([app, 0]);

while (queue.length > 0 && out.length < maxElements) {
  const item = queue.shift();
  const el = item[0];
  const depth = item[1];
  if (depth > maxDepth) continue;
  const role = str(getAttr(el, 'AXRole'));
  if (!role) continue;
  const name = str(getAttr(el, 'AXTitle')) || str(getAttr(el, 'AXDescription'));
  const enabled = boolAttr(el, 'AXEnabled', true);
  const pos = pointAttr(el, 'AXPosition');
  const size = sizeAttr(el, 'AXSize');
  if (pos && size && size[0] > 0 && size[1] > 0) {
    out.push({
      role: role,
      name: name,
      enabled: enabled,
      bounds: [pos[0], pos[1], pos[0] + size[0], pos[1] + size[1]],
      center: [pos[0] + size[0] / 2, pos[1] + size[1] / 2],
    });
    if (role === 'AXWindow' && !title) title = name;
  }
  if (depth < maxDepth) {
    const children = getAttr(el, 'AXChildren');
    if (children) {
      let arr = null;
      try { arr = ObjC.unwrap(children); } catch (e) {}
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i++) queue.push([arr[i], depth + 1]);
      }
    }
  }
}
JSON.stringify({ title: title, elements: out });
`;
}

// Walk the AX tree of `pid`'s app, bounded (same limits as the UIA walk).
// Best-effort: any failure (no Accessibility permission, pid gone, script
// error) yields an empty scene so the OCR layer still carries ui_read.
export async function walkAx(
  pid: number,
  opts: { maxDepth?: number; maxElements?: number } = {},
): Promise<AxScene> {
  const maxDepth = opts.maxDepth ?? 5;
  const maxElements = opts.maxElements ?? 500;
  try {
    const { stdout } = await execFileP(
      'osascript',
      ['-l', 'JavaScript', '-e', axWalkScript(pid, maxDepth, maxElements)],
      { timeout: 15000, windowsHide: true },
    );
    const parsed = JSON.parse(stdout.trim()) as {
      title?: unknown;
      elements?: unknown;
    };
    const elements: RawAxElement[] = Array.isArray(parsed.elements)
      ? (parsed.elements as RawAxElement[])
          .filter((el) => el && typeof el.role === 'string')
          .map((el) => ({
            role: el.role,
            name: typeof el.name === 'string' ? el.name : '',
            enabled: el.enabled !== false,
            bounds: [
              Math.round(Number(el.bounds?.[0]) || 0),
              Math.round(Number(el.bounds?.[1]) || 0),
              Math.round(Number(el.bounds?.[2]) || 0),
              Math.round(Number(el.bounds?.[3]) || 0),
            ] as [number, number, number, number],
            center: [
              Math.round(Number(el.center?.[0]) || 0),
              Math.round(Number(el.center?.[1]) || 0),
            ] as [number, number],
          }))
      : [];
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      elements,
    };
  } catch {
    return { title: '', elements: [] };
  }
}

// AX role → scene type, aligned with the Windows UIA type names so the
// existing clickable/container logic and the prompt wording stay shared.
export function axRoleToType(role: string): string {
  switch (role) {
    case 'AXWindow':
    case 'AXSheet':
    case 'AXDialog':
      return 'Window';
    case 'AXButton':
      return 'Button';
    case 'AXCheckBox':
      return 'CheckBox';
    case 'AXRadioButton':
      return 'RadioButton';
    case 'AXPopUpButton':
    case 'AXMenuButton':
    case 'AXComboBox':
      return 'ComboBox';
    case 'AXTextField':
    case 'AXTextArea':
      return 'Edit';
    case 'AXLink':
      return 'Hyperlink';
    case 'AXTabGroup':
      return 'TabItem';
    case 'AXMenuBarItem':
      return 'MenuItem';
    case 'AXListItem':
    case 'AXRow':
      return 'ListItem';
    case 'AXOutline':
      return 'TreeItem';
    case 'AXSlider':
      return 'Slider';
    case 'AXGroup':
      return 'Group';
    case 'AXStaticText':
      return 'Text';
    case 'AXMenuBar':
      return 'MenuBar';
    case 'AXToolbar':
      return 'ToolBar';
    case 'AXScrollArea':
      return 'Pane';
    case 'AXScrollBar':
      return 'ScrollBar';
    case 'AXSplitGroup':
      return 'SplitPane';
    case 'AXCell':
      return 'DataItem';
    default:
      return 'unknown';
  }
}

// AX roles that map to actionable controls (mirrors the Windows CLICKABLE set).
const AX_CLICKABLE_TYPES = new Set([
  'Button',
  'SplitButton',
  'MenuItem',
  'CheckBox',
  'RadioButton',
  'ComboBox',
  'TabItem',
  'Hyperlink',
  'ListItem',
  'TreeItem',
  'Edit',
  'SpinButton',
  'ScrollBar',
  'Thumb',
]);

export function axRoleClickable(role: string): boolean {
  return AX_CLICKABLE_TYPES.has(axRoleToType(role));
}

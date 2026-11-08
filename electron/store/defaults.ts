// Pure, Electron-free settings defaults for the Electron main process.
//
// electron/store/settings.ts overwrites STORE_DEFAULTS.workspaceFolder with
// the app.getPath('documents')-based path before the store is built (see that
// file), then hands the object to electron-store as `defaults`.
//
// HARD RULE: nothing in this module may import 'electron' at runtime.
// Type-only imports from electron-adjacent modules are fine (erased at
// compile time).

import { join } from 'node:path';
import { homedir } from 'node:os';
import { MODELS } from '../llm/models';
import type {
  ChipVisibility,
  ProviderId,
  ProviderSettings,
  TriggerHotkey,
  UserProfile,
} from '../types';
import type { EncryptedKey, SecureProviderMap } from './secure-keys';

export type Schema = {
  // On-disk schema version. v1 = the post-bugfix plain-JSON layout.
  storageVersion: number;
  // Legacy plaintext slot. Kept readable so we can migrate any pre-existing
  // OpenRouter key on first launch, then cleared.
  openrouterApiKey: string;
  primaryModel: string;
  fallbackModel: string;
  webSearch: boolean;
  workspaceFolder: string;
  // Legacy plaintext provider map. Migrated into providersSecure on first
  // read and then blanked out.
  providers: Record<ProviderId, ProviderSettings>;
  // Active provider map. API keys are safeStorage-encrypted base64 strings;
  // see ./secure-keys.ts.
  providersSecure: SecureProviderMap | null;
  // Vision bridge API key (encrypted, single slot — NOT a ProviderId). See
  // getVisionBridgeKey / setVisionBridgeKey.
  visionBridgeSecure: EncryptedKey | null;
  autoApproveTools: boolean;
  memorySaveEnabled: boolean;
  contextMemoryEnabled: boolean;
  maxContextTokens: number;
  // Auto context (default on): budget follows the serving model's window.
  // maxContextTokens applies only when the user turns this off.
  autoContext: boolean;
  // Annotation final pass (default off): after the answer lands, re-decide
  // every tag's coordinate space and re-broadcast corrected boxes. Off =
  // live boxes only, no second annotate step.
  annotFinalPass: boolean;
  voiceLanguage: string;
  sttEngine: 'auto' | 'local' | 'cloud';
  // Speech model id for local STT (tiny|base|small|turbo|medium|large-v3).
  // Managed in Settings → Voice (1-click download/delete). Empty = default.
  sttModel: string;
  // One-line voice context fed to Whisper as initial_prompt ("I mix Hindi
  // and English, I talk about code"). Pins vocabulary + language.
  sttInitialPrompt: string;
  // Personal word fixes, one per line: "spear it -> Spirit". Applied to the
  // final transcript (post-filter), never to live text.
  sttWordOverrides: string;
  triggerHotkey: TriggerHotkey;
  userProfile: UserProfile;
  // GDPR-friendly default: profile data is NOT injected into the system
  // prompt unless the user explicitly opts in.
  personalizePrompts: boolean;
  dismissOnDoubleClick: boolean;
  // Voice-first conversation mode. Off by default.
  audioMode: boolean;
  themePreference: 'system' | 'light' | 'dark';
  mouseWiggleEnabled: boolean;
  wiggleSensitivity: 'low' | 'normal' | 'high';
  chipVisibility: ChipVisibility;
  // Whether chips reuse the main provider chain (true) or a chips-only
  // provider set (false). See chipsProvidersSecure / chipsLocalAiConfig.
  chipsUseMainProvider: boolean;
  chipsSource: 'smart' | 'premade' | 'custom';
  customChips: Array<{ label: string; prompt: string; icon?: string }>;
  // Chips-only encrypted provider map (parallel to providersSecure). Used
  // only when chipsUseMainProvider is false.
  chipsProvidersSecure: SecureProviderMap | null;
  // Chips-only Local AI plain config (parallel to the `providers` localai
  // slot): server address, model, detected list, capability toggles.
  chipsLocalAiConfig: ProviderSettings;
  reducedTransparency: boolean;
  // Glass look (Hermes-style). See types.ts. Added in schema v4; migrated
  // from the legacy reducedTransparency boolean (true → clear/60).
  glassMode: 'clear' | 'glass';
  glassIntensity: number;
  glassFade: number;
  glassMaterial: 'under-window' | 'popover' | 'titlebar' | 'header';
  glassScope: 'window' | 'sidebar';
  screenshotCropW: number;
  screenshotCropH: number;
  annotOffsetX: number;
  annotOffsetY: number;
  // Which calendar service `system_action` opens for "add to my calendar":
  // 'google' (Google Calendar template) or 'outlook' (Outlook.com compose).
  calendarProvider: 'google' | 'outlook';
  notificationsEnabled: boolean;
  clearMemoryOnQuit: boolean;
  // Ghost mode (stealth). When on, every Spirit window is excluded from
  // screen capture (Windows/macOS) and the tray icon is hidden. Linux has
  // no equivalent capture-exclusion API; the taskbar is always hidden.
  ghostMode: boolean;
  // Hide the tray icon even when ghost mode is off. Independent of ghost
  // mode; keyboard shortcuts remain available.
  hideTrayIcon: boolean;
  customShortcuts: Record<string, string>;
  // Enabled skill ids (Phase 5). null = never configured → the bundled
  // skills' defaultEnabled frontmatter decides. Skills are kept OUT of the
  // Settings object; they're read/toggled through the dedicated skills:* IPC.
  enabledSkills: string[] | null;
  // Per-tool permission rules (opencode-style last-wins allow/deny), keyed by
  // tool name: 'allow' skips the approval card, 'deny' blocks without asking.
  // Absent = default flow (approval card unless auto-approve / run grant).
  // Managed programmatically for now (no Settings UI yet); survives restarts.
  permissionRules: Record<string, 'allow' | 'deny'>;
};

export const STORAGE_VERSION = 6;

export const DEFAULT_USER_PROFILE: UserProfile = {
  name: '',
  role: '',
  preferredLanguage: '',
  translateLanguage: '',
};

export const defaultTriggerHotkey = (): 'MetaRight' | 'CtrlRight' =>
  process.platform === 'darwin' ? 'MetaRight' : 'CtrlRight';

export const DEFAULT_PROVIDERS: Record<ProviderId, ProviderSettings> = {
  openrouter: { apiKey: '', enabled: true },
  anthropic: { apiKey: '', enabled: false },
  openai: { apiKey: '', enabled: false },
  gemini: { apiKey: '', enabled: false },
  localai: { apiKey: '', enabled: false },
  opencode: { apiKey: '', enabled: false, baseUrl: 'http://127.0.0.1:4096' },
};

// Single source of truth for the provider ids in the encrypted key map.
// Every consumer (settings read/write, health probe, IPC checks) iterates
// this list so a new provider only needs to be added here. Lives in this
// Electron-free module so the Bun sidecar can iterate the same list —
// ./secure-keys.ts re-exports it so existing `from './secure-keys'` imports
// keep working unchanged.
export const PROVIDER_IDS: ProviderId[] = [
  'openrouter',
  'anthropic',
  'openai',
  'gemini',
  'localai',
  'opencode',
];

// Electron-free workspace default. The Electron build resolves this from
// app.getPath('documents') (handles renamed/redirected Documents folders)
// and overwrites STORE_DEFAULTS.workspaceFolder at settings.ts module load;
// the sidecar keeps this fallback, which mirrors the Electron success path
// (<Documents>/Spirit) via os.homedir().
const fallbackWorkspaceFolder = (): string => join(homedir(), 'Documents', 'Spirit');

export const STORE_DEFAULTS: Schema = {
  storageVersion: STORAGE_VERSION,
  openrouterApiKey: '',
  primaryModel: MODELS.PRIMARY,
  fallbackModel: MODELS.FALLBACK,
  webSearch: false,
  workspaceFolder: fallbackWorkspaceFolder(),
  providers: DEFAULT_PROVIDERS,
  providersSecure: null,
  visionBridgeSecure: null,
  autoApproveTools: false,
  memorySaveEnabled: false,
  contextMemoryEnabled: false,
  maxContextTokens: 80000,
  autoContext: true,
  annotFinalPass: false,
  voiceLanguage: 'auto',
  sttEngine: 'auto',
  sttModel: '',
  sttInitialPrompt: '',
  sttWordOverrides: '',
  triggerHotkey: defaultTriggerHotkey(),
  userProfile: DEFAULT_USER_PROFILE,
  personalizePrompts: false,
  dismissOnDoubleClick: true,
  audioMode: false,
  themePreference: 'system',
  mouseWiggleEnabled: true,
  wiggleSensitivity: 'high',
  chipVisibility: 'both',
  chipsUseMainProvider: true,
  chipsSource: 'smart',
  customChips: [],
  chipsProvidersSecure: null,
  chipsLocalAiConfig: { apiKey: '', enabled: false },
  reducedTransparency: false,
  glassMode: 'glass',
  glassIntensity: 100,
  glassFade: 0,
  glassMaterial: 'under-window',
  glassScope: 'sidebar',
  screenshotCropW: 512,
  screenshotCropH: 384,
  annotOffsetX: 0,
  annotOffsetY: 0,
  calendarProvider: 'google',
  notificationsEnabled: true,
  clearMemoryOnQuit: false,
  ghostMode: true,
  hideTrayIcon: false,
  customShortcuts: {},
  enabledSkills: null,
  permissionRules: {},
};

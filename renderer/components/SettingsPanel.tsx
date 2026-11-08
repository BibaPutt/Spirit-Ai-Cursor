import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ipc } from '../lib/ipc';
import { applyGlassVars } from '../lib/glass';
import { cn } from '../lib/utils';
import { Switch } from './ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Slider } from './ui/slider';
import { Separator } from './ui/separator';
import { ScrollArea } from './ui/scroll-area';
import { MemoryPanel } from './MemoryPanel';

import type {
  ChipVisibility,
  ChipsSource,
  ProviderId,
  ProviderSettings,
  Settings,
  SkillInfo,
  STTEngine,
  TriggerHotkey,
} from '../../electron/types';

const STT_ENGINES: Array<{ value: STTEngine; label: string }> = [
  { value: 'auto', label: 'Auto (local first)' },
  { value: 'local', label: 'Local (offline)' },
  { value: 'cloud', label: 'Cloud (provider)' },
];

const CHIP_VISIBILITY: Array<{ value: ChipVisibility; label: string }> = [
  { value: 'both', label: 'Both' },
  { value: 'type', label: 'Typing only' },
  { value: 'voice', label: 'Voice only' },
  { value: 'off', label: 'Never' },
];

const TRIGGER_HOTKEYS: Array<{ value: TriggerHotkey; label: string }> = [
  { value: 'MetaRight', label: 'Right Cmd' },
  { value: 'CtrlRight', label: 'Right Ctrl' },
  { value: 'AltRight', label: 'Right Alt' },
  { value: 'ShiftRight', label: 'Right Shift' },
];

type ProviderMeta = {
  id: ProviderId;
  name: string;
  keyPlaceholder: string;
  getKey: string;
};

const PROVIDERS: ProviderMeta[] = [
  { id: 'openrouter', name: 'OpenRouter', keyPlaceholder: 'sk-or-v1-\u2026', getKey: 'openrouter.ai/keys' },
  { id: 'anthropic', name: 'Anthropic', keyPlaceholder: 'sk-ant-\u2026', getKey: 'console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', keyPlaceholder: 'sk-\u2026', getKey: 'platform.openai.com/api-keys' },
  { id: 'gemini', name: 'Google Gemini', keyPlaceholder: 'AIza\u2026', getKey: 'aistudio.google.com/apikey' },
  { id: 'localai', name: 'Local AI', keyPlaceholder: 'optional key', getKey: 'Any OpenAI-compatible server' },
  { id: 'opencode', name: 'Opencode', keyPlaceholder: 'no key needed', getKey: 'Opencode (localhost:4096)' },
];

type Props = {
  initial: Settings | null;
  onClose: () => void;
  onSaved: (s: Settings) => void;
  openTab?: 'memory' | null;
};

type TestState = { status: 'idle' } | { status: 'testing' } | { status: 'ok'; label?: string } | { status: 'err'; error: string };

// Settingsdirty-check fingerprint for a local/opencode provider: the edit-able
// fields that live on the card (model, capabilities, base URL). Keys are stored
// in the encrypted store and never counted here — typing a new secret is
// persisted by its own flow, not the Save-budget check.
function providerFingerprint(p: ProviderSettings | undefined): Record<string, unknown> {
  if (!p) return {};
  const { apiKey: _k, availableModels, hasKey: _h, ...rest } = p;
  return rest;
}

// opencode card auto-persist identity: everything the card edits, so a change
// writes through without the main Save button (same instant path as glass).
function opencodeSerial(p: ProviderSettings | undefined): string {
  if (!p) return '';
  return JSON.stringify({
    enabled: !!p.enabled,
    baseUrl: (p.baseUrl ?? '').trim(),
    model: p.model ?? '',
    vision: !!p.vision,
    tools: !!p.tools,
    web: !!p.web,
    models: (p.availableModels ?? []).map((m) => m.id),
  });
}

// Same guard for the localai card: everything it edits.
function localAiSerial(p: ProviderSettings | undefined): string {
  if (!p) return '';
  return JSON.stringify({
    enabled: !!p.enabled,
    baseUrl: (p.baseUrl ?? '').trim(),
    model: p.model ?? '',
    vision: !!p.vision,
    tools: !!p.tools,
    web: !!p.web,
    contextLength: p.contextLength ?? null,
    models: (p.availableModels ?? []).map((m) => m.id),
  });
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-white dark:text-neutral-900">{label}</div>
        <div className="text-[10.5px] text-white/50 dark:text-neutral-900/55">{hint}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 overflow-hidden py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-white dark:text-neutral-900">{label}</div>
        <div className="text-[10.5px] text-white/50 dark:text-neutral-900/55">{hint}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const INPUT_CLS = 'min-w-0 flex-1 rounded-md border px-2.5 py-1.5 font-mono text-[12px] outline-none transition border-white/14 bg-black/40 text-white placeholder:text-white/30 focus:border-[rgb(var(--spirit-accent-rgb))]/60 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900 dark:placeholder:text-neutral-900/35';
const BTN_CLS = 'shrink-0 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition border-white/14 bg-black/30 text-white/85 hover:text-white dark:border-neutral-900/18 dark:bg-neutral-900/4 dark:text-neutral-900/85 dark:hover:text-neutral-900';
const BTN_DISABLED_CLS = BTN_CLS + ' disabled:cursor-not-allowed disabled:opacity-40';

function TestResultLine({ state, testedKey, currentKey }: { state: TestState; testedKey: string; currentKey: string }) {
  if (state.status === 'idle') return null;
  if (state.status !== 'testing' && testedKey !== currentKey) return null;

  let icon = '';
  let body = '';
  let tone = '';
  if (state.status === 'testing') {
    icon = '\u00b7';
    body = 'Checking\u2026';
    tone = 'text-white/55 dark:text-neutral-900/55';
  } else if (state.status === 'ok') {
    icon = '\u2713';
    body = state.label && state.label !== 'connected' ? state.label : 'Connection valid';
    tone = 'text-[rgb(var(--spirit-accent-rgb))]';
  } else {
    icon = '\u2715';
    body = state.error;
    tone = 'text-red-300 dark:text-red-500';
  }

  return (
    <div className={cn('mt-2 flex items-center gap-1.5 text-[11px] font-medium', tone)}>
      <span className="font-bold">{icon}</span>
      <span className="truncate">{body}</span>
    </div>
  );
}

function ServerProviderCard({
  p,
  showKey,
  testState,
  onField,
  onDetect,
  onTest,
  onSelectModel,
  onToggleShowKey,
  bridge = false,
  bridgeHasKey = false,
  bridgeKeyDraft = '',
  onBridgeKeyChange,
}: {
  p: ProviderSettings;
  showKey: boolean;
  testState: TestState;
  onField: <K extends keyof ProviderSettings>(key: K, value: ProviderSettings[K]) => void;
  onDetect: () => void;
  onTest: () => void;
  onSelectModel: (id: string) => void;
  onToggleShowKey: () => void;
  bridge?: boolean;
  bridgeHasKey?: boolean;
  bridgeKeyDraft?: string;
  onBridgeKeyChange?: (value: string) => void;
}) {
  const models = p.availableModels ?? [];
  const testing = testState.status === 'testing';
  return (
    <div className="mt-3 space-y-2">
      {/* Grid, not flex: `minmax(0,1fr)` lets the input shrink while the two
          `auto` columns stay content-sized, so the row never grows past the
          card no matter how long the URL is. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
        <input
          type="text"
          value={p.baseUrl ?? ''}
          onChange={(e) => onField('baseUrl', e.target.value)}
          placeholder="http://localhost:1234/v1"
          spellCheck={false}
          className={INPUT_CLS}
        />
        <button type="button" onClick={onTest} disabled={testing || !(p.baseUrl ?? '').trim()} className={BTN_DISABLED_CLS} title="Probe the server">
          {testing ? 'Testing\u2026' : 'Test'}
        </button>
        <button type="button" onClick={onDetect} disabled={testing || !(p.baseUrl ?? '').trim()} className={BTN_DISABLED_CLS} title="Detect available models">
          Detect
        </button>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <input
          type={showKey ? 'text' : 'password'}
          value={p.apiKey}
          onChange={(e) => onField('apiKey', e.target.value)}
          placeholder="optional API key"
          spellCheck={false}
          className={INPUT_CLS}
        />
        <button type="button" onClick={onToggleShowKey} className={BTN_CLS}>
          {showKey ? 'hide' : 'show'}
        </button>
      </div>
      {/* Grid, not flex: `minmax(0,1fr)` tracks contribute 0 to min-content, so
          this row can never inflate the panel's intrinsic width. A <select>
          is atomic — its min-content is the width of its widest <option>, and
          long model ids would propagate up through the scroll wrapper and
          widen the 460px panel. `min-w-0` drops the items' automatic minimum
          so they fit their tracks instead. */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
        <select
          value={p.model ?? ''}
          onChange={(e) => onSelectModel(e.target.value)}
          disabled={models.length === 0}
          className={cn('min-w-0 w-full rounded-md border bg-black/40 px-2 py-1.5 text-[12px] outline-none transition disabled:cursor-not-allowed disabled:opacity-40 border-white/14 text-white focus:border-[rgb(var(--spirit-accent-rgb))]/60 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900')}
        >
          <option value="" disabled>{models.length === 0 ? 'No models detected' : 'Pick a model\u2026'}</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
        </select>
        <input
          type="text"
          value={p.model ?? ''}
          onChange={(e) => onField('model', e.target.value)}
          placeholder="or type a model name"
          spellCheck={false}
          className={INPUT_CLS}
        />
      </div>
      <div className="flex items-center gap-4 pt-0.5">
        {(['vision', 'tools', 'web'] as const).map((cap) => (
          <label key={cap} className="flex cursor-pointer select-none items-center gap-1.5">
            <Switch checked={p[cap] === true} onCheckedChange={(v) => onField(cap, v)} />
            <span className="text-[11px] font-medium capitalize text-white dark:text-neutral-900">{cap}</span>
          </label>
        ))}
      </div>
      {bridge && (
        <div className="mt-2 space-y-2 rounded-lg border border-dashed border-white/14 p-2 dark:border-neutral-900/20">
          <label className="flex cursor-pointer select-none items-center gap-1.5">
            <Switch
              checked={p.useVisionBridge === true}
              onCheckedChange={(v) => onField('useVisionBridge', v)}
            />
            <span className="text-[11px] font-medium text-white dark:text-neutral-900">
              Vision bridge<sup className="ml-1 text-[9px] text-white/50 dark:text-neutral-900/50">new</sup>
            </span>
            <span className="text-[10.5px] text-white/45 dark:text-neutral-900/45">
              lets text-only models "see" via a separate vision endpoint
            </span>
          </label>
          {p.useVisionBridge === true && (
            <>
              <input
                type="text"
                value={p.visionBridgeUrl ?? ''}
                onChange={(e) => onField('visionBridgeUrl', e.target.value)}
                placeholder="Vision endpoint, e.g. http://localhost:1234/v1 (or OpenAI-compatible cloud)"
                spellCheck={false}
                className={INPUT_CLS}
              />
              <div className="flex min-w-0 gap-2">
                <input
                  type="text"
                  value={p.visionBridgeModel ?? ''}
                  onChange={(e) => onField('visionBridgeModel', e.target.value)}
                  placeholder="Vision model id (e.g. gpt-4o-mini)"
                  spellCheck={false}
                  className={INPUT_CLS}
                />
              </div>
              <div className="flex min-w-0 gap-2">
                <input
                  type="password"
                  value={bridgeKeyDraft}
                  onChange={(e) => onBridgeKeyChange?.(e.target.value)}
                  placeholder={bridgeHasKey ? 'API key stored \u2014 leave blank to keep it' : 'Optional API key for the vision endpoint'}
                  spellCheck={false}
                  className={INPUT_CLS}
                />
                {bridgeHasKey && (
                  <button type="button" onClick={() => onBridgeKeyChange?.('__CLEAR__')} className={BTN_CLS} title="Remove the stored vision key">
                    remove key
                  </button>
                )}
              </div>
              <p className="text-[10px] leading-snug text-white/40 dark:text-neutral-900/40">
                Leave the URL and model empty to auto-pick from your first configured cloud provider
                (OpenRouter, OpenAI, or Gemini). A vision model is called per text-only query.
              </p>
            </>
          )}
        </div>
      )}
      {typeof p.contextLength === 'number' && p.contextLength > 0 && (
        <p className="text-[10.5px] text-white/50 dark:text-neutral-900/50">
          Context window: <span className="font-semibold text-white/80 dark:text-neutral-900/80">{p.contextLength.toLocaleString()}</span> tokens
        </p>
      )}
    </div>
  );
}

export function SettingsPanel({ initial, onClose, onSaved, openTab }: Props) {
  const { t } = useTranslation();
  const [showMemory, setShowMemory] = useState(openTab === 'memory');
  const [activeTab, setActiveTab] = useState('general');
  const panelRef = useRef<HTMLDivElement>(null);

  const [autostart, setAutostart] = useState({ openAtLogin: false, openAsHidden: false });
  const [showKeys, setShowKeys] = useState<Record<ProviderId, boolean>>({
    openrouter: false, anthropic: false, openai: false, gemini: false, localai: false, opencode: false,
  });
  const [replacingKey, setReplacingKey] = useState<Record<ProviderId, boolean>>({
    openrouter: false, anthropic: false, openai: false, gemini: false, localai: false, opencode: false,
  });
  const [providerKeys, setProviderKeys] = useState<Record<ProviderId, string>>({
    openrouter: '', anthropic: '', openai: '', gemini: '', localai: '', opencode: '',
  });
  const [providerEnabled, setProviderEnabled] = useState<Record<ProviderId, boolean>>({
    openrouter: false, anthropic: false, openai: false, gemini: false, localai: false, opencode: false,
  });
  const [testState, setTestState] = useState<Record<ProviderId, TestState>>({
    openrouter: { status: 'idle' }, anthropic: { status: 'idle' }, openai: { status: 'idle' }, gemini: { status: 'idle' }, localai: { status: 'idle' }, opencode: { status: 'idle' },
  });
  const [testedKey, setTestedKey] = useState<Record<ProviderId, string>>({
    openrouter: '', anthropic: '', openai: '', gemini: '', localai: '', opencode: '',
  });

  const [triggerHotkey, setTriggerHotkey] = useState<TriggerHotkey>('MetaRight');
  const [mouseWiggleEnabled, setMouseWiggleEnabled] = useState(true);
  // Wiggle sensitivity (high = original tuning, easily triggered).
  const [wiggleSensitivity, setWiggleSensitivity] = useState<'low' | 'normal' | 'high'>('high');
  const [chipVisibility, setChipVisibility] = useState<ChipVisibility>('both');
  const [chipsSource, setChipsSource] = useState<ChipsSource>('smart');
  const [customChips, setCustomChips] = useState<Array<{ label: string; prompt: string }>>([]);
  const [themePreference, setThemePreference] = useState<'system' | 'light' | 'dark'>('system');
  // Glass look (Appearance → Window). Instant-save with live preview —
  // same path as the old Reduced-transparency toggle: persist debounced,
  // paint CSS vars immediately so the slider feels live. Box-only, always
  // glass mode. Single Tint slider (Fade removed).
  const [glassIntensity, setGlassIntensity] = useState(100);
  const [sttEngine, setSttEngine] = useState<STTEngine>('auto');
  const [voiceLanguage, setVoiceLanguage] = useState('auto');
  const [sttInitialPrompt, setSttInitialPrompt] = useState('');
  const [sttWordOverrides, setSttWordOverrides] = useState('');
  // Speech-model manager (Settings → Voice list): download state, spec
  // recommendation, 1-click download/delete/switch. The active model itself
  // lives main-side (persisted by the switch IPC) — no serial involvement.
  type SttModelRow = { id: string; sizeMB: number; note: string; downloaded: boolean; partial: boolean; diskMB: number; active: boolean; recommended: boolean };
  const [sttModels, setSttModels] = useState<SttModelRow[] | null>(null);
  const [sttRec, setSttRec] = useState('');
  const [sttBusy, setSttBusy] = useState<string | null>(null);
  const [sttProg, setSttProg] = useState<number | null>(null);
  const [sttErr, setSttErr] = useState<string | null>(null);
  const [sttModelsOpen, setSttModelsOpen] = useState(true);
  const refreshSttModels = useCallback(async () => {
    try {
      const r = await window.spirit.getSttModels();
      setSttModels(r.models);
      setSttRec(r.recommendation);
    } catch {
      /* cache scan failed — list stays empty, core settings still save */
    }
  }, []);
  useEffect(() => { void refreshSttModels(); }, [refreshSttModels]);
  const useSttModel = useCallback(async (m: SttModelRow) => {
    setSttBusy(m.id);
    setSttProg(m.downloaded ? null : 0);
    setSttErr(null);
    let poll: number | null = null;
    try {
      if (!m.downloaded) {
        // Missing weights download on sidecar load — mirror the download %
        // with the existing SttStatus progress plumbing, and surface a
        // retried-then-failed download as an error with retry.
        poll = window.setInterval(() => {
          window.spirit.getSttStatus().then((s) => {
            if (typeof s.progress === 'number') setSttProg(s.progress);
            if (typeof s.downloadError === 'string' && s.downloadError) setSttErr(s.downloadError);
          }).catch(() => {});
        }, 600);
      }
      const r = await window.spirit.switchSttModel(m.id);
      if (!r.ok) setSttErr(`Could not switch to ${m.id} — tap ${m.downloaded ? 'Use' : 'Download'} to retry.`);
      await refreshSttModels();
    } finally {
      if (poll !== null) window.clearInterval(poll);
      setSttBusy(null);
      setSttProg(null);
    }
  }, [refreshSttModels]);
  const delSttModel = useCallback(async (id: string) => {
    setSttBusy(id);
    try {
      await window.spirit.deleteSttModel(id);
      await refreshSttModels();
    } finally {
      setSttBusy(null);
    }
  }, [refreshSttModels]);
  const [ttsRate, setTtsRate] = useState(1.02);
  const [autoApproveTools, setAutoApproveTools] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [clearMemoryOnQuit, setClearMemoryOnQuit] = useState(false);
  const [ghostMode, setGhostMode] = useState(true);
  const [hideTrayIcon, setHideTrayIcon] = useState(false);
  const [memorySaveEnabled, setMemorySaveEnabled] = useState(false);
  const [contextMemoryEnabled, setContextMemoryEnabled] = useState(false);
  const [maxContextTokens, setMaxContextTokens] = useState(80000);
  const [autoContext, setAutoContext] = useState(true);
  const [annotFinalPass, setAnnotFinalPass] = useState(false);
  const [annotOffsetX, setAnnotOffsetX] = useState(0);
  const [annotOffsetY, setAnnotOffsetY] = useState(0);
  const [audioMode, setAudioMode] = useState(false);
  const [dismissOnDoubleClick, setDismissOnDoubleClick] = useState(true);
  const [webSearch, setWebSearch] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [userProfile, setUserProfile] = useState({ name: '', role: '', preferredLanguage: '', translateLanguage: '' });
  const [personalizePrompts, setPersonalizePrompts] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);

  const testNonceRef = useRef<Record<string, number>>({});
  const nextNonce = (id: ProviderId): number => {
    testNonceRef.current[id] = (testNonceRef.current[id] ?? 0) + 1;
    return testNonceRef.current[id];
  };

  const savedSerial = useRef('');
  // Reloads (our own write-backs, other cards saving) must never clobber
  // unsaved local edits: the main + localai reload effects below apply a
  // fresh `initial` ONLY on first sync or when everything is saved. Without
  // this, typing in one card while another auto-saved reset the field
  // mid-keystroke ("settings revert to old data").
  const initialSynced = useRef(false);
  const currentSerialRef = useRef('');
  const localAiSavedSerial = useRef('');

  useEffect(() => {
    if (!initial) return;
    if (initialSynced.current && currentSerialRef.current !== savedSerial.current) return;
    setTriggerHotkey(initial.triggerHotkey);
    setMouseWiggleEnabled(initial.mouseWiggleEnabled);
    setWiggleSensitivity(
      initial.wiggleSensitivity === 'low' || initial.wiggleSensitivity === 'normal'
        ? initial.wiggleSensitivity
        : 'high',
    );
    setChipVisibility(initial.chipVisibility);
    setChipsSource(initial.chipsSource === 'premade' || initial.chipsSource === 'custom' ? initial.chipsSource : 'smart');
    setCustomChips(Array.isArray(initial.customChips) ? initial.customChips.map((c) => ({ label: c.label ?? '', prompt: c.prompt ?? '' })) : []);
    setThemePreference(initial.themePreference);
    setGlassIntensity(typeof initial.glassIntensity === 'number' ? initial.glassIntensity : 100);
    setSttEngine(initial.sttEngine);
    setVoiceLanguage(initial.voiceLanguage);
    setSttInitialPrompt(initial.sttInitialPrompt ?? '');
    setSttWordOverrides(initial.sttWordOverrides ?? '');
    setAutoApproveTools(initial.autoApproveTools);
    setNotificationsEnabled(initial.notificationsEnabled);
    setClearMemoryOnQuit(initial.clearMemoryOnQuit);
    setGhostMode(initial.ghostMode !== false);
    setHideTrayIcon(initial.hideTrayIcon === true);
    setMemorySaveEnabled(initial.memorySaveEnabled);
    setContextMemoryEnabled(initial.contextMemoryEnabled);
    setMaxContextTokens(initial.maxContextTokens);
    setAutoContext(initial.autoContext !== false);
    setAnnotFinalPass(initial.annotFinalPass === true);
    setAnnotOffsetX(initial.annotOffsetX ?? 0);
    setAnnotOffsetY(initial.annotOffsetY ?? 0);
    setAudioMode(initial.audioMode);
    setDismissOnDoubleClick(initial.dismissOnDoubleClick);
    setWebSearch(initial.webSearch);
    setWorkspace(initial.workspaceFolder);
    setUserProfile(initial.userProfile);
    setPersonalizePrompts(initial.personalizePrompts);
    const pe: Record<ProviderId, boolean> = { openrouter: false, anthropic: false, openai: false, gemini: false, localai: false, opencode: false };
    for (const id of Object.keys(initial.providers) as ProviderId[]) pe[id] = initial.providers[id].enabled;
    setProviderEnabled(pe);
    initialSynced.current = true;
    savedSerial.current = JSON.stringify({
      triggerHotkey, mouseWiggleEnabled, wiggleSensitivity, chipVisibility, chipsSource, customChips, themePreference,
      sttEngine, voiceLanguage, sttInitialPrompt, sttWordOverrides, autoApproveTools, notificationsEnabled,
      clearMemoryOnQuit, ghostMode, hideTrayIcon,
      memorySaveEnabled, contextMemoryEnabled, maxContextTokens, autoContext, annotFinalPass,
      audioMode, dismissOnDoubleClick, webSearch, workspace, userProfile, personalizePrompts,
      providerEnabled,
      providersLocalAi: providerFingerprint(initial.providers.localai),
      providersOpencode: providerFingerprint(initial.providers.opencode),
    });
    window.spirit.autostartGet().then(setAutostart);
  }, [initial]);

  // Skills catalog: loaded on mount, toggled instantly via dedicated IPC (no
  // Save-budget involvement — each flip persists and re-syncs the list).
  useEffect(() => {
    let mounted = true;
    window.spirit
      .listSkills()
      .then((list) => {
        if (mounted) setSkills(list);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const setSkillOn = useCallback(async (id: string, enabled: boolean) => {
    try {
      const list = await window.spirit.setSkillEnabled(id, enabled);
      setSkills(list);
    } catch {
      /* revert is implicit — list not updated on failure */
    }
  }, []);

  const [providersLocalAi, setProvidersLocalAi] = useState<ProviderSettings>(() => initial?.providers.localai ?? { apiKey: '', enabled: true });

  // Vision bridge key draft (never round-trips through settings:set — written
  // via the dedicated setVisionBridge IPC on save so the generic providers
  // patch can't touch ciphertext). `bridgeKeyCleared` marks an explicit
  // "remove the stored key" request.
  const [bridgeHasKey, setBridgeHasKey] = useState(false);
  const [bridgeKeyDraft, setBridgeKeyDraft] = useState('');
  const [bridgeKeyCleared, setBridgeKeyCleared] = useState(false);

  // Load whether the bridge currently has a stored API key (no decryption).
  useEffect(() => {
    let mounted = true;
    window.spirit
      .getVisionBridge()
      .then((b) => {
        if (!mounted) return;
        setBridgeHasKey(b.hasKey);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const [providersOpencode, setProvidersOpencode] = useState<ProviderSettings>(() => initial?.providers.opencode ?? { apiKey: '', enabled: false, baseUrl: 'http://127.0.0.1:4096' });

  const currentSerial = useMemo(
    () => JSON.stringify({
      triggerHotkey, mouseWiggleEnabled, wiggleSensitivity, chipVisibility, chipsSource, customChips, themePreference,
      sttEngine, voiceLanguage, sttInitialPrompt, sttWordOverrides, autoApproveTools, notificationsEnabled,
      clearMemoryOnQuit, ghostMode, hideTrayIcon,
      memorySaveEnabled, contextMemoryEnabled, maxContextTokens, autoContext, annotFinalPass,
      audioMode, dismissOnDoubleClick, webSearch, workspace, userProfile, personalizePrompts,
      providerEnabled,
      providersLocalAi: providerFingerprint(providersLocalAi),
      providersOpencode: providerFingerprint(providersOpencode),
    }),
    [triggerHotkey, mouseWiggleEnabled, wiggleSensitivity, chipVisibility, chipsSource, customChips, themePreference,
      sttEngine, voiceLanguage, sttInitialPrompt, sttWordOverrides, autoApproveTools, notificationsEnabled,
      clearMemoryOnQuit, ghostMode, hideTrayIcon, memorySaveEnabled, contextMemoryEnabled, maxContextTokens, autoContext, annotFinalPass,
      audioMode, dismissOnDoubleClick, webSearch, workspace, userProfile, personalizePrompts,
      providerEnabled, providersLocalAi, providersOpencode],
  );
  // Mirror for the reload guards (effects close over stale values otherwise).
  currentSerialRef.current = currentSerial;

  // Force re-render after save so the auto-save effect sees the fresh serial.
  const [, setSaveTick] = useState(0);

  const runTest = useCallback(async (id: ProviderId, keyOverride?: string) => {
    let key = keyOverride ?? '';
    if (!key) {
      const s = initial?.providers[id];
      if (s?.hasKey) {
        try { key = (await window.spirit.revealProviderKey(id)).trim(); } catch { /* empty */ }
      }
    }
    if (!key) {
      setTestState((prev) => ({ ...prev, [id]: { status: 'err', error: 'Empty key' } }));
      return;
    }
    const nonce = nextNonce(id);
    setTestState((prev) => ({ ...prev, [id]: { status: 'testing' } }));
    setTestedKey((prev) => ({ ...prev, [id]: key }));
    try {
      const res = await window.spirit.testProviderKey(id, key);
      if (nonce !== testNonceRef.current[id]) return;
      setTestState((prev) => ({ ...prev, [id]: res.ok ? { status: 'ok', label: res.label } : { status: 'err', error: res.error } }));
    } catch (err) {
      if (nonce !== testNonceRef.current[id]) return;
      setTestState((prev) => ({ ...prev, [id]: { status: 'err', error: err instanceof Error ? err.message : 'Test failed' } }));
    }
  }, [initial]);

  const runLocalAiDetect = useCallback(async () => {
    const p = initial?.providers.localai;
    const baseUrl = (p?.baseUrl ?? '').trim();
    if (!baseUrl) {
      setTestState((prev) => ({ ...prev, localai: { status: 'err', error: 'Enter a server address first.' } }));
      return;
    }
    let key = (p?.apiKey ?? '').trim();
    if (!key && p?.hasKey) {
      try { key = (await window.spirit.revealProviderKey('localai')).trim(); } catch { /* empty */ }
    }
    const nonce = nextNonce('localai');
    setTestState((prev) => ({ ...prev, localai: { status: 'testing' } }));
    setTestedKey((prev) => ({ ...prev, localai: baseUrl }));
    try {
      const res = await window.spirit.detectLocalModels(baseUrl, key);
      if (nonce !== testNonceRef.current['localai']) return;
      if (res.ok) {
        const n = res.models.length;
        setTestState((prev) => ({ ...prev, localai: { status: 'ok', label: n === 0 ? 'Server reachable, no models' : `${n} model${n === 1 ? '' : 's'} found` } }));
        setProvidersLocalAi((prev) => {
          const next = { ...prev, availableModels: res.models };
          if (typeof res.contextLength === 'number') next.contextLength = res.contextLength;
          const cur = (prev.model ?? '').trim();
          const found = cur && res.models.some((m) => m.id === cur);
          // Auto-pick when: field is empty, or saved model is no longer on
          // the server (endpoint changed, model unloaded, renamed).
          if ((!cur || !found) && res.models.length > 0) {
            const first = res.models[0];
            next.model = first.id;
            // Default to text-only (false) for unknown models: extra OCR text
            // is harmless but a rejected image kills the round.
            next.vision = first.vision ?? false;
            next.tools = first.tools ?? false;
            next.web = first.web ?? false;
          } else if (found) {
            // Model still on the server — sync toggles from its metadata.
            const info = res.models.find((m) => m.id === cur);
            if (info) {
              next.vision = info.vision ?? prev.vision;
              next.tools = info.tools ?? prev.tools;
              next.web = info.web ?? prev.web;
            }
          }
          return next;
        });
      } else {
        setTestState((prev) => ({ ...prev, localai: { status: 'err', error: res.error } }));
      }
    } catch (err) {
      if (nonce !== testNonceRef.current['localai']) return;
      setTestState((prev) => ({ ...prev, localai: { status: 'err', error: err instanceof Error ? err.message : 'Could not reach server' } }));
    }
  }, [initial]);

  const runLocalAiTest = useCallback(async () => {
    const p = initial?.providers.localai;
    const baseUrl = (p?.baseUrl ?? '').trim();
    if (!baseUrl) {
      setTestState((prev) => ({ ...prev, localai: { status: 'err', error: 'Enter a server address first.' } }));
      return;
    }
    let key = (p?.apiKey ?? '').trim();
    if (!key && p?.hasKey) {
      try { key = (await window.spirit.revealProviderKey('localai')).trim(); } catch { /* empty */ }
    }
    const nonce = nextNonce('localai');
    setTestState((prev) => ({ ...prev, localai: { status: 'testing' } }));
    setTestedKey((prev) => ({ ...prev, localai: baseUrl }));
    try {
      const res = await window.spirit.testLocalAi(baseUrl, key);
      if (nonce !== testNonceRef.current['localai']) return;
      if (res.ok) {
        setTestState((prev) => ({ ...prev, localai: { status: 'ok', label: res.label } }));
        if (typeof res.contextLength === 'number') {
          setProvidersLocalAi((prev) => ({ ...prev, contextLength: res.contextLength }));
        }
      } else {
        setTestState((prev) => ({ ...prev, localai: { status: 'err', error: res.error } }));
      }
    } catch (err) {
      if (nonce !== testNonceRef.current['localai']) return;
      setTestState((prev) => ({ ...prev, localai: { status: 'err', error: err instanceof Error ? err.message : 'Could not reach server' } }));
    }
  }, [initial]);

  useEffect(() => {
    if (!initial) return;
    const incoming = localAiSerial(initial.providers.localai);
    if (!initialSynced.current) {
      setProvidersLocalAi(initial.providers.localai);
      localAiSavedSerial.current = incoming;
      return;
    }
    // Unsaved card edits: a reload (e.g. another card's write-back) must
    // not wipe what the user just picked.
    if (localAiSerial(providersLocalAi) !== localAiSavedSerial.current) return;
    setProvidersLocalAi(initial.providers.localai);
    localAiSavedSerial.current = incoming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  // Last opencode state confirmed written (or freshly loaded) — the persist
  // effect below skips while the serial matches, so Settings reloads and our
  // own write-backs never loop.
  const opencodeSavedSerial = useRef('');
  const opencodePersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest card state, mirrored every render so the unmount flush below never
  // writes a stale snapshot.
  const opencodeLatest = useRef<ProviderSettings | undefined>(undefined);
  opencodeLatest.current = providersOpencode;
  // NOTHING may write before the first sync from `initial` — otherwise a
  // mount with default (empty) state wipes the user's stored config. This
  // also makes StrictMode double-mounts (dev) harmless.
  const opencodeSynced = useRef(false);

  // Monotonic id per opencode write: responses arriving out of order are
  // ignored unless they belong to the latest write — a stale answer can
  // never reset the card.
  const opencodeWriteId = useRef(0);

  const flushOpencode = useCallback(() => {
    if (!opencodeSynced.current) return;
    const cur = opencodeLatest.current;
    if (!cur) return;
    const serial = opencodeSerial(cur);
    if (serial === opencodeSavedSerial.current) return;
    opencodeSavedSerial.current = serial;
    if (opencodePersistTimer.current) clearTimeout(opencodePersistTimer.current);
    const writeId = ++opencodeWriteId.current;
    // Partial providers map: setSettings only touches the opencode entry.
    const providers = { opencode: cur } as Record<ProviderId, ProviderSettings>;
    void ipc
      .setSettings({ providers })
      .then((s) => {
        // Skip stale responses: a newer write (or the main Save button)
        // already owns the UI — never let an older answer reset it.
        if (writeId !== opencodeWriteId.current) return;
        if (opencodeSerial(opencodeLatest.current) !== serial) return;
        onSaved(s);
      })
      .catch(() => undefined);
  }, [onSaved]);

  // Flush a pending write when the panel closes — toggling then instantly
  // closing Settings can never lose the change.
  useEffect(() => {
    return () => {
      if (opencodePersistTimer.current) clearTimeout(opencodePersistTimer.current);
      flushOpencode();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initial) return;
    if (!opencodeSynced.current) {
      setProvidersOpencode(initial.providers.opencode);
      opencodeSavedSerial.current = opencodeSerial(initial.providers.opencode);
      opencodeSynced.current = true;
      return;
    }
    // Reloads (our own write-backs, other controls saving): apply the fresh
    // snapshot ONLY when we hold no unsaved edits — otherwise the reload
    // would clobber what the user just picked.
    if (opencodeSerial(providersOpencode) !== opencodeSavedSerial.current) return;
    setProvidersOpencode(initial.providers.opencode);
    opencodeSavedSerial.current = opencodeSerial(initial.providers.opencode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  // opencode card auto-persist: model pick, toggles, enable, base URL and the
  // detected list write through debounced — one quiet write per burst of
  // clicks (no overlapping responses racing each other), plus the unmount
  // flush above. Closing Settings without the main Save button loses nothing.
  useEffect(() => {
    if (!initial) return;
    const serial = opencodeSerial(providersOpencode);
    if (serial === opencodeSavedSerial.current) return;
    if (opencodePersistTimer.current) clearTimeout(opencodePersistTimer.current);
    opencodePersistTimer.current = setTimeout(() => {
      flushOpencode();
    }, 400);
    return () => {
      if (opencodePersistTimer.current) clearTimeout(opencodePersistTimer.current);
    };
  }, [providersOpencode, initial, flushOpencode]);

  const selectLocalAiModel = useCallback((id: string) => {
    setProvidersLocalAi((prev) => {
      const info = prev.availableModels?.find((m) => m.id === id);
      return {
        ...prev,
        model: id,
        // Unknown models default to text-only (false): a rejected image
        // breaks the round; extra OCR text is harmless.
        ...(info ? { vision: info.vision ?? false, tools: info.tools ?? false, web: info.web ?? false } : {}),
      };
    });
  }, []);

  // opencode card: Test pings the server (/global/health) — a pure connection
  // check. Detect probes /config/providers for live models and refreshes the
  // dropdown. Both write their outcome to the shared opencode TestResultLine.
  const runOpencodeTest = useCallback(async () => {
      const baseUrl = (providersOpencode.baseUrl ?? '').trim();
      if (!baseUrl) {
        setTestState((prev) => ({ ...prev, opencode: { status: 'err', error: 'Enter a server address first.' } }));
        return;
      }
      const nonce = nextNonce('opencode');
      setTestState((prev) => ({ ...prev, opencode: { status: 'testing' } }));
      setTestedKey((prev) => ({ ...prev, opencode: baseUrl }));
      try {
        const res = await window.spirit.testOpencode(baseUrl);
        if (nonce !== testNonceRef.current.opencode) return;
        setTestState((prev) => ({
          ...prev,
          opencode: res.ok ? { status: 'ok', label: res.label ?? 'Connected' } : { status: 'err', error: res.error },
        }));
      } catch (err) {
        if (nonce !== testNonceRef.current.opencode) return;
        setTestState((prev) => ({ ...prev, opencode: { status: 'err', error: err instanceof Error ? err.message : 'Could not reach server' } }));
      }
    }, [providersOpencode]);

  const runOpencodeDetect = useCallback(async () => {
      const baseUrl = (providersOpencode.baseUrl ?? '').trim();
      if (!baseUrl) {
        setTestState((prev) => ({ ...prev, opencode: { status: 'err', error: 'Enter a server address first.' } }));
        return;
      }
      const nonce = nextNonce('opencode');
      setTestState((prev) => ({ ...prev, opencode: { status: 'testing' } }));
      setTestedKey((prev) => ({ ...prev, opencode: baseUrl }));
      try {
        const res = await window.spirit.detectOpencodeModels(baseUrl);
        if (nonce !== testNonceRef.current.opencode) return;
        if (res.ok) {
          const n = res.models.length;
          setTestState((prev) => ({ ...prev, opencode: { status: 'ok', label: n === 0 ? 'Server reachable, no models' : `${n} model${n === 1 ? '' : 's'} found` } }));
          setProvidersOpencode((prev) => {
            const next = { ...prev, availableModels: res.models };
            const cur = (prev.model ?? '').trim();
            const found = cur && res.models.some((m) => m.id === cur);
            if ((!cur || !found) && res.models.length > 0) {
              // No valid pick yet: take the first model, but do NOT touch the
              // user's toggles — the proxy list carries no capability flags,
              // so `?? false` here used to silently switch vision/tools/web
              // OFF on every refresh.
              next.model = res.models[0].id;
            }
            return next;
          });
        } else {
          setTestState((prev) => ({ ...prev, opencode: { status: 'err', error: res.error } }));
        }
      } catch (err) {
        if (nonce !== testNonceRef.current.opencode) return;
        setTestState((prev) => ({ ...prev, opencode: { status: 'err', error: err instanceof Error ? err.message : 'Could not reach server' } }));
      }
    }, [providersOpencode]);

  const selectOpencodeModel = useCallback((mid: string) => {
    setProvidersOpencode((prev) => {
      const info = prev.availableModels?.find((m) => m.id === mid);
      // Mirror only fields the detect result carries; ids-only today, so
      // stored toggles survive. Future metadata starts applying for free.
      return {
        ...prev,
        model: mid,
        ...(info?.vision !== undefined ? { vision: info.vision } : {}),
        ...(info?.tools !== undefined ? { tools: info.tools } : {}),
        ...(info?.web !== undefined ? { web: info.web } : {}),
      };
    });
  }, []);

  // Glass look: paint instantly for a live slider feel, persist debounced
  // (bypasses the Save budget like the old transparency toggle did).
  // Always glass mode, fade fixed at 0, box-only.
  const pushGlass = useCallback(
    (next: { intensity: number }) => {
      setGlassIntensity(next.intensity);
      // Paint only — the write happens on release (onValueCommit), so a
      // single drag previews live but persists exactly once. No timers.
      applyGlassVars(document.documentElement, 'glass', next.intensity, 0);
    },
    [],
  );

  // Glass persist: slider release event. Writes the live state once per
  // gesture instead of per tick.
  const commitGlass = useCallback(() => {
    void ipc
      .setSettings({
        glassMode: 'glass',
        glassIntensity,
        glassFade: 0,
      })
      .then((s) => onSaved(s))
      .catch(() => undefined);
  }, [glassIntensity, onSaved]);

  // No Save button: every change writes straight through (see the auto-save
  // effect below). A save already in flight blocks overlap — a trailing save
  // runs after it if state kept changing meanwhile. Serial + write-id guards
  // (opencode) keep stale answers from resetting the UI.
  const saveInFlight = useRef(false);
  const saveQueued = useRef(false);

  const saveNow = useCallback(async () => {
    if (saveInFlight.current) {
      saveQueued.current = true;
      return;
    }
    saveInFlight.current = true;
    try {
      // The main save carries the current opencode card state too: retire any
      // in-flight auto-persist so its older answer can't reset the UI, and
      // mark the card clean (this save owns it now).
      if (opencodePersistTimer.current) clearTimeout(opencodePersistTimer.current);
      opencodeWriteId.current++;
      opencodeSavedSerial.current = opencodeSerial(providersOpencode);
    const providersPatch: Record<ProviderId, ProviderSettings> = {
      ...initial!.providers,
      localai: providersLocalAi,
      opencode: providersOpencode,
    };
    for (const id of Object.keys(providerEnabled) as ProviderId[]) {
      if (id === 'localai' || id === 'opencode') continue;
      const existing = providersPatch[id] ?? { apiKey: '', enabled: true };
      providersPatch[id] = { ...existing, enabled: providerEnabled[id] };
    }
    for (const id of Object.keys(providerKeys) as ProviderId[]) {
      if (providerKeys[id] && id !== 'localai') {
        providersPatch[id] = { ...providersPatch[id], apiKey: providerKeys[id], enabled: true };
      }
    }
    const patch: Partial<Settings> = {
      triggerHotkey,
      mouseWiggleEnabled,
      wiggleSensitivity,
      chipVisibility,
      chipsSource,
      customChips: customChips.filter((c) => c.label.trim() && c.prompt.trim()).slice(0, 6),
      themePreference,
      sttEngine,
      voiceLanguage,
      sttInitialPrompt,
      sttWordOverrides,
      autoApproveTools,
      notificationsEnabled,
      clearMemoryOnQuit,
      ghostMode,
      hideTrayIcon,
      memorySaveEnabled,
      contextMemoryEnabled,
      maxContextTokens,
      autoContext,
      annotFinalPass,
      audioMode,
      dismissOnDoubleClick,
      webSearch,
      workspaceFolder: workspace,
      userProfile,
      personalizePrompts,
      providers: providersPatch,
    };
    // Save log — printed on every settings save so it's obvious what the
    // renderer actually persisted (esp. for the local-server providers whose
    // base URL / model / enabled live split across the plain + encrypted maps).
    console.log(
      '[settings:save] opencode=', JSON.stringify({
        enabled: providersOpencode.enabled,
        baseUrl: providersOpencode.baseUrl,
        model: providersOpencode.model,
        vision: providersOpencode.vision,
        web: providersOpencode.web,
      }),
      ' localai=', JSON.stringify({
        enabled: providersLocalAi.enabled,
        baseUrl: providersLocalAi.baseUrl,
        model: providersLocalAi.model,
      }),
      ' others=', Object.keys(providerEnabled).filter((k) => providerEnabled[k as ProviderId]).join(','),
    );
    const result = await ipc.setSettings(patch);
    // Persist the vision-bridge state and its key via the dedicated IPC so a
    // generic settings save never touches the encrypted bridge key slot.
    try {
      await window.spirit.setVisionBridge({
        useBridge: providersLocalAi.useVisionBridge === true,
        url: providersLocalAi.visionBridgeUrl ?? '',
        model: providersLocalAi.visionBridgeModel ?? '',
        key: bridgeKeyDraft || undefined,
        clearKey: bridgeKeyCleared || undefined,
      });
    } catch { /* non-fatal — the plain settings still saved */ }
    savedSerial.current = currentSerial;
    localAiSavedSerial.current = localAiSerial(providersLocalAi);
    onSaved(result);
    setSaveTick((t) => t + 1);
    } finally {
      saveInFlight.current = false;
    }
    // A change landed while saving: run one trailing save so nothing is lost.
    if (saveQueued.current) {
      saveQueued.current = false;
      void saveNow();
    }
  }, [
    providersOpencode, providersLocalAi, providerEnabled, providerKeys,
    triggerHotkey, mouseWiggleEnabled, wiggleSensitivity, chipVisibility, chipsSource, customChips, themePreference,
    sttEngine, voiceLanguage, autoApproveTools, notificationsEnabled,
    clearMemoryOnQuit, ghostMode, hideTrayIcon, memorySaveEnabled, contextMemoryEnabled, maxContextTokens, autoContext, annotFinalPass,
    audioMode, dismissOnDoubleClick, webSearch, workspace, userProfile,
    personalizePrompts, bridgeKeyDraft, bridgeKeyCleared, currentSerial, onSaved, initial,
  ]);

  // Auto-save: any change writes straight through — no Save button, no
  // timers. The serial guard skips reload echoes; the in-flight guard in
  // saveNow serializes overlap.
  useEffect(() => {
    if (!initial) return;
    if (currentSerial === savedSerial.current) return;
    void saveNow();
  });

  const handleAutostartToggle = async (checked: boolean) => {
    const result = await window.spirit.autostartSet({ openAtLogin: checked, openAsHidden: false });
    setAutostart(result);
  };

  const pickWorkspace = async () => {
    const picked = await window.spirit.pickWorkspaceFolder();
    if (picked) setWorkspace(picked);
  };

  if (!initial) return null;

  return (
    <AnimatePresence>
      <motion.div
        ref={panelRef}
        key="settings-panel"
        initial={{ opacity: 0, y: 20, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.96 }}
        transition={{ type: 'spring', damping: 28, stiffness: 380, mass: 0.8 }}
        className={cn(
          'fixed bottom-4 right-4 z-[9999] pointer-events-auto flex flex-col overflow-hidden rounded-2xl border shadow-glass',
          'w-[460px] h-[560px] max-h-[80vh]',
          'border-white/10 bg-neutral-800',
          'dark:border-neutral-900/15 dark:bg-neutral-100',
        )}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        {/* Content */}
        {showMemory ? (
          <MemoryPanel onBack={() => setShowMemory(false)} />
        ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 min-h-0 flex-col">
            <div className="px-3 pt-2">
              <TabsList className="w-full">
                <TabsTrigger value="general" className="flex-1">{t('tabs.general')}</TabsTrigger>
                <TabsTrigger value="ai" className="flex-1">{t('tabs.ai')}</TabsTrigger>
                <TabsTrigger value="voice" className="flex-1">{t('tabs.voice')}</TabsTrigger>
                <TabsTrigger value="appearance" className="flex-1">{t('tabs.appearance')}</TabsTrigger>
                <TabsTrigger value="actions" className="flex-1">{t('tabs.actions')}</TabsTrigger>
              </TabsList>
            </div>

            <ScrollArea className="flex-1 min-h-0 overflow-x-hidden">
              {/* General Tab */}
              <TabsContent value="general" className="w-full space-y-1 px-4 pb-4 overflow-hidden">
                <SettingRow label={t('general.hotkey')} hint={t('general.hotkeyHint')}>
                  <Select value={triggerHotkey} onValueChange={(v) => setTriggerHotkey(v as TriggerHotkey)}>
                    <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TRIGGER_HOTKEYS.map((h) => <SelectItem key={h.value} value={h.value}>{h.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </SettingRow>

                <ToggleRow label={t('general.shake')} hint={t('general.shakeHint')} checked={mouseWiggleEnabled} onChange={setMouseWiggleEnabled} />
                {mouseWiggleEnabled && (
                  <div className="flex items-center gap-1 rounded-full bg-white/8 p-0.5 dark:bg-neutral-900/8">
                    {(['low', 'normal', 'high'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setWiggleSensitivity(v)}
                        className={cn(
                          'flex-1 rounded-full px-2 py-1 text-[11px] font-medium capitalize transition',
                          wiggleSensitivity === v
                            ? 'bg-white/20 text-white dark:bg-neutral-900/20 dark:text-neutral-900'
                            : 'text-white/55 hover:text-white dark:text-neutral-900/55 dark:hover:text-neutral-900',
                        )}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                )}
                <SettingRow label={t('general.suggestChips')} hint={t('general.suggestChipsHint')}>
                  <Select value={chipVisibility} onValueChange={(v) => setChipVisibility(v as ChipVisibility)}>
                    <SelectTrigger className="w-[150px] shrink-0"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CHIP_VISIBILITY.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow label="Chips source" hint="Smart: AI-made. Premade: built-in set, no call. Custom: your list below.">
                  <Select value={chipsSource} onValueChange={(v) => setChipsSource(v as ChipsSource)}>
                    <SelectTrigger className="w-[150px] shrink-0"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="smart">Smart</SelectItem>
                      <SelectItem value="premade">Premade</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingRow>
                {chipsSource === 'custom' && (
                  <div className="space-y-2 py-1">
                    {customChips.map((c, i) => (
                      <div key={i} className="flex min-w-0 items-center gap-1.5">
                        <input
                          value={c.label}
                          placeholder="Label"
                          maxLength={45}
                          onChange={(e) => setCustomChips((prev) => prev.map((p, j) => j === i ? { ...p, label: e.target.value } : p))}
                          className="w-24 shrink-0 rounded-md border border-white/14 bg-black/40 px-2 py-1 text-[12px] text-white outline-none focus:border-[rgb(var(--spirit-accent-rgb))]/60 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900"
                        />
                        <input
                          value={c.prompt}
                          placeholder="What this chip tells the AI"
                          maxLength={400}
                          onChange={(e) => setCustomChips((prev) => prev.map((p, j) => j === i ? { ...p, prompt: e.target.value } : p))}
                          className="min-w-0 flex-1 rounded-md border border-white/14 bg-black/40 px-2 py-1 text-[12px] text-white outline-none focus:border-[rgb(var(--spirit-accent-rgb))]/60 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900"
                        />
                        <button type="button" onClick={() => setCustomChips((prev) => prev.filter((_, j) => j !== i))} className={BTN_CLS}>X</button>
                      </div>
                    ))}
                    {customChips.length < 6 && (
                      <button type="button" onClick={() => setCustomChips((prev) => [...prev, { label: '', prompt: '' }])} className={BTN_CLS}>Add chip</button>
                    )}
                  </div>
                )}

                <Separator className="my-2" />

                <ToggleRow label={t('general.launchAtLogin')} hint={t('general.launchAtLoginHint')} checked={autostart.openAtLogin} onChange={handleAutostartToggle} />
                <ToggleRow label={t('general.notifications')} hint={t('general.notificationsHint')} checked={notificationsEnabled} onChange={setNotificationsEnabled} />
                <ToggleRow label={t('general.clearMemoryOnQuit')} hint={t('general.clearMemoryOnQuitHint')} checked={clearMemoryOnQuit} onChange={setClearMemoryOnQuit} />

                <Separator className="my-2" />

                <ToggleRow label={t('general.ghostMode')} hint={t('general.ghostModeHint')} checked={ghostMode} onChange={setGhostMode} />
                <ToggleRow label={t('general.hideTrayIcon')} hint={t('general.hideTrayIconHint')} checked={hideTrayIcon} onChange={setHideTrayIcon} />

                <Separator className="my-2" />

                {/* Workspace */}
                <div className="py-1.5">
                  <div className="text-[12px] font-medium text-white dark:text-neutral-900">{t('workspace.title') || 'Workspace'}</div>
                  <div className="text-[10.5px] text-white/50 dark:text-neutral-900/55">{t('workspace.hint') || 'Where documents are saved'}</div>
                  <div className="mt-1.5 flex gap-2">
                    <div className="flex-1 truncate rounded-md border border-white/12 bg-black/30 px-2.5 py-1.5 text-[12px] text-white/85 dark:border-neutral-900/15 dark:bg-neutral-900/4 dark:text-neutral-900/85">
                      {workspace || 'Not set'}
                    </div>
                    <button type="button" onClick={() => void pickWorkspace()} className={BTN_CLS}>Change{'\u2026'}</button>
                  </div>
                </div>

                <Separator className="my-2" />

                {/* Memory */}
                <div className="flex items-center justify-between py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-white dark:text-neutral-900">{t('memory.title')}</div>
                    <div className="text-[10.5px] text-white/50 dark:text-neutral-900/55">Long-term memory entries</div>
                  </div>
                  <button onClick={() => setShowMemory(true)} className={BTN_CLS}>{t('memory.manage')}</button>
                </div>

                <Separator className="my-2" />

                {/* Skills */}
                <div className="py-1.5">
                  <div className="text-[12px] font-medium text-white dark:text-neutral-900">{t('skills.title')}</div>
                  <div className="text-[10.5px] text-white/50 dark:text-neutral-900/55">{t('skills.hint')}</div>
                </div>
                {skills.length === 0 ? (
                  <div className="pb-2 text-[10.5px] text-white/40 dark:text-neutral-900/45">{t('skills.none')}</div>
                ) : (
                  <div className="pb-1">
                    {skills.map((s) => (
                      <div key={s.id} className="flex items-center justify-between gap-3 py-1.5">
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-medium text-white dark:text-neutral-900">{s.name}</div>
                          <div className="text-[10.5px] text-white/50 dark:text-neutral-900/55 line-clamp-2">{s.description}</div>
                        </div>
                        <Switch checked={s.enabled} onCheckedChange={(v) => void setSkillOn(s.id, v)} />
                      </div>
                    ))}
                  </div>
                )}

                <Separator className="my-2" />

                <div className="py-1.5">
                  <div className="text-[10.5px] text-white/40 dark:text-neutral-900/45">
                    Spirit v1.2.0
                  </div>
                </div>
              </TabsContent>

              {/* AI Tab */}
              <TabsContent value="ai" className="w-full min-w-0 space-y-3 px-4 pb-4 overflow-hidden">
                {PROVIDERS.map((meta) => {
                  const p = meta.id === 'localai' ? providersLocalAi : initial.providers[meta.id];
                  const hasKey = p?.hasKey || !!p?.apiKey;
                  const testing = testState[meta.id].status === 'testing';

                  if (meta.id === 'localai') {
                    return (
                      <div key={meta.id} className="w-full min-w-0 overflow-hidden rounded-lg border border-white/8 bg-white/3 p-4 dark:border-neutral-900/10 dark:bg-neutral-900/3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Switch checked={p.enabled} onCheckedChange={(v) => setProvidersLocalAi((prev) => ({ ...prev, enabled: v }))} />
                            <span className="text-[12px] font-medium text-white dark:text-neutral-900">{meta.name}</span>
                          </div>
                        </div>
                        {p.enabled && (
                          <ServerProviderCard
                            p={p}
                            showKey={showKeys.localai}
                            testState={testState.localai}
                            onField={(key, value) => setProvidersLocalAi((prev) => ({ ...prev, [key]: value }))}
                            onDetect={() => void runLocalAiDetect()}
                            onTest={() => void runLocalAiTest()}
                            onSelectModel={(id) => selectLocalAiModel(id)}
                            onToggleShowKey={() => setShowKeys((k) => ({ ...k, localai: !k.localai }))}
                            bridge
                            bridgeHasKey={bridgeHasKey}
                            bridgeKeyDraft={bridgeKeyDraft}
                            onBridgeKeyChange={(v) => {
                              if (v === '__CLEAR__') {
                                setBridgeKeyDraft('');
                                setBridgeKeyCleared(true);
                              } else {
                                setBridgeKeyDraft(v);
                                setBridgeKeyCleared(false);
                              }
                            }}
                          />
                        )}
                        {p.enabled && testState.localai.status !== 'idle' && (
                          <TestResultLine state={testState.localai} testedKey={testedKey.localai} currentKey={(p.baseUrl ?? '').trim()} />
                        )}
                      </div>
                    );
                  }

                  if (meta.id === 'opencode') {
                    const local = { cfg: providersOpencode, set: setProvidersOpencode, st: testState.opencode, tKey: testedKey.opencode, sKey: showKeys.opencode, det: runOpencodeDetect, tst: runOpencodeTest, sel: selectOpencodeModel, tog: () => setShowKeys((k) => ({ ...k, opencode: !k.opencode })) };
                    return (
                      <div key={meta.id} className="w-full min-w-0 overflow-hidden rounded-lg border border-white/8 bg-white/3 p-4 dark:border-neutral-900/10 dark:bg-neutral-900/3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Switch checked={local.cfg.enabled} onCheckedChange={(v) => local.set((prev) => ({ ...prev, enabled: v }))} />
                            <span className="text-[12px] font-medium text-white dark:text-neutral-900">{meta.name}</span>
                          </div>
                        </div>
                        {local.cfg.enabled && (
                          <ServerProviderCard
                            p={local.cfg}
                            showKey={local.sKey}
                            testState={local.st}
                            onField={(key, value) => local.set((prev) => ({ ...prev, [key]: value }))}
                            onDetect={local.det}
                            onTest={local.tst}
                            onSelectModel={local.sel}
                            onToggleShowKey={local.tog}
                          />
                        )}
                        {local.cfg.enabled && local.st.status !== 'idle' && (
                          <TestResultLine state={local.st} testedKey={local.tKey} currentKey={(local.cfg.baseUrl ?? '').trim()} />
                        )}
                      </div>
                    );
                  }

                  return (
                    <div key={meta.id} className="w-full min-w-0 overflow-hidden rounded-lg border border-white/8 bg-white/3 p-4 dark:border-neutral-900/10 dark:bg-neutral-900/3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Switch checked={providerEnabled[meta.id]} onCheckedChange={(on) => setProviderEnabled((e) => ({ ...e, [meta.id]: on }))} />
                          <span className="text-[12px] font-medium text-white dark:text-neutral-900">{meta.name}</span>
                        </div>
                        {hasKey && !showKeys[meta.id] && !replacingKey[meta.id] && (
                          <span className="shrink-0 rounded bg-[rgb(var(--spirit-accent-rgb))]/10 px-1.5 py-0.5 text-[9px] text-[rgb(var(--spirit-accent-rgb))]">
                            {'\u2022\u2022\u2022\u2022\u2022\u2022'}
                          </span>
                        )}
                      </div>
                      {providerEnabled[meta.id] && (hasKey && !showKeys[meta.id] && !replacingKey[meta.id] ? (
                        <div className="mt-2.5 flex items-center gap-2">
                          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[rgb(var(--spirit-accent-rgb))]/30 bg-[rgb(var(--spirit-accent-rgb))]/8 px-2.5 py-1.5 text-[11px] text-[rgb(var(--spirit-accent-rgb))]">
                            <span>{'\u2713'}</span>
                            <span className="truncate">Key saved</span>
                          </div>
                          <button type="button" onClick={() => setReplacingKey((r) => ({ ...r, [meta.id]: true }))} className="shrink-0 text-[10px] text-[rgb(var(--spirit-accent-rgb))]/80 hover:text-[rgb(var(--spirit-accent-rgb))]">Change</button>
                          <button type="button" onClick={() => void runTest(meta.id)} disabled={testing} className="shrink-0 rounded-md border border-white/14 bg-black/30 px-2 py-1 text-[10px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 text-white/85 hover:text-white dark:border-neutral-900/18 dark:bg-neutral-900/4">
                            {testing ? 'Testing\u2026' : 'Test'}
                          </button>
                        </div>
                      ) : (
                        <div className="mt-2.5 flex flex-col gap-2">
                          <input
                            type={showKeys[meta.id] ? 'text' : 'password'}
                            value={providerKeys[meta.id]}
                            onChange={(e) => setProviderKeys((k) => ({ ...k, [meta.id]: e.target.value }))}
                            placeholder={meta.keyPlaceholder}
                            spellCheck={false}
                            className={INPUT_CLS}
                          />
                          <div className="flex min-w-0 flex-wrap gap-1.5">
                            <button type="button" onClick={() => setShowKeys((k) => ({ ...k, [meta.id]: !k[meta.id] }))} className={BTN_CLS}>
                              {showKeys[meta.id] ? 'hide' : 'show'}
                            </button>
                            <button type="button" onClick={() => void window.spirit.openExternal('https://' + meta.getKey)} className={cn(BTN_CLS, 'text-[rgb(var(--spirit-accent-rgb))]/85 hover:text-[rgb(var(--spirit-accent-rgb))]')}>
                              Get key
                            </button>
                            <button type="button" onClick={() => void runTest(meta.id, providerKeys[meta.id])} disabled={!providerKeys[meta.id].trim() || testing} className={BTN_DISABLED_CLS}>
                              {testing ? 'Testing\u2026' : 'Test'}
                            </button>
                          </div>
                        </div>
                      ))}
                      {providerEnabled[meta.id] && testState[meta.id].status !== 'idle' && (
                        <TestResultLine state={testState[meta.id]} testedKey={testedKey[meta.id]} currentKey={providerKeys[meta.id] || (initial.providers[meta.id]?.apiKey ?? '')} />
                      )}
                    </div>
                  );
                })}

                <Separator className="my-2" />

                <div className="pr-4">
                  <ToggleRow label="Web search on every query" hint="Route through online mode for Google-grounded answers" checked={webSearch} onChange={setWebSearch} />
                </div>
              </TabsContent>

              {/* Voice Tab */}
              <TabsContent value="voice" className="space-y-1 px-4 pb-4 overflow-hidden">
                <SettingRow label={t('voice.sttProvider')} hint={t('voice.sttProviderHint')}>
                  <Select value={sttEngine} onValueChange={(v) => setSttEngine(v as STTEngine)}>
                    <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {STT_ENGINES.map((e) => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </SettingRow>

                <SettingRow label="Voice language" hint="Auto-detect figures out the spoken language each time">
                  <Select value={voiceLanguage} onValueChange={setVoiceLanguage}>
                    <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto-detect</SelectItem>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="de">German</SelectItem>
                      <SelectItem value="fr">French</SelectItem>
                      <SelectItem value="es">Spanish</SelectItem>
                      <SelectItem value="pt">Portuguese</SelectItem>
                      <SelectItem value="ja">Japanese</SelectItem>
                      <SelectItem value="zh">Chinese</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingRow>

                <ToggleRow label="Voice-first mode" hint="Auto-start mic and read answers aloud" checked={audioMode} onChange={setAudioMode} />

                <Separator className="my-2" />

                <div className="py-1.5">
                  <button
                    type="button"
                    onClick={() => setSttModelsOpen((v) => !v)}
                    aria-expanded={sttModelsOpen}
                    className="flex w-full items-center justify-between gap-2 text-left"
                  >
                    <span className="text-[12px] font-medium text-white dark:text-neutral-900">Speech model</span>
                    <span className="shrink-0 text-[10.5px] font-medium text-white/50 transition hover:text-white/80 dark:text-neutral-900/55 dark:hover:text-neutral-900">
                      {sttModelsOpen ? 'Hide' : 'Show'}
                    </span>
                  </button>
                  <div className="text-[10.5px] text-white/50 dark:text-neutral-900/55">{sttRec || 'Checking your PC…'}</div>
                  {sttModelsOpen && (
                  <div className="mt-2 space-y-1.5">
                    {(sttModels ?? []).map((m) => (
                      <div key={m.id} className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 dark:border-neutral-900/15 dark:bg-neutral-900/5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-white dark:text-neutral-900">
                            <span className="truncate">{m.id === 'turbo' ? 'X-Turbo' : m.id}</span>
                            {m.active && <span className="shrink-0 rounded-full bg-[rgb(var(--spirit-accent-rgb))]/20 px-1.5 py-px text-[9.5px] font-bold text-accent">IN USE</span>}
                            {!m.active && m.recommended && <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-px text-[9.5px] font-bold text-white/70 dark:bg-neutral-900/10 dark:text-neutral-900/70">PICK</span>}
                            <span className="shrink-0 text-[10px] font-normal tabular-nums text-white/40 dark:text-neutral-900/50">
                              {m.downloaded ? `· ${m.diskMB}MB on disk` : m.partial ? `· incomplete (${m.diskMB}MB stuck)` : `· ${m.sizeMB}MB download`}
                            </span>
                            {m.partial && <span className="shrink-0 rounded-full bg-amber-400/20 px-1.5 py-px text-[9.5px] font-bold text-amber-300 dark:text-amber-700">INCOMPLETE</span>}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {!m.active && (
                              <button
                                type="button"
                                disabled={sttBusy !== null}
                                onClick={() => void useSttModel(m)}
                                className="rounded-md border border-white/14 bg-black/30 px-2 py-1 text-[10px] font-medium text-white/85 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900/80 dark:hover:text-neutral-900"
                              >
                                {sttBusy === m.id ? 'Working…' : m.downloaded ? 'Use' : m.partial ? 'Retry' : 'Download'}
                              </button>
                            )}
                            {(m.downloaded || m.partial) && !m.active && (
                              <button
                                type="button"
                                disabled={sttBusy !== null}
                                onClick={() => void delSttModel(m.id)}
                                aria-label={`Delete ${m.id} model`}
                                title={`Delete ${m.id} (${m.diskMB}MB)`}
                                className="rounded-md border border-white/14 bg-black/30 px-2 py-1 text-[10px] font-medium text-white/60 transition hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900/60 dark:hover:text-rose-700"
                              >
                                Delete
                              </button>
                            )}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[10.5px] leading-snug text-white/50 dark:text-neutral-900/55">{m.note}</div>
                        {sttBusy === m.id && sttProg !== null && (
                          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10 dark:bg-neutral-900/10">
                            <div className="h-full rounded-full bg-[rgb(var(--spirit-accent-rgb))]" style={{ width: `${Math.round(sttProg)}%` }} />
                          </div>
                        )}
                      </div>
                    ))}
                    {sttErr && (
                      <div className="text-[10.5px] leading-snug text-rose-300 dark:text-rose-700">
                        Download failed ({sttErr}). Broken files were cleaned - tap Download to retry.
                      </div>
                    )}
                  </div>
                )}
                </div>

                <SettingRow label="Voice context" hint="One line about how you speak — guides the recognizer">
                  <input
                    value={sttInitialPrompt}
                    onChange={(e) => setSttInitialPrompt(e.target.value)}
                    placeholder="e.g. I mix Hindi and English"
                    maxLength={300}
                    className="w-[200px] rounded-md border border-white/14 bg-black/40 px-2 py-1.5 text-[12px] text-white outline-none placeholder:text-white/30 focus:border-[rgb(var(--spirit-accent-rgb))]/60 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900 dark:placeholder:text-neutral-900/35"
                  />
                </SettingRow>

                <div className="py-1.5">
                  <div className="text-[12px] font-medium text-white dark:text-neutral-900">Word fixes</div>
                  <div className="text-[10.5px] text-white/50 dark:text-neutral-900/55">Words the recognizer always gets wrong — one <span className="font-mono">heard → wanted</span> per line.</div>
                  <textarea
                    value={sttWordOverrides}
                    onChange={(e) => setSttWordOverrides(e.target.value)}
                    placeholder={'spear it → Spirit\npie tor ch → pytorch'}
                    rows={2}
                    maxLength={4000}
                    className="mt-1.5 w-full resize-y rounded-md border border-white/14 bg-black/40 px-2 py-1.5 font-mono text-[11.5px] text-white outline-none placeholder:text-white/30 focus:border-[rgb(var(--spirit-accent-rgb))]/60 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900 dark:placeholder:text-neutral-900/35"
                  />
                </div>

                <Separator className="my-2" />

                <div className="py-1.5">
                  <div className="text-[12px] font-medium text-white dark:text-neutral-900">{t('voice.rate')}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <Slider value={[ttsRate]} onValueChange={([v]) => setTtsRate(v)} min={0.5} max={2} step={0.05} className="flex-1" />
                    <span className="w-8 text-right text-[11px] text-white/60 dark:text-neutral-900/60">{ttsRate.toFixed(1)}×</span>
                  </div>
                </div>
              </TabsContent>

              {/* Appearance Tab */}
              <TabsContent value="appearance" className="space-y-1 px-4 pb-4 overflow-hidden">
                <SettingRow label={t('appearance.theme')} hint={t('appearance.themeHint')}>
                  <Select value={themePreference} onValueChange={(v) => setThemePreference(v as 'system' | 'light' | 'dark')}>
                    <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="system">{t('appearance.themeSystem')}</SelectItem>
                      <SelectItem value="dark">{t('appearance.themeDark')}</SelectItem>
                      <SelectItem value="light">{t('appearance.themeLight')}</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingRow>

                <div className="py-1.5">
                  <div className="text-[12px] font-medium text-white dark:text-neutral-900">Window glass</div>
                  <div className="text-[10.5px] text-white/50 dark:text-neutral-900/55">0 = solid box. Slide up for more frost. Box + chips turn glassy. Live preview.</div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="w-14 shrink-0 text-[11px] text-white/60 dark:text-neutral-900/60">Tint</span>
                    <Slider
                      value={[glassIntensity]}
                      onValueChange={([v]) => pushGlass({ intensity: v })}
                      onValueCommit={() => commitGlass()}
                      min={0}
                      max={100}
                      step={1}
                      className="flex-1"
                    />
                    <span className="w-9 shrink-0 text-right text-[11px] text-white/60 dark:text-neutral-900/60">{glassIntensity}%</span>
                  </div>
                </div>
              </TabsContent>

              {/* Actions Tab */}
              <TabsContent value="actions" className="space-y-1 px-4 pb-4 overflow-hidden">
                <ToggleRow label={t('ai.autoApprove')} hint={t('ai.autoApproveHint')} checked={autoApproveTools} onChange={setAutoApproveTools} />
                <ToggleRow label="Save sessions to workspace" hint="On dismiss, write a transcript to your workspace" checked={memorySaveEnabled} onChange={setMemorySaveEnabled} />
                <ToggleRow label="Long-term context memory" hint="Spirit learns from your chats — extracts facts and recalls them on every turn" checked={contextMemoryEnabled} onChange={setContextMemoryEnabled} />
                <ToggleRow label="Double-click to dismiss" hint="Require a double-click into empty area to close the box" checked={dismissOnDoubleClick} onChange={setDismissOnDoubleClick} />

                <Separator className="my-2" />

                <ToggleRow label="Auto context" hint="Budget follows the serving model's window. Turn off to set it manually." checked={autoContext} onChange={setAutoContext} />
                <ToggleRow label="Auto-fix highlight boxes" hint="After each answer, re-checks the on-screen boxes and snaps them exactly onto buttons and text. Off = boxes stay as first drawn, faster." checked={annotFinalPass} onChange={setAnnotFinalPass} />

                <SettingRow label="Context budget" hint={autoContext ? 'Auto: set by the model — turn Auto off to edit' : 'Older turns dropped once total exceeds this'}>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={2000}
                      max={512000}
                      step={1000}
                      value={maxContextTokens}
                      disabled={autoContext}
                      onChange={(e) => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) setMaxContextTokens(v); }}
                      className="w-24 rounded-md border border-white/14 bg-black/40 px-2 py-1 text-right text-[12px] font-mono text-white outline-none focus:border-[rgb(var(--spirit-accent-rgb))]/60 disabled:opacity-40 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900"
                    />
                    <span className="text-[11px] text-white/55 dark:text-neutral-900/55">tokens</span>
                  </div>
                </SettingRow>

                <Separator className="my-2" />

                <div className="py-1.5">
                  <div className="text-[12px] font-medium text-white dark:text-neutral-900">Annotation calibration</div>
                  <div className="text-[10.5px] text-white/50 dark:text-neutral-900/55">Fix tags that land left/down of the real spot. Applies to model-guessed points/boxes/arrows (not snapped elements). Saved instantly.</div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-white/55 dark:text-neutral-900/55">Offset X (px)</span>
                    <input
                      type="number"
                      step={10}
                      value={annotOffsetX}
                      onChange={(e) => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) { setAnnotOffsetX(v); void ipc.setSettings({ annotOffsetX: v }); } }}
                      className="w-full rounded-md border border-white/14 bg-black/40 px-2.5 py-1.5 text-[12px] font-mono text-white outline-none focus:border-[rgb(var(--spirit-accent-rgb))]/60 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-white/55 dark:text-neutral-900/55">Offset Y (px)</span>
                    <input
                      type="number"
                      step={10}
                      value={annotOffsetY}
                      onChange={(e) => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) { setAnnotOffsetY(v); void ipc.setSettings({ annotOffsetY: v }); } }}
                      className="w-full rounded-md border border-white/14 bg-black/40 px-2.5 py-1.5 text-[12px] font-mono text-white outline-none focus:border-[rgb(var(--spirit-accent-rgb))]/60 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900"
                    />
                  </label>
                </div>

                <Separator className="my-2" />

                {/* Profile */}
                <div className="py-1.5">
                  <div className="text-[12px] font-medium text-white dark:text-neutral-900">Profile</div>
                  <div className="text-[10.5px] text-white/50 dark:text-neutral-900/55">Optional personalization</div>
                </div>
                <ToggleRow label="Personalize prompts" hint="Add your name and role to prompts for tailored replies" checked={personalizePrompts} onChange={setPersonalizePrompts} />
                {personalizePrompts && (
                  <div className="grid grid-cols-2 gap-2 py-1.5">
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-white/55 dark:text-neutral-900/55">Name</span>
                      <input type="text" value={userProfile.name} onChange={(e) => setUserProfile((p) => ({ ...p, name: e.target.value }))} placeholder="Your name" className="rounded-md border border-white/14 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[rgb(var(--spirit-accent-rgb))]/60 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-white/55 dark:text-neutral-900/55">Role</span>
                      <input type="text" value={userProfile.role} onChange={(e) => setUserProfile((p) => ({ ...p, role: e.target.value }))} placeholder="e.g. solo founder" className="rounded-md border border-white/14 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[rgb(var(--spirit-accent-rgb))]/60 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-white/55 dark:text-neutral-900/55">Reply language</span>
                      <input type="text" value={userProfile.preferredLanguage} onChange={(e) => setUserProfile((p) => ({ ...p, preferredLanguage: e.target.value }))} placeholder="English" className="rounded-md border border-white/14 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[rgb(var(--spirit-accent-rgb))]/60 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-white/55 dark:text-neutral-900/55">Translate to</span>
                      <input type="text" value={userProfile.translateLanguage} onChange={(e) => setUserProfile((p) => ({ ...p, translateLanguage: e.target.value }))} placeholder="Spanish" className="rounded-md border border-white/14 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-[rgb(var(--spirit-accent-rgb))]/60 dark:border-neutral-900/18 dark:bg-neutral-900/5 dark:text-neutral-900" />
                    </label>
                  </div>
                )}
              </TabsContent>
            </ScrollArea>

            {/* Footer — no Save button: every change writes straight through
                on edit (see the auto-save effect). Close just closes. */}
            <Separator />
            <div className="flex items-center justify-between px-4 py-2.5">
              <p className="text-[10.5px] text-white/40 dark:text-neutral-900/45">
                Changes save instantly
              </p>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-[rgb(var(--spirit-accent-rgb))] px-3.5 py-1.5 text-[11px] font-medium text-white transition hover:opacity-90"
              >
                Close
              </button>
            </div>
          </Tabs>
        )}
      </motion.div>
    </AnimatePresence>
  );
}

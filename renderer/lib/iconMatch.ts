// Fuzzy icon resolution for AI-suggested action chips. The model returns a
// free-text icon word ("summarize", "email", ...); we map it to the closest
// Tabler icon via a curated alias table + a small edit-distance matcher,
// falling back to sparkles. Only the icons referenced here are imported, so
// the overlay bundle stays tree-shaken (importing the full set would add
// megabytes).
import type { ComponentType } from 'react';
import type { IconProps } from '@tabler/icons-react';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBallpen,
  IconBook,
  IconBookmark,
  IconBolt,
  IconBulb,
  IconCalculator,
  IconCalendar,
  IconCampfire,
  IconChartBar,
  IconCheck,
  IconCircleCheck,
  IconClock,
  IconCloud,
  IconCloudRain,
  IconCloudSnow,
  IconCloudStorm,
  IconCode,
  IconCopy,
  IconDeviceDesktop,
  IconDownload,
  IconDroplet,
  IconExternalLink,
  IconFileText,
  IconFlame,
  IconGlobe,
  IconHeart,
  IconIceCream,
  IconInfoCircle,
  IconKey,
  IconLanguage,
  IconLink,
  IconListCheck,
  IconLock,
  IconMail,
  IconMap,
  IconMapPin,
  IconMathFunction,
  IconMoon,
  IconMusic,
  IconNotes,
  IconPencil,
  IconPhone,
  IconPhoto,
  IconPlayerPlay,
  IconPower,
  IconQuestionMark,
  IconQuote,
  IconRainbow,
  IconRefresh,
  IconRoute,
  IconDeviceFloppy,
  IconSchool,
  IconSearch,
  IconSend,
  IconSettings,
  IconShare,
  IconShieldCheck,
  IconSnowflake,
  IconSparkles,
  IconStar,
  IconStars,
  IconSun,
  IconSunrise,
  IconSunset,
  IconTable,
  IconTerminal,
  IconTool,
  IconTools,
  IconTypography,
  IconVideo,
  IconWind,
  IconWindmill,
  IconWriting,
  IconX,
  IconZoomIn,
} from '@tabler/icons-react';

export type TablerIcon = ComponentType<IconProps>;

// Curated word → icon table. Keys are the lowercase words the model is likely
// to emit (plus common synonyms); values are the installed Tabler components.
export const ICON_ALIASES: Record<string, TablerIcon> = {
  // — Status / result —
  check: IconCheck,
  verify: IconShieldCheck,
  validate: IconShieldCheck,
  test: IconShieldCheck,
  confirm: IconCircleCheck,
  approve: IconCircleCheck,
  accept: IconCircleCheck,
  success: IconCircleCheck,
  done: IconCircleCheck,
  complete: IconCircleCheck,
  finished: IconCircleCheck,
  correct: IconCircleCheck,
  right: IconCircleCheck,
  yes: IconCircleCheck,
  x: IconX,
  error: IconX,
  fail: IconX,
  failed: IconX,
  wrong: IconX,
  false: IconX,
  no: IconX,
  reject: IconX,
  deny: IconX,
  decline: IconX,
  cancel: IconX,
  abort: IconX,
  stop: IconX,
  missing: IconX,
  notfound: IconSearch,
  lost: IconSearch,

  // — Search / lookup —
  search: IconSearch,
  find: IconSearch,
  lookup: IconSearch,
  research: IconSearch,
  investigate: IconSearch,
  explore: IconSearch,
  discover: IconSearch,
  filter: IconSearch,
  magnify: IconZoomIn,
  zoom: IconZoomIn,
  expand: IconZoomIn,

  // — Ideas / insight —
  sparkles: IconSparkles,
  idea: IconBulb,
  brainstorm: IconBulb,
  bulb: IconBulb,
  tip: IconBulb,
  hint: IconBulb,
  suggestion: IconBulb,

  // — Warnings / alert —
  warn: IconAlertTriangle,
  warning: IconAlertTriangle,
  danger: IconAlertTriangle,
  critical: IconAlertTriangle,
  urgent: IconAlertTriangle,
  alert: IconAlertTriangle,

  // — Info / note —
  info: IconInfoCircle,
  note: IconInfoCircle,
  'info-circle': IconInfoCircle,

  // — Importance / favorite —
  star: IconStar,
  favorite: IconStar,
  important: IconStar,
  priority: IconStar,
  premium: IconStar,
  best: IconStar,
  top: IconStar,
  stars: IconStars,

  // — Time —
  clock: IconClock,
  time: IconClock,
  timer: IconClock,
  wait: IconClock,
  hold: IconClock,
  delay: IconClock,
  later: IconClock,
  soon: IconClock,
  schedule: IconCalendar,
  calendar: IconCalendar,
  date: IconCalendar,

  // — Speed / power —
  bolt: IconBolt,
  power: IconPower,
  energy: IconBolt,
  strength: IconBolt,
  fast: IconBolt,
  quick: IconBolt,
  instant: IconBolt,
  speed: IconBolt,
  zap: IconBolt,

  // — Fire / heat —
  fire: IconFlame,
  flame: IconFlame,
  hot: IconFlame,
  burning: IconFlame,
  campfire: IconCampfire,

  // — Weather / nature —
  sun: IconSun,
  moon: IconMoon,
  rainbow: IconRainbow,
  snowflake: IconSnowflake,
  cold: IconSnowflake,
  freeze: IconSnowflake,
  ice: IconSnowflake,
  'ice-cream': IconIceCream,
  cloud: IconCloud,
  rain: IconCloudRain,
  snow: IconCloudSnow,
  storm: IconCloudStorm,
  wind: IconWind,
  windmill: IconWindmill,
  sunset: IconSunset,
  sunrise: IconSunrise,
  water: IconDroplet,
  drop: IconDroplet,
  light: IconSun,
  dark: IconMoon,
  bright: IconSun,
  dim: IconMoon,

  // — Love / heart —
  heart: IconHeart,
  love: IconHeart,
  like: IconHeart,

  // — Learning —
  book: IconBook,
  summarize: IconBook,
  summary: IconFileText,
  explain: IconSchool,
  teach: IconSchool,
  learn: IconSchool,
  study: IconBook,
  read: IconBook,
  understand: IconSchool,

  // — Language —
  translate: IconLanguage,
  language: IconLanguage,
  write: IconWriting,
  compose: IconWriting,
  draft: IconWriting,
  edit: IconPencil,
  modify: IconPencil,
  rewrite: IconWriting,
  'ball-pen': IconBallpen,

  // — Communication —
  mail: IconMail,
  email: IconMail,
  reply: IconMail,
  message: IconMail,
  send: IconSend,
  post: IconSend,
  publish: IconSend,
  share: IconShare,
  phone: IconPhone,
  call: IconPhone,
  contact: IconPhone,

  // — Code / dev —
  code: IconCode,
  script: IconCode,
  program: IconCode,
  api: IconCode,
  endpoint: IconCode,
  function: IconCode,
  terminal: IconTerminal,
  shell: IconTerminal,
  console: IconTerminal,
  command: IconTerminal,

  // — Data / structure —
  table: IconTable,
  tabular: IconTable,
  spreadsheet: IconTable,
  list: IconListCheck,
  checklist: IconListCheck,
  enumerate: IconListCheck,
  chart: IconChartBar,
  graph: IconChartBar,
  plot: IconChartBar,
  analyze: IconChartBar,
  analyse: IconChartBar,
  compare: IconChartBar,
  measure: IconChartBar,
  data: IconChartBar,

  // — Links / web —
  link: IconLink,
  url: IconLink,
  web: IconGlobe,
  browser: IconGlobe,
  site: IconGlobe,
  globe: IconGlobe,
  world: IconGlobe,
  internet: IconGlobe,
  online: IconGlobe,
  network: IconGlobe,

  // — Math —
  math: IconMathFunction,
  calculate: IconCalculator,
  compute: IconCalculator,
  equation: IconCalculator,
  formula: IconMathFunction,

  // — Quote / reference —
  quote: IconQuote,
  cite: IconQuote,
  reference: IconExternalLink,

  // — Navigation —
  map: IconMap,
  navigate: IconMapPin,
  route: IconRoute,
  directions: IconRoute,
  location: IconMapPin,
  'arrow-right': IconArrowRight,
  next: IconArrowRight,
  forward: IconArrowRight,
  continue: IconArrowRight,

  // — Copy / clipboard —
  copy: IconCopy,
  paste: IconCopy,
  duplicate: IconCopy,
  clone: IconCopy,
  clipboard: IconCopy,

  // — File —
  file: IconFileText,
  document: IconFileText,
  report: IconFileText,
  notes: IconNotes,
  memo: IconNotes,

  // — Save / store —
  save: IconDeviceFloppy,
  download: IconDownload,
  export: IconDownload,
  upload: IconDownload,
  import: IconDownload,

  // — Bookmark —
  bookmark: IconBookmark,
  remember: IconBookmark,

  // — Refresh —
  refresh: IconRefresh,
  retry: IconRefresh,
  reload: IconRefresh,
  sync: IconRefresh,
  update: IconRefresh,
  undo: IconRefresh,
  redo: IconRefresh,

  // — Tools —
  build: IconTools,
  make: IconTools,
  construct: IconTools,
  develop: IconTools,
  fix: IconTool,
  repair: IconTool,
  solve: IconTool,
  troubleshoot: IconTool,
  debug: IconTool,
  inspect: IconTool,
  tools: IconTools,

  // — Settings —
  settings: IconSettings,
  config: IconSettings,
  configure: IconSettings,
  setup: IconSettings,
  preferences: IconSettings,
  options: IconSettings,
  manage: IconSettings,

  // — Security —
  lock: IconLock,
  secure: IconLock,
  protect: IconLock,
  encrypt: IconLock,
  shield: IconShieldCheck,
  security: IconShieldCheck,
  permission: IconShieldCheck,
  access: IconKey,
  auth: IconKey,
  authenticate: IconKey,
  login: IconKey,
  password: IconKey,
  key: IconKey,
  shortcut: IconKey,
  hotkey: IconKey,
  keyboard: IconKey,

  // — Play / media —
  play: IconPlayerPlay,
  start: IconPlayerPlay,
  begin: IconPlayerPlay,
  run: IconPlayerPlay,
  video: IconVideo,
  film: IconVideo,
  watch: IconVideo,
  music: IconMusic,
  song: IconMusic,
  audio: IconMusic,
  photo: IconPhoto,
  image: IconPhoto,
  picture: IconPhoto,
  camera: IconPhoto,

  // — Device / display —
  monitor: IconDeviceDesktop,
  screen: IconDeviceDesktop,
  desktop: IconDeviceDesktop,

  // — Typography —
  format: IconTypography,
  style: IconTypography,
  bold: IconTypography,
  highlight: IconTypography,

  // — Design —
  draw: IconBallpen,
  sketch: IconBallpen,
  design: IconBallpen,

  // — Question —
  ask: IconQuestionMark,
  question: IconQuestionMark,
  wonder: IconQuestionMark,
  unsure: IconQuestionMark,
  uncertain: IconQuestionMark,
};

const ALIAS_KEYS = Object.keys(ICON_ALIASES);

function normalizeWord(s: string): string {
  const n = s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  // Renderer receives icon names the parser already normalized ("book",
  // "translate"), but a model may also emit raw "Icon-Book" / "icon-book"
  // forms. Strip a leading "icon" so both land on the same alias.
  return n.startsWith('icon') ? n.slice(4) : n;
}

// Classic iterative Levenshtein — tiny inputs (short icon words), so the O(n²)
// cost is negligible and the array-swap version avoids any recursion depth.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array<number>(bl + 1);
  let curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

const FUZZY_THRESHOLD = 0.62;

// Resolve a free-text icon word to a Tabler icon component. Deterministic and
// cheap enough to call during render for every chip.
export function fuzzyResolveIcon(raw: string | null | undefined): TablerIcon {
  const n = normalizeWord(raw ?? '');
  if (!n) return IconSparkles;
  const exact = ICON_ALIASES[n];
  if (exact) return exact;
  // Prefix match first — "summarize-these-notes" → "summarize".
  for (const key of ALIAS_KEYS) {
    if (n.startsWith(key) || key.startsWith(n)) return ICON_ALIASES[key];
  }
  let best: TablerIcon = IconSparkles;
  let bestScore = 0;
  for (const key of ALIAS_KEYS) {
    const sim = 1 - levenshtein(n, key) / Math.max(n.length, key.length);
    if (sim > bestScore) {
      bestScore = sim;
      best = ICON_ALIASES[key];
    }
  }
  return bestScore >= FUZZY_THRESHOLD ? best : IconSparkles;
}

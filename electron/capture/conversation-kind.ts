// Deterministic conversation classification: is the current screen a chat
// thread or an email? Pure string logic on AppContext so it is unit-testable
// without Electron. Feeds the "Conversation type:" context line and lets
// Spirit switch reply tone per app (formal for email, casual for chat) and
// offer a "Suggest a reply" chip when a conversation is actually on screen.
//
// Matches on process name (desktop apps), URL (web apps), and window/tab
// title. Email wins over chat when both match.

import type { AppContext } from '../types';

export type ConversationKind = 'email' | 'chat';

const EMAIL_PROCESS_RE =
  /(?:^|[._-])(outlook|thunderbird|spark|airmail|mailspring|mailbird|edison|protonmail|proton|superhuman|canary|postbox|emclient|blue ?mail|aquamail|fairmail)(?:[._-]|$)/i;
const CHAT_PROCESS_RE =
  /(?:^|[._-])(whatsapp|telegram|signal|discord|slack|teams|msteams|messenger|instagram|skype|viber|wechat|weixin|line|zoom|beeper|imessage|messages|snapchat|element|mattermost)(?:[._-]|$)/i;
const EMAIL_URL_RE =
  /mail\.google\.com|mail\.yandex|outlook\.(?:com|office|live)|mail\.office|mail\.yahoo|mail\.aol|mail\.icloud|icloud\.com\/mail|mail\.proton|proton\.me\/mail|zoho[^/]*\/mail|fastmail\.|hey\.com\/|mail\.163|mail\.qq|mail\.tutanota/i;
const CHAT_URL_RE =
  /web\.whatsapp|whatsapp\.com\/web|web\.telegram|telegram\.org|discord\.com\/app|discordapp\.com\/channels|app\.slack|slack\.com\/|messenger\.com|teams\.microsoft|teams\.live|web\.signal|signal\.org|instagram\.com\/direct|skype\.com\/|viber\.com|web\.wechat|weixin\.qq|line\.me|zoom\.us\/|snapchat\.com\/chat|mattermost/i;
const EMAIL_TAB_RE = /\b(inbox|gmail)\b/i;
const CHAT_TAB_RE = /\b(whatsapp|telegram|discord|slack|messenger)\b/i;

export function conversationKindFromContext(ctx: AppContext): ConversationKind | null {
  const process = (ctx.process || '').toLowerCase();
  const url = (ctx.url || '').toLowerCase();
  const tab = (ctx.activeTab || ctx.title || '').toLowerCase();
  if (EMAIL_PROCESS_RE.test(process) || EMAIL_URL_RE.test(url) || EMAIL_TAB_RE.test(tab)) {
    return 'email';
  }
  if (CHAT_PROCESS_RE.test(process) || CHAT_URL_RE.test(url) || CHAT_TAB_RE.test(tab)) {
    return 'chat';
  }
  return null;
}

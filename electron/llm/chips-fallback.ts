// Offline, deterministic chip suggestions shown when the AI produces nothing
// (empty / mangled JSON, provider error, timeout, or a safety refusal) AND as
// an instant placeholder while a generation round is in flight. Every chip is
// grounded in what the model can ACTUALLY see — the visible text on screen, the
// tab title, the URL, the app name — never in content it cannot access (it
// cannot watch a video or scroll a playlist). Labels vary by detected
// app/site (YouTube ≠ Spotify), so the fallback is context-aware, while staying
// pure/offline/testable (no Electron imports).
//
// Non-repetitive by construction: labels are globally unique (case-insensitive)
// and the picker rotates the start index by the normalized context hash, so the
// same app/site shows a different slice of its category across sessions instead
// of always the same three chips. `opts` carries user settings (translate-to
// language, calendar provider) so a few chips are "smart" about the user.
import { MAX_CHIPS, isReplyChipLabel, type SuggestionChip } from './chips-parse';

type FallbackChip = {
  label: string;
  icon: string;
  prompt: string;
  // True = the chip forces a real web search when tapped (the prompt is sent
  // to the AI with web tools enabled). Only the search category sets this.
  web?: boolean;
};

type ChipCategory = {
  id: string;
  keywords: string[];
  chips: FallbackChip[];
};

export type FallbackOptions = {
  // User's target language for translations (Settings → Profile → Translate to).
  translateTo?: string;
  // Calendar service the user chose (Settings → Behaviour → calendarProvider).
  calendarProvider?: 'google' | 'outlook';
};

function toSuggestion(chip: FallbackChip): SuggestionChip {
  const out: SuggestionChip = { label: chip.label, icon: chip.icon, prompt: chip.prompt };
  if (chip.web) out.web = true;
  return out;
}

// FNV-1a: fast, dependency-free, stable per context string.
function hashInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rotate<T>(arr: T[], offset: number): T[] {
  const n = arr.length;
  if (n <= 1) return arr.slice();
  const k = ((offset % n) + n) % n;
  return [...arr.slice(k), ...arr.slice(0, k)];
}

// Settings-aware chip rewriting. The label is the display text the user sees,
// so it must stay short; the prompt carries the instruction to the AI.
function smartChip(chip: FallbackChip, opts: FallbackOptions): FallbackChip {
  const lang = opts.translateTo?.trim();
  if (chip.label === 'Translate this' && lang) {
    const label = `Translate to ${lang}`;
    return {
      label: label.length <= 45 ? label : chip.label,
      icon: 'translate',
      prompt: `Translate the visible text into ${lang}.`,
    };
  }
  if (chip.label === 'Create an event' && opts.calendarProvider) {
    const cal = opts.calendarProvider === 'google' ? 'Google Calendar' : 'Outlook Calendar';
    return {
      ...chip,
      prompt: `Turn the visible text into a calendar event with a title, time, and notes, and open it in ${cal}.`,
    };
  }
  return chip;
}

const CATEGORIES: ChipCategory[] = [
  {
    id: 'video',
    keywords: [
      'youtube', 'yt', 'vimeo', 'twitch', 'netflix', 'prime video', 'tiktok',
      'video', 'watch', 'livestream',
    ],
    chips: [
      { label: 'Write a comment', icon: 'write', prompt: 'Draft a short, natural comment the user could post under this video, based on the visible title and description on screen.' },
      { label: 'List the topics', icon: 'list', prompt: 'List the main topics and points mentioned in the visible description or comments of this video.' },
      { label: 'Find upload details', icon: 'check', prompt: 'Find and state the upload date, channel name, and view count from the visible video details.' },
      { label: 'Suggest a similar video', icon: 'bulb', prompt: 'Based on the visible video title and description, suggest similar videos or content the user might enjoy.' },
      { label: 'Explain the comments', icon: 'quote', prompt: 'Summarize what people are discussing in the visible comment section of this video.' },
      { label: 'Give me talking points', icon: 'idea', prompt: 'Turn the visible video description into talking points or an outline the user could use.' },
      { label: 'Extract a key quote', icon: 'quote', prompt: 'Pull the most quotable line from the visible video title or description and quote it exactly.' },
      { label: 'Check the channel', icon: 'search', prompt: 'Summarize the visible channel details: name, subscriber count, and recent content.' },
    ],
  },
  {
    id: 'music',
    keywords: [
      'spotify', 'soundcloud', 'apple music', 'deezer', 'music', 'song',
      'playlist', 'album', 'artist', 'podcast', 'lyrics', 'tune',
    ],
    chips: [
      { label: 'Recommend similar songs', icon: 'star', prompt: 'Based on the visible song, album, or artist information on screen, recommend similar songs or artists.' },
      { label: 'Explain this artist', icon: 'bulb', prompt: 'Summarize the visible artist information and explain their style or background.' },
      { label: 'List the track details', icon: 'list', prompt: 'Extract the visible track details: title, album, artist, duration, and release information.' },
      { label: 'Describe this album', icon: 'quote', prompt: 'Using only the visible album details, describe the album and its overall mood or theme.' },
      { label: 'Build a playlist idea', icon: 'idea', prompt: 'Based on the visible music on screen, suggest songs to add to a playlist with the same vibe.' },
      { label: 'Explain the lyrics', icon: 'translate', prompt: 'Explain the meaning of the visible lyrics on screen, line by line if helpful.' },
      { label: 'Match the mood', icon: 'star', prompt: 'Describe the mood of the visible track and suggest when it would fit best in a playlist.' },
      { label: 'Find release info', icon: 'search', prompt: 'Find and state the visible release date, label, and duration for this track or album.' },
    ],
  },
  {
    id: 'email',
    keywords: [
      'gmail', 'outlook', 'yahoo mail', 'proton', 'mail', 'inbox', 'email',
      'thunderbird', 'mail.google.com', 'compose',
    ],
    chips: [
      { label: 'Suggest a reply', icon: 'mail', prompt: 'Draft a reply to the visible email message, matching the way the user writes.' },
      { label: 'Draft a follow-up', icon: 'write', prompt: 'Draft a follow-up email to the sender of the visible message, keeping the same tone.' },
      { label: 'Extract action items', icon: 'check', prompt: 'List the action items, requests, and deadlines mentioned in the visible email.' },
      { label: 'Summarize the email', icon: 'list', prompt: 'Summarize the visible email in a few short bullet points.' },
      { label: 'Write a quick response', icon: 'write', prompt: 'Write a short, polite response to the visible email.' },
      { label: 'Find what is asked', icon: 'search', prompt: 'Identify exactly what the sender is asking for in the visible email and state it clearly.' },
      { label: 'Draft a polite decline', icon: 'write', prompt: 'Draft a polite way to decline or push back on the request in the visible email.' },
      { label: 'Check the tone', icon: 'check', prompt: 'Review the visible email for tone and suggest how to make it more professional or warmer.' },
    ],
  },
  {
    id: 'contacts',
    keywords: ['contacts', 'people', 'address book', 'contact', 'phone book', 'call log'],
    chips: [
      { label: 'Suggest a reply', icon: 'mail', prompt: 'Draft a reply to the visible message or thread, matching the way the user writes.' },
      { label: 'Compose a message', icon: 'write', prompt: 'Draft a short message to this visible contact, based on their details and the situation on screen.' },
      { label: 'Summarize contact info', icon: 'list', prompt: 'Summarize the visible contact details: name, number, email, address, and notes.' },
      { label: 'Draft a birthday message', icon: 'star', prompt: 'Draft a warm birthday message for the visible contact.' },
      { label: 'Find key details', icon: 'search', prompt: 'Find and state the visible contact key details: phone, email, and address.' },
      { label: 'Suggest a check-in', icon: 'mail', prompt: 'Draft a casual check-in message to this contact based on what is visible on screen.' },
      { label: 'Organize the notes', icon: 'write', prompt: 'Clean up and organize the visible notes for this contact into clear sections.' },
    ],
  },
  {
    id: 'chat',
    keywords: [
      'whatsapp', 'telegram', 'discord', 'slack', 'messenger', 'signal',
      'snapchat', 'chat', 'threads', 'conversation',
    ],
    chips: [
      { label: 'Suggest a reply', icon: 'mail', prompt: 'Draft a reply to the visible message thread, matching the way the user writes.' },
      { label: 'Summarize the chat', icon: 'list', prompt: 'Summarize the visible conversation in a few short lines.' },
      { label: 'Draft a message', icon: 'write', prompt: 'Draft a message to send in this conversation based on what is on screen.' },
      { label: 'Rephrase my last message', icon: 'refresh', prompt: 'Rephrase the user last visible message to sound more natural or clearer.' },
      { label: 'Extract the question', icon: 'search', prompt: 'Find the question or request in the visible conversation and state it clearly.' },
      { label: 'Make it friendlier', icon: 'write', prompt: 'Rewrite the visible message to sound warmer and friendlier.' },
      { label: 'List the decisions', icon: 'check', prompt: 'List the decisions and commitments made in the visible conversation so far.' },
      { label: 'Send a follow-up', icon: 'mail', prompt: 'Draft a follow-up message that keeps the visible conversation moving forward.' },
    ],
  },
  {
    id: 'code',
    keywords: [
      'github', 'gitlab', 'bitbucket', 'stackoverflow', 'stack overflow',
      'vscode', 'visual studio', 'jetbrains', 'intellij', 'pycharm', 'code',
      'python', 'javascript', 'typescript', 'repo', 'repository', 'pull request',
      'issue', 'debug', 'json', 'html', 'css', 'commit',
    ],
    chips: [
      { label: 'Explain this code', icon: 'bulb', prompt: 'Explain what the visible code does, step by step, in plain language.' },
      { label: 'Find the bug', icon: 'search', prompt: 'Look at the visible code and error messages, find the likely bug, and suggest a fix.' },
      { label: 'Refactor this', icon: 'refresh', prompt: 'Suggest a cleaner way to write the visible code without changing its behavior.' },
      { label: 'Summarize this PR', icon: 'list', prompt: 'Summarize what the visible pull request or change does and its key files.' },
      { label: 'Write a test', icon: 'check', prompt: 'Write a short unit test for the visible function or class.' },
      { label: 'Explain this error', icon: 'bulb', prompt: 'Explain what the visible error message means and how to fix it.' },
      { label: 'Name this better', icon: 'idea', prompt: 'Suggest better variable or function names for the visible code.' },
      { label: 'Review this', icon: 'check', prompt: 'Review the visible code for bugs, style issues, and possible improvements.' },
      { label: 'Write the docs', icon: 'write', prompt: 'Write clear documentation comments for the visible code.' },
      { label: 'Compare the approaches', icon: 'table', prompt: 'Compare the visible code or two visible snippets and note the trade-offs.' },
    ],
  },
  {
    id: 'terminal',
    keywords: [
      'cmd', 'powershell', 'terminal', 'console', 'bash', 'zsh', 'command prompt',
      'command line', 'windows terminal', 'shell', 'output',
    ],
    chips: [
      { label: 'Explain this command', icon: 'bulb', prompt: 'Explain what the visible command does and its key flags, in plain language.' },
      { label: 'Find the error', icon: 'search', prompt: 'Scan the visible terminal output, find the error, and explain what caused it.' },
      { label: 'Fix this command', icon: 'refresh', prompt: 'Suggest a corrected version of the visible command if it has a mistake.' },
      { label: 'Summarize the output', icon: 'list', prompt: 'Summarize what the visible terminal output is telling the user.' },
      { label: 'Explain the steps', icon: 'bulb', prompt: 'Explain the sequence of what the visible commands are doing.' },
      { label: 'Simplify the command', icon: 'write', prompt: 'Rewrite the visible command to be shorter or easier to read.' },
      { label: 'Show the flags', icon: 'list', prompt: 'Explain each flag and option of the visible command and what it changes.' },
    ],
  },
  {
    id: 'docs',
    keywords: [
      'google docs', 'docs.google', 'word', 'notion', 'sheets', 'slides',
      'powerpoint', 'document', 'essay', 'report', 'paper', 'wordpad', 'pages',
    ],
    chips: [
      { label: 'Suggest edits', icon: 'write', prompt: 'Suggest specific edits to improve the visible document text.' },
      { label: 'Turn this into a table', icon: 'table', prompt: 'Convert the visible text into a clear table format.' },
      { label: 'Fix the grammar', icon: 'check', prompt: 'Fix the grammar, spelling, and punctuation in the visible text.' },
      { label: 'Shorten this', icon: 'refresh', prompt: 'Rewrite the visible text more concisely while keeping the meaning.' },
      { label: 'Improve the wording', icon: 'write', prompt: 'Suggest better word choices and phrasing for the visible text.' },
      { label: 'Summarize the document', icon: 'list', prompt: 'Summarize the visible document in a few clear bullet points.' },
      { label: 'Create an outline', icon: 'list', prompt: 'Turn the visible text into a structured outline with headings.' },
      { label: 'Check the structure', icon: 'check', prompt: 'Review the visible document structure and suggest where to split or reorder sections.' },
      { label: 'Write the conclusion', icon: 'write', prompt: 'Draft a conclusion that wraps up the visible document arguments.' },
    ],
  },
  {
    id: 'pdf',
    keywords: ['pdf', 'acrobat', 'adobe reader', 'document reader'],
    chips: [
      { label: 'Extract the key points', icon: 'list', prompt: 'Extract the main points from the visible PDF page.' },
      { label: 'Summarize this document', icon: 'list', prompt: 'Summarize the visible document page in plain language.' },
      { label: 'List the data', icon: 'table', prompt: 'List all the numbers, dates, and data visible on this PDF page.' },
      { label: 'Explain the terms', icon: 'bulb', prompt: 'Explain the key terms and sections on the visible PDF page.' },
      { label: 'Find the references', icon: 'search', prompt: 'List the citations, sources, and references visible on this PDF page.' },
    ],
  },
  {
    id: 'search',
    // No bare "google": it is a substring of unrelated hosts like
    // calendar.google.com. Search-engine result pages still match via
    // "search" / "search results" / the engine hosts below.
    keywords: ['duckduckgo', 'bing', 'yandex', 'search', 'search results', 'searched', 'wikipedia'],
    chips: [
      // Every chip here is a REAL web-search action: tapping forces web tools
      // (web: true) so the model searches and answers in the box. Labels
      // deliberately avoid the words the renderer treats as browser-search
      // intents ("search", "find", "look up", "what is"...) so they always hit
      // the LLM instead of opening a browser tab.
      { label: 'Answer this query', icon: 'search', prompt: 'Run a web search for the query the user is looking at on this page, then answer it clearly with the key facts and list the sources.', web: true },
      { label: 'Locate the download', icon: 'download', prompt: 'Run a web search for the thing the user is trying to get from this page, find the official download link (or the safest source), and report the direct link.', web: true },
      { label: 'Compare the top results', icon: 'table', prompt: 'Run a web search for the visible query, compare the top results, and summarize the best option with its URL.', web: true },
      { label: 'Refine the query', icon: 'refresh', prompt: 'Rewrite the visible search query to be more specific, run a web search with it, and list the best results with links.', web: true },
      { label: 'Verify the facts', icon: 'check', prompt: 'Run a web search and cross-check the claims or facts on this page, noting what checks out and what does not.', web: true },
    ],
  },
  {
    id: 'social',
    keywords: [
      'twitter', 'x.com', 'reddit', 'instagram', 'facebook', 'linkedin',
      'threads', 'pinterest', 'tumblr', 'social',
    ],
    chips: [
      { label: 'Draft a post', icon: 'write', prompt: 'Draft a social media post based on the visible content on screen.' },
      { label: 'Suggest a comment', icon: 'quote', prompt: 'Draft a short, natural comment responding to the visible post.' },
      { label: 'Summarize the thread', icon: 'list', prompt: 'Summarize the visible discussion thread in a few lines.' },
      { label: 'Write a reply', icon: 'mail', prompt: 'Draft a reply to the visible post, matching the way the user writes.' },
      { label: 'Extract the main point', icon: 'search', prompt: 'State the main point or takeaway of the visible post.' },
      { label: 'Brainstorm a caption', icon: 'idea', prompt: 'Suggest a few caption ideas for the visible image or post.' },
      { label: 'Review the tone', icon: 'check', prompt: 'Review the visible post and suggest how to make the tone clearer or less confrontational.' },
      { label: 'Write a thread', icon: 'write', prompt: 'Turn the visible post into a short multi-part thread that tells the story step by step.' },
    ],
  },
  {
    id: 'news',
    keywords: ['nytimes', 'bbc', 'cnn', 'reuters', 'guardian', 'news', 'msn', 'medium', 'article'],
    chips: [
      { label: 'Summarize the article', icon: 'list', prompt: 'Summarize the visible news article in a few short bullet points.' },
      { label: 'List the key facts', icon: 'check', prompt: 'List the key facts, names, and numbers in the visible article.' },
      { label: 'Explain the background', icon: 'bulb', prompt: 'Explain the context and background behind the visible news story.' },
      { label: 'Check for bias', icon: 'search', prompt: 'Note any visible bias, loaded language, or one-sided framing in the article.' },
      { label: 'Give the counterpoint', icon: 'bulb', prompt: 'Present the main counterarguments to the visible article stance.' },
      { label: 'Explain the stakes', icon: 'list', prompt: 'Explain who is affected by the visible story and what is at stake.' },
    ],
  },
  {
    id: 'shopping',
    keywords: [
      'amazon', 'ebay', 'flipkart', 'aliexpress', 'etsy', 'walmart', 'target',
      'product', 'cart', 'price', 'shop', 'best buy',
    ],
    chips: [
      { label: 'Compare prices', icon: 'search', prompt: 'Based on the visible product details, compare prices or note the current price and deals.' },
      { label: 'Summarize the reviews', icon: 'list', prompt: 'Summarize what buyers say in the visible reviews, pros and cons.' },
      { label: 'Check the specs', icon: 'table', prompt: 'List the visible product specifications and key features.' },
      { label: 'Find a better option', icon: 'bulb', prompt: 'Suggest similar products the user could compare with the visible one.' },
      { label: 'Is it worth it?', icon: 'check', prompt: 'Weigh the visible product details and reviews to say whether it seems worth the price.' },
      { label: 'Read the description', icon: 'list', prompt: 'Summarize the visible product description and what it offers.' },
      { label: 'Check the return policy', icon: 'search', prompt: 'Find and summarize the visible return, warranty, and shipping details.' },
      { label: 'Compare two items', icon: 'table', prompt: 'Compare the visible product with the obvious alternative and list the key differences.' },
    ],
  },
  {
    id: 'maps',
    keywords: ['google maps', 'maps', 'uber', 'lyft', 'ola', 'airbnb', 'booking', 'directions', 'nearby', 'yelp', 'tripadvisor'],
    chips: [
      { label: 'Get directions here', icon: 'map', prompt: 'Give step-by-step directions to the place shown on screen.' },
      { label: 'Find nearby places', icon: 'search', prompt: 'Suggest nearby restaurants, stores, or attractions based on the visible location.' },
      { label: 'Check this place', icon: 'check', prompt: 'Summarize the visible place details: name, address, rating, and hours.' },
      { label: 'Best time to go', icon: 'calendar', prompt: 'Advise the best time to visit the visible place based on the visible information.' },
      { label: 'Plan the trip', icon: 'map', prompt: 'Turn the visible travel information into a short itinerary or plan.' },
      { label: 'Compare the routes', icon: 'table', prompt: 'Compare the visible route options by time, distance, and traffic.' },
      { label: 'Check the reviews', icon: 'list', prompt: 'Summarize what the visible reviews say about this place, good and bad.' },
    ],
  },
  {
    id: 'calendar',
    keywords: ['calendar', 'meet', 'zoom', 'teams', 'schedule', 'event', 'invite', 'google calendar'],
    chips: [
      { label: 'Create an event', icon: 'calendar', prompt: 'Turn the visible text into a calendar event with a title, time, and notes.' },
      { label: 'Suggest a time', icon: 'calendar', prompt: 'Suggest good meeting times based on the visible schedule.' },
      { label: 'Summarize the day', icon: 'list', prompt: 'Summarize the visible schedule or agenda for the day.' },
      { label: 'Draft an invite', icon: 'mail', prompt: 'Draft a meeting invitation based on the visible event details.' },
      { label: 'Check for conflicts', icon: 'check', prompt: 'Look at the visible schedule and flag any overlapping events.' },
      { label: 'Reschedule this', icon: 'refresh', prompt: 'Suggest new times for the visible event and draft the reschedule message.' },
      { label: 'Write the agenda', icon: 'write', prompt: 'Draft a clear agenda for the visible meeting based on the event details.' },
    ],
  },
  {
    id: 'finance',
    keywords: [
      'bank', 'banking', 'paypal', 'stripe', 'finance', 'budget', 'statement',
      'invoice', 'transaction', 'credit', 'chase', 'hdfc', 'icici',
    ],
    chips: [
      { label: 'Explain this transaction', icon: 'bulb', prompt: 'Explain what the visible transaction is and whether it looks normal.' },
      { label: 'Summarize this statement', icon: 'list', prompt: 'Summarize the visible statement: totals, top charges, and anything unusual.' },
      { label: 'Build a budget', icon: 'table', prompt: 'Turn the visible income and spending into a simple budget plan.' },
      { label: 'Check for fraud', icon: 'search', prompt: 'Scan the visible transactions for anything suspicious or unexpected.' },
      { label: 'Explain the charges', icon: 'bulb', prompt: 'Explain the visible charges and fees in plain language.' },
      { label: 'Plan for this bill', icon: 'check', prompt: 'Break down the visible bill and suggest how to budget for the next payment.' },
      { label: 'Track the spending', icon: 'table', prompt: 'Turn the visible transactions into a clear breakdown of where money went.' },
    ],
  },
  {
    id: 'game',
    keywords: ['steam', 'epic games', 'roblox', 'minecraft', 'game', 'gameplay', 'playstation', 'xbox', 'nintendo'],
    chips: [
      { label: 'Explain this game', icon: 'bulb', prompt: 'Explain what the visible game is about based on the on-screen text.' },
      { label: 'Give me a tip', icon: 'idea', prompt: 'Give a useful tip or strategy for the visible game based on the on-screen text.' },
      { label: 'Explain the stats', icon: 'list', prompt: 'Explain the visible game stats, items, or numbers.' },
      { label: 'Summarize the quest', icon: 'list', prompt: 'Summarize the visible quest, mission, or objective in simple steps.' },
      { label: 'Check the system specs', icon: 'table', prompt: 'List the visible system requirements and note how demanding the game is.' },
      { label: 'Suggest a build', icon: 'idea', prompt: 'Suggest a loadout, build, or upgrade path based on the visible game details.' },
    ],
  },
  {
    id: 'design',
    keywords: ['figma', 'photoshop', 'illustrator', 'canva', 'dribbble', 'behance', 'design', 'sketch', 'artboard', 'pixel'],
    chips: [
      { label: 'Describe this design', icon: 'bulb', prompt: 'Describe the visible design and what it communicates.' },
      { label: 'Suggest improvements', icon: 'idea', prompt: 'Suggest specific visual improvements for the visible design.' },
      { label: 'Pick colors', icon: 'star', prompt: 'Suggest a color palette that fits the visible design.' },
      { label: 'Explain the layout', icon: 'list', prompt: 'Explain the visible layout and how the elements are arranged.' },
      { label: 'Brainstorm variations', icon: 'idea', prompt: 'Brainstorm design variations based on the visible design.' },
      { label: 'Check the spacing', icon: 'check', prompt: 'Review the visible layout and flag spacing or alignment issues.' },
      { label: 'Suggest typography', icon: 'write', prompt: 'Suggest font pairings that fit the visible design style.' },
    ],
  },
  {
    id: 'files',
    keywords: ['explorer', 'finder', 'folder', 'file', 'files', 'downloads', 'directory', 'documents'],
    chips: [
      { label: 'Explain this folder', icon: 'list', prompt: 'Summarize what the visible files and folders are and how they relate.' },
      { label: 'Suggest a filename', icon: 'write', prompt: 'Suggest a clear, descriptive name for the visible file or folder.' },
      { label: 'Find a file', icon: 'search', prompt: 'Based on the visible files, suggest which file the user is likely looking for.' },
      { label: 'Organize this', icon: 'refresh', prompt: 'Suggest how to organize the visible files into a clean structure.' },
      { label: 'Compare the files', icon: 'table', prompt: 'Compare the visible files by size, type, and modification time.' },
      { label: 'Clean up the space', icon: 'check', prompt: 'Point out visible files that look old, duplicated, or safe to remove.' },
    ],
  },
  {
    id: 'weather',
    keywords: ['weather', 'forecast', 'accuweather', 'windy', 'radar', 'temperature', 'rain', 'climate'],
    chips: [
      { label: 'Explain the forecast', icon: 'bulb', prompt: 'Explain the visible weather forecast in plain terms and what it means for the day.' },
      { label: 'Summarize the week', icon: 'list', prompt: 'Summarize the visible weekly forecast with the key highs, lows, and rain chances.' },
      { label: 'Check the radar', icon: 'map', prompt: 'Read the visible radar and explain where rain or storms are heading.' },
      { label: 'What should I wear?', icon: 'star', prompt: 'Based on the visible forecast, suggest what to wear today and whether to take an umbrella.' },
      { label: 'Compare the days', icon: 'table', prompt: 'Compare the visible forecast days and pick which look best for outdoors.' },
      { label: 'Explain the alerts', icon: 'check', prompt: 'Explain the visible weather warnings or alerts and what the user should do.' },
    ],
  },
  {
    id: 'fitness',
    keywords: ['fitness', 'workout', 'strava', 'myfitnesspal', 'fitbit', 'garmin', 'exercise', 'running', 'steps', 'calories'],
    chips: [
      { label: 'Explain my stats', icon: 'bulb', prompt: 'Explain the visible workout or health numbers and what they mean.' },
      { label: 'Build a workout', icon: 'idea', prompt: 'Suggest a workout based on the visible fitness data and goals.' },
      { label: 'Summarize my week', icon: 'list', prompt: 'Summarize the visible weekly activity: workouts, steps, and totals.' },
      { label: 'Set a goal', icon: 'check', prompt: 'Turn the visible fitness numbers into a clear, achievable weekly goal.' },
      { label: 'Explain this metric', icon: 'bulb', prompt: 'Explain what the visible metric (heart rate, pace, calories) means in plain language.' },
      { label: 'Suggest a recovery plan', icon: 'calendar', prompt: 'Based on the visible activity, suggest a light recovery day or routine.' },
    ],
  },
  {
    id: 'food',
    keywords: ['recipe', 'cooking', 'kitchen', 'ingredients', 'dinner', 'baking', 'chef', 'allrecipes', 'food network'],
    chips: [
      { label: 'Turn this into a recipe', icon: 'write', prompt: 'Turn the visible text into a clear recipe with ingredients and steps.' },
      { label: 'Suggest substitutions', icon: 'bulb', prompt: 'Suggest ingredient substitutions for the visible recipe based on what is visible.' },
      { label: 'Make a grocery list', icon: 'list', prompt: 'Turn the visible recipe ingredients into a simple grocery list.' },
      { label: 'Scale the recipe', icon: 'table', prompt: 'Scale the visible recipe for a different number of servings and rewrite the amounts.' },
      { label: 'Explain the technique', icon: 'bulb', prompt: 'Explain the visible cooking technique and why it works.' },
      { label: 'Estimate the time', icon: 'calendar', prompt: 'Estimate how long the visible recipe takes and suggest a plan to save time.' },
    ],
  },
  {
    id: 'travel',
    keywords: ['expedia', 'kayak', 'skyscanner', 'flights', 'hotel', 'booking', 'airline', 'itinerary', 'boarding pass', 'holiday'],
    chips: [
      { label: 'Compare these flights', icon: 'table', prompt: 'Compare the visible flight options by price, duration, and stops.' },
      { label: 'Summarize this itinerary', icon: 'list', prompt: 'Summarize the visible travel itinerary with dates, times, and bookings.' },
      { label: 'Explain the fare rules', icon: 'bulb', prompt: 'Explain the visible fare rules: baggage, changes, and cancellations.' },
      { label: 'List the luggage rules', icon: 'check', prompt: 'List the visible baggage allowance and restrictions for this flight.' },
      { label: 'Draft a packing list', icon: 'write', prompt: 'Draft a packing list based on the visible trip details and destination.' },
      { label: 'Check the hotel', icon: 'search', prompt: 'Summarize the visible hotel details: price, location, and what is included.' },
    ],
  },
  {
    id: 'education',
    keywords: ['coursera', 'udemy', 'edx', 'khan academy', 'duolingo', 'brilliant', 'course', 'lesson', 'quiz', 'lecture', 'homework'],
    chips: [
      { label: 'Summarize this lesson', icon: 'list', prompt: 'Summarize the visible lesson in a few clear bullet points.' },
      { label: 'Turn this into notes', icon: 'write', prompt: 'Turn the visible lesson into clean, organized study notes.' },
      { label: 'Make a study plan', icon: 'calendar', prompt: 'Turn the visible course material into a simple study schedule.' },
      { label: 'Quiz me on this', icon: 'check', prompt: 'Create a short quiz from the visible material and test the user question by question.' },
      { label: 'Explain this concept', icon: 'bulb', prompt: 'Explain the visible concept in simple, plain language with an example.' },
      { label: 'Create flashcards', icon: 'table', prompt: 'Turn the visible material into flashcards with a question on one side and an answer on the other.' },
    ],
  },
  {
    id: 'jobs',
    keywords: ['indeed', 'glassdoor', 'linkedin', 'resume', 'cv', 'cover letter', 'job', 'hiring', 'interview', 'career'],
    chips: [
      { label: 'Summarize this job', icon: 'list', prompt: 'Summarize the visible job posting: role, responsibilities, and requirements.' },
      { label: 'Draft a cover letter', icon: 'write', prompt: 'Draft a short cover letter tailored to the visible job posting.' },
      { label: 'Match my resume', icon: 'check', prompt: 'Compare the visible resume with the job requirements and note the matches and gaps.' },
      { label: 'List the requirements', icon: 'table', prompt: 'List the visible job requirements and qualifications clearly.' },
      { label: 'Prepare for the interview', icon: 'idea', prompt: 'Suggest likely interview questions based on the visible job posting.' },
      { label: 'Follow up', icon: 'mail', prompt: 'Draft a polite follow-up message to the recruiter or interviewer.' },
    ],
  },
  {
    id: 'books',
    keywords: ['kindle', 'goodreads', 'audible', 'book', 'novel', 'chapter', 'reading', 'library', 'story'],
    chips: [
      { label: 'Summarize this chapter', icon: 'list', prompt: 'Summarize the visible chapter or page in a few clear points.' },
      { label: 'Explain the characters', icon: 'bulb', prompt: 'Explain the visible characters, their roles, and their relationships.' },
      { label: 'Save a good quote', icon: 'quote', prompt: 'Find the most quotable line in the visible text and present it exactly.' },
      { label: 'Suggest similar books', icon: 'star', prompt: 'Suggest books similar to the visible one based on genre and style.' },
      { label: 'Track my reading', icon: 'check', prompt: 'Summarize the visible reading progress and estimate how long the book will take.' },
    ],
  },
  {
    id: 'investing',
    keywords: ['robinhood', 'coinbase', 'binance', 'tradingview', 'stock', 'portfolio', 'crypto', 'bitcoin', 'ethereum', 'dividend', 'etf'],
    chips: [
      { label: 'Explain this ticker', icon: 'bulb', prompt: 'Explain the visible stock or asset and its key numbers in plain language.' },
      { label: 'Summarize my portfolio', icon: 'list', prompt: 'Summarize the visible portfolio: holdings, values, and biggest movers.' },
      { label: 'Explain this coin', icon: 'bulb', prompt: 'Explain what the visible cryptocurrency is and what the visible chart shows.' },
      { label: 'Check the trend', icon: 'search', prompt: 'Describe the visible price trend and what the chart suggests.' },
      { label: 'List the risks', icon: 'check', prompt: 'Note the risks and volatility visible in this asset chart or news.' },
      { label: 'Explain this option', icon: 'table', prompt: 'Explain the visible options contract in plain language: what it gives the user and what it costs.' },
    ],
  },
  {
    id: 'sports',
    keywords: ['espn', 'nfl', 'nba', 'fifa', 'premier league', 'cricket', 'match', 'score', 'fantasy', 'stats'],
    chips: [
      { label: 'Summarize this match', icon: 'list', prompt: 'Summarize the visible match: score, key moments, and what happened.' },
      { label: 'Explain these stats', icon: 'bulb', prompt: 'Explain the visible player or team statistics in plain language.' },
      { label: 'Check the schedule', icon: 'calendar', prompt: 'Summarize the visible schedule and upcoming games or fixtures.' },
      { label: 'Pick a lineup', icon: 'idea', prompt: 'Suggest a fantasy lineup or lineup choice based on the visible stats.' },
      { label: 'Explain the rules', icon: 'bulb', prompt: 'Explain the visible rule, term, or scoring detail in simple language.' },
      { label: 'Recap the season', icon: 'list', prompt: 'Summarize the visible season results and what they mean for the team.' },
    ],
  },
  {
    id: 'home',
    keywords: ['home depot', 'ikea', 'furniture', 'diy', 'renovation', 'paint', 'decor', 'garage', 'workshop'],
    chips: [
      { label: 'Summarize this project', icon: 'list', prompt: 'Summarize the visible home project and its steps or materials.' },
      { label: 'Make a shopping list', icon: 'check', prompt: 'Turn the visible project into a shopping list of tools and materials.' },
      { label: 'Walk through the steps', icon: 'bulb', prompt: 'Explain the visible DIY steps in order and what each one does.' },
      { label: 'Estimate the cost', icon: 'table', prompt: 'Estimate the visible project cost based on the listed materials.' },
      { label: 'Suggest a layout', icon: 'idea', prompt: 'Suggest how to arrange the visible room or space based on the on-screen info.' },
    ],
  },
  {
    id: 'automotive',
    keywords: ['car', 'cars', 'autotrader', 'carmax', 'mechanic', 'vehicle', 'driving', 'fuel', 'tires'],
    chips: [
      { label: 'Compare these cars', icon: 'table', prompt: 'Compare the visible vehicles by price, specs, and condition.' },
      { label: 'Summarize this listing', icon: 'list', prompt: 'Summarize the visible car listing: price, mileage, and key features.' },
      { label: 'Explain the specs', icon: 'bulb', prompt: 'Explain the visible vehicle specifications and what they mean.' },
      { label: 'Check the value', icon: 'search', prompt: 'Assess whether the visible price looks fair based on the listed details.' },
      { label: 'List maintenance tips', icon: 'check', prompt: 'List maintenance tips relevant to the visible vehicle or warning lights.' },
    ],
  },
  {
    id: 'health',
    keywords: ['webmd', 'symptom', 'doctor', 'medication', 'prescription', 'diagnosis', 'medical', 'clinic'],
    chips: [
      { label: 'Explain this term', icon: 'bulb', prompt: 'Explain the visible medical term or condition in plain language.' },
      { label: 'Summarize this article', icon: 'list', prompt: 'Summarize the visible health article with the key points and warnings.' },
      { label: 'List the symptoms', icon: 'check', prompt: 'List the symptoms mentioned in the visible text and when to seek care.' },
      { label: 'Check the medication', icon: 'search', prompt: 'Summarize the visible medication info: dose, purpose, and common warnings.' },
      { label: 'Prepare a question list', icon: 'write', prompt: 'Turn the visible info into questions the user can ask their doctor.' },
    ],
  },
  {
    id: 'photography',
    keywords: ['lightroom', 'camera', 'photo', 'lens', 'aperture', 'exposure', 'sensor', 'photography', 'capture one'],
    chips: [
      { label: 'Explain these settings', icon: 'bulb', prompt: 'Explain the visible camera settings and what each one does.' },
      { label: 'Suggest a composition', icon: 'idea', prompt: 'Suggest composition ideas for the visible photo based on what is on screen.' },
      { label: 'Edit this photo', icon: 'write', prompt: 'Suggest specific edits for the visible photo: exposure, color, and crop.' },
      { label: 'Summarize the gear', icon: 'list', prompt: 'Summarize the visible camera or lens specs and what they are best for.' },
      { label: 'Explain this mode', icon: 'bulb', prompt: 'Explain the visible camera mode and when the user should use it.' },
    ],
  },
  {
    id: 'music-production',
    keywords: ['ableton', 'fl studio', 'logic pro', 'garageband', 'beat', 'mixing', 'vst', 'midi', 'pro tools', 'synthesizer'],
    chips: [
      { label: 'Explain this plugin', icon: 'bulb', prompt: 'Explain the visible audio plugin and what its controls do.' },
      { label: 'Suggest a mix idea', icon: 'idea', prompt: 'Suggest mix or sound design ideas based on the visible track or plugin.' },
      { label: 'Summarize the track', icon: 'list', prompt: 'Summarize the visible project or track arrangement and its sections.' },
      { label: 'Explain this knob', icon: 'bulb', prompt: 'Explain the visible audio setting and how changing it affects the sound.' },
      { label: 'Give me chord ideas', icon: 'star', prompt: 'Suggest chords or melodies that fit the visible project key or scale.' },
    ],
  },
  {
    id: 'video-editing',
    keywords: ['premiere', 'davinci', 'capcut', 'timeline', 'render', 'clip', 'export', 'after effects', 'final cut'],
    chips: [
      { label: 'Explain the timeline', icon: 'bulb', prompt: 'Explain the visible video timeline and what each track or clip is doing.' },
      { label: 'Suggest an edit', icon: 'idea', prompt: 'Suggest editing cuts, transitions, or trims for the visible footage.' },
      { label: 'Fix the export', icon: 'check', prompt: 'Troubleshoot the visible export settings or error and suggest the fix.' },
      { label: 'Summarize the footage', icon: 'list', prompt: 'Summarize what the visible clips contain and how they could be ordered.' },
      { label: 'Suggest a transition', icon: 'star', prompt: 'Suggest transition and effect ideas that fit the visible video style.' },
    ],
  },
  {
    id: 'notes',
    keywords: ['todoist', 'trello', 'asana', 'notes', 'reminder', 'checklist', 'task', 'jira', 'kanban'],
    chips: [
      { label: 'Turn this into a list', icon: 'list', prompt: 'Turn the visible text into a clean checklist or to-do list.' },
      { label: 'Summarize my tasks', icon: 'list', prompt: 'Summarize the visible tasks and highlight what is most urgent.' },
      { label: 'Prioritize these', icon: 'check', prompt: 'Rank the visible tasks by importance and suggest what to do first.' },
      { label: 'Draft a reminder', icon: 'write', prompt: 'Turn the visible note into a clear reminder message with a time.' },
      { label: 'Organize these notes', icon: 'refresh', prompt: 'Reorganize the visible notes into clear sections and headings.' },
    ],
  },
  {
    id: 'browser-tabs',
    keywords: ['tabs', 'browser', 'history', 'bookmarks', 'downloads', 'address bar', 'new tab', 'extensions'],
    chips: [
      { label: 'Summarize these tabs', icon: 'list', prompt: 'Summarize the visible open tabs and what each page is about.' },
      { label: 'Suggest a bookmark', icon: 'star', prompt: 'Suggest a clean bookmark name and folder for the visible page.' },
      { label: 'Find a download', icon: 'search', prompt: 'Find the visible download or history entry the user is looking for.' },
      { label: 'Group these tabs', icon: 'refresh', prompt: 'Suggest how to group the visible tabs into labeled groups.' },
      { label: 'Explain this extension', icon: 'bulb', prompt: 'Explain what the visible browser extension does and its permissions.' },
    ],
  },
  {
    id: 'system-settings',
    keywords: ['settings', 'control panel', 'preferences', 'update', 'driver', 'bluetooth', 'display', 'task manager', 'device manager', 'uninstall'],
    chips: [
      { label: 'Explain this setting', icon: 'bulb', prompt: 'Explain what the visible setting does and when the user should change it.' },
      { label: 'Find this option', icon: 'search', prompt: 'Explain how to reach the visible setting or option from this screen.' },
      { label: 'Suggest a fix', icon: 'check', prompt: 'Suggest a fix for the visible error, warning, or problem.' },
      { label: 'Summarize the status', icon: 'list', prompt: 'Summarize the visible system status and anything that needs attention.' },
      { label: 'Explain this process', icon: 'bulb', prompt: 'Explain what the visible process or service is and whether it is safe.' },
    ],
  },
  {
    id: 'databases',
    keywords: ['sql', 'database', 'query', 'postgres', 'mysql', 'mongodb', 'dbeaver', 'schema', 'table', 'sqlite'],
    chips: [
      { label: 'Explain this query', icon: 'bulb', prompt: 'Explain what the visible SQL query does, step by step.' },
      { label: 'Fix this query', icon: 'check', prompt: 'Find and fix the problem in the visible query or error message.' },
      { label: 'Summarize this schema', icon: 'list', prompt: 'Summarize the visible database schema and the tables and relations shown.' },
      { label: 'Suggest an index', icon: 'idea', prompt: 'Suggest which visible columns would benefit from an index.' },
      { label: 'Explain this result', icon: 'table', prompt: 'Explain what the visible query result shows and whether it looks right.' },
    ],
  },
  {
    id: 'cloud',
    keywords: ['dropbox', 'google drive', 'onedrive', 'icloud', 'sync', 'cloud', 'storage', 'backup', 'share'],
    chips: [
      { label: 'Summarize these files', icon: 'list', prompt: 'Summarize the visible cloud files and folders and what they contain.' },
      { label: 'Locate a file', icon: 'search', prompt: 'Suggest which visible cloud file the user is likely looking for.' },
      { label: 'Suggest a structure', icon: 'refresh', prompt: 'Suggest a cleaner folder structure for the visible cloud storage.' },
      { label: 'Explain the sync', icon: 'bulb', prompt: 'Explain the visible sync status or error and how to resolve it.' },
      { label: 'Draft a share note', icon: 'write', prompt: 'Draft a short message to send with the visible shared file or link.' },
    ],
  },
  {
    id: 'conferencing',
    keywords: ['zoom', 'teams', 'meet', 'webinar', 'meeting', 'video call', 'screen share', 'google meet'],
    chips: [
      { label: 'Draft the summary', icon: 'list', prompt: 'Turn the visible meeting notes or chat into a clean summary with action items.' },
      { label: 'List the attendees', icon: 'check', prompt: 'List the visible attendees and note anyone important who is missing.' },
      { label: 'Suggest action items', icon: 'check', prompt: 'Extract the action items and owners from the visible meeting text.' },
      { label: 'Summarize the meeting', icon: 'list', prompt: 'Summarize the visible meeting chat and the key questions asked.' },
      { label: 'Fix the connection', icon: 'bulb', prompt: 'Troubleshoot the visible call or connection error and suggest a fix.' },
    ],
  },
  {
    id: 'newsletters',
    keywords: ['substack', 'mailchimp', 'newsletter', 'campaign', 'subscribers', 'send', 'digest'],
    chips: [
      { label: 'Summarize this newsletter', icon: 'list', prompt: 'Summarize the visible newsletter and its main stories or sections.' },
      { label: 'Draft a welcome', icon: 'write', prompt: 'Draft a welcome email for new subscribers based on the visible content.' },
      { label: 'Suggest subject lines', icon: 'idea', prompt: 'Suggest subject lines for the visible newsletter or campaign.' },
      { label: 'List the key points', icon: 'check', prompt: 'List the key points and calls to action in the visible newsletter.' },
    ],
  },
  {
    id: 'legal',
    keywords: ['contract', 'agreement', 'terms', 'legal', 'privacy policy', 'clause', 'disclaimer', 'compliance'],
    chips: [
      { label: 'Summarize this contract', icon: 'list', prompt: 'Summarize the visible contract in plain language with the key obligations.' },
      { label: 'List the key clauses', icon: 'check', prompt: 'List the important clauses in the visible agreement: payment, term, and exit.' },
      { label: 'Explain this clause', icon: 'bulb', prompt: 'Explain the visible legal term or clause in plain language.' },
      { label: 'Flag the risks', icon: 'search', prompt: 'Flag anything risky or unusual in the visible contract text.' },
      { label: 'Draft a summary', icon: 'write', prompt: 'Write a short plain-language summary of the visible legal document.' },
    ],
  },
  {
    id: 'research',
    keywords: ['arxiv', 'pubmed', 'research', 'paper', 'journal', 'study', 'citation', 'doi', 'scholar'],
    chips: [
      { label: 'Summarize this paper', icon: 'list', prompt: 'Summarize the visible paper: question, method, and key findings.' },
      { label: 'List the findings', icon: 'check', prompt: 'List the main findings and numbers from the visible paper or abstract.' },
      { label: 'Explain the method', icon: 'bulb', prompt: 'Explain the visible research method in plain language.' },
      { label: 'Extract the citations', icon: 'link', prompt: 'List the visible references or citations from this paper.' },
      { label: 'Suggest follow-ups', icon: 'idea', prompt: 'Suggest next questions or experiments based on the visible paper.' },
    ],
  },
  {
    id: 'real-estate',
    keywords: ['zillow', 'redfin', 'realtor', 'apartment', 'house', 'mortgage', 'rental', 'for rent', 'property', 'listing'],
    chips: [
      { label: 'Summarize the property', icon: 'list', prompt: 'Summarize the visible property listing: price, size, and key features.' },
      { label: 'Compare these homes', icon: 'table', prompt: 'Compare the visible properties by price, size, and location.' },
      { label: 'Estimate the payment', icon: 'check', prompt: 'Estimate the monthly payment for the visible price based on the shown terms.' },
      { label: 'List the pros and cons', icon: 'check', prompt: 'Weigh the visible property details into pros and cons.' },
      { label: 'Draft a question', icon: 'write', prompt: 'Draft questions to ask the agent about the visible listing.' },
    ],
  },
  {
    id: 'translate',
    keywords: ['deepl', 'google translate', 'linguee', 'reverso', 'translation', 'translator', 'language'],
    chips: [
      { label: 'Check the translation', icon: 'check', prompt: 'Review the visible translation for accuracy and natural wording.' },
      { label: 'Explain this phrase', icon: 'bulb', prompt: 'Explain the meaning of the visible translated phrase and when to use it.' },
      { label: 'Compare the languages', icon: 'table', prompt: 'Compare the visible source and translated text and note any shifts in meaning.' },
      { label: 'Make it more natural', icon: 'write', prompt: 'Rewrite the visible translated text so it sounds natural to a native speaker.' },
      { label: 'Back-translate this', icon: 'refresh', prompt: 'Translate the visible text back to the source language to check the meaning held.' },
    ],
  },
];

const GENERIC_CHIPS: FallbackChip[] = [
  { label: 'Summarize this', icon: 'list', prompt: 'Summarize the visible content on screen in a few clear bullet points.' },
  { label: 'Explain this', icon: 'bulb', prompt: 'Explain what the user is looking at in simple, plain language.' },
  { label: 'Translate this', icon: 'translate', prompt: 'Translate the visible text into the language the user prefers.' },
  { label: 'Rewrite this', icon: 'write', prompt: 'Rewrite the visible text to be clearer and more natural.' },
  { label: 'Make this shorter', icon: 'refresh', prompt: 'Shorten the visible text while keeping the key points.' },
  { label: 'Brainstorm ideas', icon: 'idea', prompt: 'Brainstorm useful next steps or ideas based on the visible content.' },
  { label: 'Fix this', icon: 'check', prompt: 'Spot problems in the visible text and suggest corrections.' },
  { label: 'Find the key point', icon: 'search', prompt: 'State the single most important point in the visible content.' },
  { label: 'Compare these options', icon: 'table', prompt: 'Compare the visible options and note the trade-offs between them.' },
  { label: 'List the main points', icon: 'list', prompt: 'List the main points in the visible content, in order of importance.' },
  { label: 'Turn this into steps', icon: 'check', prompt: 'Turn the visible content into a numbered list of concrete steps.' },
  { label: 'Draft a version', icon: 'write', prompt: 'Draft an improved version of the visible text based on what is on screen.' },
  { label: 'Give me pros and cons', icon: 'table', prompt: 'List the pros and cons of the visible choice or content.' },
  { label: 'Ask about this', icon: 'bulb', prompt: 'Suggest the most useful questions to ask about the visible content.' },
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Conversation categories keep their reply chip pinned first so the reply
// guarantee (withReplyChip) still holds no matter the rotation offset. The
// calendar category pins its primary action ("Create an event") for the same
// reason — it is THE action for a calendar screen. Pins are located by label,
// not assumed to be chips[0].
const PIN_FIRST: Record<string, (chips: FallbackChip[]) => string | undefined> = {
  email: (c) => c.find((x) => isReplyChipLabel(x.label))?.label,
  chat: (c) => c.find((x) => isReplyChipLabel(x.label))?.label,
  contacts: (c) => c.find((x) => isReplyChipLabel(x.label))?.label,
  social: (c) => c.find((x) => isReplyChipLabel(x.label))?.label,
  calendar: (c) => c.find((x) => x.label === 'Create an event')?.label,
};

// Pick up to MAX_CHIPS fallback chips for the given context text (the same
// normalized context the AI sees: app line, tab, URL, conversation type, and
// the visible region text). Category hits from the app/tab/URL carry more
// weight than hits from the raw region text, so a terminal with the word
// "chat" in its output does not flip to the chat bundle.
export function fallbackChipsFor(
  contextText: string,
  opts: FallbackOptions = {},
): SuggestionChip[] {
  const text = (contextText ?? '').toLowerCase();
  if (!text.trim()) {
    return GENERIC_CHIPS.slice(0, MAX_CHIPS).map((c) => toSuggestion(smartChip(c, opts)));
  }

  const app = (text.match(/current app:\s*([^\n(]+)/) ?? [])[1]?.trim() ?? '';
  const url = (text.match(/active url:\s*(https?:\/\/[^\s]+)/) ?? [])[1]?.trim() ?? '';
  const tab = (text.match(/active tab:\s*(.+)/) ?? [])[1]?.trim() ?? '';
  const conv = (text.match(/conversation type:\s*(chat|email)/) ?? [])[1]?.trim() ?? '';
  const host = hostOf(url);
  const strong = [app, tab, conv, host, url].filter(Boolean).join(' ').toLowerCase();

  const scored = CATEGORIES.map((cat) => ({
    cat,
    score: cat.keywords.reduce(
      (n, kw) => n + (strong.includes(kw) ? 2 : text.includes(kw) ? 1 : 0),
      0,
    ),
  }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const chips: SuggestionChip[] = [];
  const seen = new Set<string>();
  const tryAdd = (chip: FallbackChip): void => {
    if (chips.length >= MAX_CHIPS || seen.has(chip.label.toLowerCase())) return;
    const smart = smartChip(chip, opts);
    if (seen.has(smart.label.toLowerCase())) return;
    seen.add(smart.label.toLowerCase());
    chips.push(toSuggestion(smart));
  };

  const offset = hashInt(text);
  for (const { cat } of scored) {
    const pinFinder = PIN_FIRST[cat.id];
    const pinChip = pinFinder ? pinFinder(cat.chips) : undefined;
    const pinIdx = pinChip ? cat.chips.findIndex((c) => c.label === pinChip) : -1;
    const ordered =
      pinIdx >= 0
        ? [cat.chips[pinIdx], ...rotate(cat.chips.filter((_, i) => i !== pinIdx), offset)]
        : rotate(cat.chips, offset);
    for (const chip of ordered) tryAdd(chip);
    if (chips.length >= MAX_CHIPS) break;
  }
  for (const chip of GENERIC_CHIPS) tryAdd(chip);

  return chips.slice(0, MAX_CHIPS);
}

// Introspection for tests and tooling: total chip count across the catalog.
export function fallbackChipCount(): number {
  const catChips = CATEGORIES.reduce((n, c) => n + c.chips.length, 0);
  return catChips + GENERIC_CHIPS.length;
}

// All catalog labels (lowercased), for uniqueness checks.
export function fallbackChipLabels(): string[] {
  return [
    ...CATEGORIES.flatMap((c) => c.chips.map((chip) => chip.label.toLowerCase())),
    ...GENERIC_CHIPS.map((chip) => chip.label.toLowerCase()),
  ];
}

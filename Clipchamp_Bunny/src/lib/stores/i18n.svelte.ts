/**
 * Central localization for the UI chrome.
 *
 * One dictionary per language, one lookup function, one persisted choice —
 * nothing is translated inside a component, so adding a language later is a
 * new dictionary and nothing else.
 *
 * Three languages ship, and only those three are *offered*:
 *
 *   · `en`       — proper English for every string in the dictionary,
 *   · `hi`       — Hindi in Devanagari,
 *   · `hinglish` — the app's own voice: English labels with romanised Hindi
 *                  sentences, which is how T9 Editor LIT has always talked
 *                  ("Trash ke records … din baad delete ho jayenge").
 *
 * `hinglish` is the default because it is what the app already says — picking
 * a language must never rewrite the product's personality by accident.
 *
 * Scope: the surfaces the profile menu, settings and the two top bars touch,
 * plus the dashboard's own headings. Editor internals (transcript rows,
 * timeline tooltips, card context menus) still speak the app's built-in
 * Hinglish — a string is only listed here once it really has all three
 * translations, so the language picker never promises a translation that does
 * not exist.
 *
 * The dashboard *greeting* has its own bank (`greeting.ts`, `en` / `hi`) and
 * keeps its own switch; `setLang` mirrors the UI choice into it.
 */

import { greeting } from './greeting.svelte';

export type UiLang = 'en' | 'hi' | 'hinglish';

/** The picker's order and native names — shown as-is in the settings tab. */
export const UI_LANGS: { id: UiLang; native: string; note: string }[] = [
  { id: 'en', native: 'English', note: 'English' },
  { id: 'hi', native: 'हिन्दी', note: 'Hindi · Devanagari' },
  { id: 'hinglish', native: 'Hinglish', note: 'Hindi in Latin script' }
];

type Dict = Record<string, string>;

const en: Dict = {
  /* ---------------------------------------------------------- profile menu */
  'profile.menu': 'Profile menu',
  'profile.open': 'Open profile menu',
  'profile.picture': 'Profile picture of {name}',
  'profile.edit': 'Edit profile',
  'profile.settings': 'App settings',
  'profile.language': 'Language',
  'profile.help': 'Help & About',
  'profile.back': 'Back',
  'profile.cancel': 'Cancel',
  'profile.name': 'Display name',
  'profile.namePlaceholder': 'Your name',
  'profile.save': 'Save',
  'profile.saved': 'Profile saved.',
  'profile.nameEmpty': 'Name cannot be empty.',
  'profile.hint': 'Stored on this PC only — nothing is uploaded.',
  'profile.photoPick': 'Choose a photo',
  'profile.photoResetBtn': 'Remove photo',
  'profile.photoSet': 'Profile photo updated.',
  'profile.photoReset': 'Back to the default photo.',
  'profile.photoBad': 'That file is not a readable image.',
  'profile.close': 'Close menu',
  'profile.crop': 'Crop your photo',

  /* ------------------------------- background (profile menu → Background) */
  'profile.background': 'Background',
  'bg.title': 'BACKGROUND',
  'bg.video': 'Choose a video…',
  'bg.image': 'Choose a wallpaper…',
  'bg.reset': 'Back to default',
  'bg.custom': 'Custom',
  'bg.default': 'Default',
  'bg.limit':
    'Up to 3 min at 1080p, no sound. 4K files are accepted - they are stored at the screen size, so nothing slows down.',
  'bg.busy': 'Preparing',
  'bg.cancel': 'Cancel',
  'bg.done': 'Background updated.',
  'bg.failed': 'That file could not be used: {reason}',
  'bg.desktopOnly': 'Custom backgrounds work in the desktop app.',

  /* ------------------------------------------------------------ settings UI */
  'set.title': 'Settings',
  'set.sub': 'Language · appearance · app behaviour',
  'set.close': 'Close (Esc)',
  'set.tab.general': 'General',
  'set.tab.language': 'Language',
  'set.tab.appearance': 'Appearance',
  'set.tab.about': 'About',

  /* general — trash */
  'set.trash.title': 'TRASH RETENTION',
  'set.trash.auto': 'Auto-delete: {value}',
  'set.trash.autoNever': 'never',
  'set.trash.days': '{n} days',
  'set.trash.desc1': 'Trash records stay recoverable for {n} days, then are removed automatically.',
  'set.trash.descNever': 'Trash records stay recoverable forever.',
  'set.trash.desc2': 'Video files always stay safe on disk — only the app record goes.',
  'set.trash.custom': 'Custom days',
  'set.trash.zero': '0 = never',
  'set.trash.clean': 'Clean expired now',
  'set.trash.cleaning': 'Cleaning…',
  'set.trash.reset': 'Reset to 12 days',
  'set.trash.browser': 'SQLite purge only runs in the desktop app.',
  'set.trash.badDays': 'Days must be a positive number (0 = never).',
  'set.trash.cleaned': '{n} expired trash records deleted — video files are safe.',
  'set.trash.cleanNone': 'No expired trash records found.',
  'set.trash.cleanFail': 'Could not clean: {e}',
  'set.trash.neverToast': 'Trash will never auto-delete.',
  'set.trash.toast': 'Trash auto-deletes after {n} days.',

  /* general — skip step */
  'set.skip.title': 'SKIP STEP',
  'set.skip.status': '{n}s forward / back',
  'set.skip.desc': 'The transport buttons and the J / L keys move the playhead this many seconds.',
  'set.skip.custom': 'Custom seconds',
  'set.skip.range': '0.5 – 60',
  'set.skip.reset': 'Reset to {n}s',
  'set.skip.bad': 'Skip step must be a positive number of seconds.',
  'set.skip.toast': 'Skip step {n}s — J / L and the transport buttons.',

  'set.time.title': 'PLAYHEAD FORMAT',
  'set.time.desc':
    'How the playhead time is written under the transport. Clicking the time still accepts m:ss.cc, h:mm:ss or plain seconds.',
  'set.time.toast': 'Playhead format: {value}',

  'set.auto.title': 'AI TRANSCRIPT',
  'set.auto.label': 'Generate a transcript automatically on import',
  'set.auto.on': 'On',
  'set.auto.off': 'Off (ask me first)',
  'set.auto.desc':
    'When a clip is imported the app can call Groq Whisper and Gemini on its own to build the transcript. Turn this off and no API call happens at all — the transcript is only produced when you press the button in the editor.',
  'set.auto.hint':
    'A transcript is saved to SQLite once made, so a source is never transcribed twice.',
  'set.autoResume.label': 'Resume an unfinished transcript when the project opens',
  'set.autoResume.on': 'On',
  'set.autoResume.off': 'Off (resume by hand)',
  'set.autoResume.desc':
    'A transcript that stopped mid-way (lost network, power cut) can continue on its own the next time its project is opened. Only a plan that has already transcribed a chunk resumes — a project that never asked for a transcript stays quiet.',
  'set.autoResume.hint':
    'The queue position lives in SQLite, so a resumed plan starts at the next missing chunk — never from zero.',

  /* language */
  'set.lang.title': 'LANGUAGE',
  'set.lang.desc': 'Menus, buttons, settings and dashboard labels switch right away.',
  'set.lang.note': 'Applied instantly and remembered on this PC.',
  'set.lang.toast': 'Language: {name}',

  /* appearance */
  'set.look.title': 'ACCENT COLOUR',
  'set.look.desc': 'Used for buttons, selections, highlights and the focus ring.',
  'set.typo.title': 'INTERFACE TYPOGRAPHY',
  'set.size.title': 'INTERFACE TEXT SIZE',
  'set.density.title': 'INTERFACE DENSITY',
  'set.panels.title': 'PANEL APPEARANCE',
  'set.panels.desc': 'Foreground panels only — the background video is never blurred or filtered.',
  'set.motion.title': 'MOTION PREFERENCE',
  'set.motion.desc': 'Reduced Motion also follows the Windows "animations off" setting.',
  'set.look.blue': 'T9 blue',
  'set.look.violet': 'Violet',
  'set.look.cyan': 'Cyan',
  'set.look.emerald': 'Emerald',
  'set.look.amber': 'Amber',
  'set.look.rose': 'Rose',
  'set.typo.clean': 'Clean',
  'set.typo.cinematic': 'Cinematic',
  'set.typo.gaming': 'Gaming',
  'set.size.sm': 'Small',
  'set.size.md': 'Default',
  'set.size.lg': 'Large',
  'set.density.compact': 'Compact',
  'set.density.comfortable': 'Comfortable',
  'set.panels.solid': 'Solid panels',
  'set.panels.translucent': 'Subtle translucent panels',
  'set.panels.minimal': 'Minimal panels',
  'set.motion.standard': 'Standard',
  'set.motion.reduced': 'Reduced Motion',
  'set.reset': 'Reset to defaults',
  'set.resetDone': 'Preferences reset to T9 defaults.',

  /* about */
  'set.about.title': 'ABOUT',
  'set.about.version': 'Version',
  'set.about.build': 'Build',
  'set.about.blurb':
    'Zero-RAM, transcript-first video cutter for long Hinglish tech tutorials. FFmpeg does the work outside the interface; nothing large is ever held in memory.',
  'set.about.help': 'Keyboard shortcuts',
  'set.about.helpHint': 'Opens the shortcut sheet.',

  /* ---------------------------------------------------------------- top bars */
  'bar.home': 'Home',
  'bar.settings': 'Settings',
  'bar.help': 'Help · keyboard shortcuts (Ctrl + /)',
  'bar.helpShort': 'Help',
  'bar.projectMenu': 'Project menu',

  /* tools panel (the 9-dots launcher) */
  'bar.tools': 'Tools & websites',
  'bar.toolsAdd': 'Pin a website',
  'bar.toolsRemove': 'Unpin',
  'bar.toolsLocked': 'built-in, cannot be removed',
  'bar.toolsName': 'Name',
  'bar.toolsUrl': 'Website URL',
  'bar.toolsPin': 'Pin',
  'bar.toolsEmpty':
    'Nothing pinned yet. Press + to add your own site — it will be remembered here.',

  /* -------------------------------------------------------------- dashboard */
  'nav.home': 'Home',
  'nav.cloud': 'T9 Cloud',
  'nav.trash': 'Trash',
  'nav.sections': 'Dashboard sections',
  'nav.search': 'Search your projects',
  'dash.subtitle': 'Pick up where you left off.',
  'dash.create': 'Create a new video',
  'dash.createHint': 'Start with a blank project',
  'dash.import': 'Import media',
  'dash.yourVideos': 'Your videos',
  'dash.recent': 'Recent projects',
  'dash.searchPlaceholder': 'Search Project...',
  'dash.noMatches': 'No matching projects',
  'dash.noMatchesSub': 'Try a different name.',
  'dash.newProject': 'New project',
  'dash.videosDesc': 'Every project you have ever opened.',
  'dash.trashDesc': 'Only the app record lives here — the video file always stays safe on disk.',
  'dash.autoDelete': 'Auto-delete',
  'dash.change': 'Change',
  'dash.trashEmpty': 'Trash is empty',
  'dash.trashEmptySub': 'No project has been removed yet.',
  'dash.restore': 'Restore',
  'dash.emptyTrash': 'Empty Trash',
  'dash.emptyTrashWarn':
    'Delete all {n} trashed project records permanently? The video files always stay safe on disk.',
  'dash.emptyTrashDone': 'Trash emptied.',
  'dash.more': 'More options',
  'dash.moreFor': 'More options for {name}',
  'dash.grid': 'Grid view',
  'dash.list': 'List view',
  'dash.loading': 'Projects are loading…',
  'dash.nothingFound': 'Nothing found',
  'dash.nothingFoundSub': 'Clear the search or start a new project.',
  'dash.noProjects': 'No projects yet',
  'dash.noProjectsSub': 'Start with Import media — or a blank project from "Create a new video".',
  'dash.openDemo': '…or open the demo recording',
  'dash.batch': 'Batch transcript',
  'dash.batchHint':
    'Queue many files and transcribe them one at a time — the position is shown per file.',

  /* --------------------------------------------------- create new project */
  'new.title': 'Create New Project',
  'new.sub': 'Set up your project and start editing.',
  'new.name': 'Project name',
  'new.untitled': 'Untitled Project',
  'new.format': 'Video format',
  'new.formatSub': 'Choose the aspect ratio for your project.',
  'new.import': 'Import media',
  'new.optional': 'Optional',
  'new.importSub': 'Start your project with media, or import later from the editor.',
  'new.pc': 'This PC',
  'new.pcSub': 'Videos, audio, images, GIFs',
  'new.link': 'Video Link',
  'new.linkSub': 'YouTube, Drive, etc.',
  'new.tg': 'Telegram',
  'new.tgSub': 'From your Telegram',
  'new.tgConnect': 'Connect first',
  'new.empty': 'Empty Project',
  'new.emptySub': 'Start from scratch',
  'new.more': 'More formats',
  'new.moreSub': '4:5, 4:3, etc.',
  'new.advanced': 'Advanced settings',
  'new.advancedSub': 'Export folder, resolution and dead air (optional)',
  'new.exportDir': 'Export folder',
  'new.exportRes': 'Resolution',
  'new.deadAir': 'Cut dead air on import',
  'new.deadAirHint':
    'FFmpeg silencedetect (desktop). Pauses longer than the gap below are marked as cut in the transcript.',
  'new.deadAirPause': 'Pause at least',
  'new.choose': 'Choose',
  'new.askEveryTime': 'Ask every time',
  'new.cancel': 'Cancel',
  'new.create': 'Create Project',
  'new.linkTitle': 'Paste a video link',
  'new.linkHint': 'yt-dlp downloads it to disk — the bytes never enter the app memory.',
  'new.linkPlaceholder': 'https://www.youtube.com/watch?v=…',
  'new.linkBack': 'Back',
  'new.busy': 'Preparing…',
  'new.ytMissing': 'yt-dlp is not installed on this machine, so link import cannot run.',
  'new.failed': 'Could not create the project',
  'new.tgStarted': 'Telegram connect is open',
  'frame.yt': 'YouTube Video',
  'frame.shorts': 'Shorts / Reels',
  'frame.square': 'Square Video',
  'frame.portrait': 'Portrait Post',
  'frame.classic': 'Classic TV',

  /* ------------------------------------------------------- t9 cloud setup */
  'cloud.titleAccent': 'Connect',
  'cloud.titleRest': 'your workspace',
  'cloud.sub': 'Set up AI services and Telegram once to unlock your workflow.',
  'cloud.progress': '{done} of {total}',
  'cloud.progressLabel': 'Setup',
  'cloud.completeSetup': 'Complete setup',
  /* the one rotating phrase near the heading */
  'cloud.rot1': 'T9 Cloud',
  'cloud.rot2': 'AI APIs',
  'cloud.rot3': 'T9 Connections',
  'cloud.rot4': 'Fast Setup',

  'cloud.gemini.name': 'Gemini API',
  'cloud.gemini.desc': 'Powers the AI analysis that flags the best moments.',
  'cloud.groq.name': 'Groq API',
  'cloud.groq.desc': 'Powers fast, accurate transcription and autocorrect.',
  'cloud.groq.engineLabel': 'Secondary engine (Groq)',
  'cloud.groq.engineOn': 'On — Groq transcribes beside ElevenLabs and feeds the accuracy merge.',
  'cloud.groq.engineOff': 'Off — ElevenLabs runs alone; no Groq fallback.',
  'cloud.groq.engineError': "Couldn't save that change.",
  'cloud.telegram.name': 'Telegram MTProto',
  'cloud.telegram.desc': 'Backs up your projects to Telegram cloud storage.',
  'cloud.telegram.manage': 'Manage connection',
  'cloud.telegram.connectedAs': 'Connected: {account}',
  'cloud.t9.name': 'T9 Cloud',
  'cloud.t9.desc': 'Coordinates the AI and Telegram services across this app.',
  'cloud.t9.version': 'Daemon version {version}',
  'cloud.t9.check': 'Check status',
  'cloud.daemonDown':
    'The T9 Cloud daemon is not running, so nothing can connect yet. It starts automatically with the app.',

  'cloud.notConnected': 'Not connected',
  'cloud.connected': 'Connected',
  'cloud.incomplete': 'Setup incomplete',
  'cloud.needsSetup': 'Setup required',

  'cloud.keyLabel': 'API key',
  'cloud.keyPlaceholder': 'Paste your API key',
  'cloud.showKey': 'Show key',
  'cloud.hideKey': 'Hide key',
  'cloud.saveTest': 'Save & test',
  'cloud.testing': 'Testing connection…',
  'cloud.testOk': 'Connection successful',
  'cloud.testFail': 'Connection failed',
  'cloud.savePending': 'Key works — saving it securely arrives with the desktop app.',
  'cloud.needBackend': 'Live connection test runs in the desktop app.',

  'cloud.scanQR': 'Scan QR code',
  'cloud.configure': 'Configure',
  'cloud.setUp': 'Set up',

  /* the ElevenLabs account pool — the primary transcriber */
  'cloud.eleven.name': 'ElevenLabs Scribe',
  'cloud.eleven.desc':
    'The primary transcription engine — this pool of accounts carries every chunk. Keys rotate on their own and each free quota is spent evenly.',
  'cloud.eleven.ensemble':
    'Accuracy mode is live: ElevenLabs and Groq both read each chunk, Gemini reconciles them.',
  'cloud.eleven.listLabel': 'ElevenLabs accounts',
  'cloud.eleven.summary': '{total} accounts · {ready} ready · {cooling} cooling',
  'cloud.eleven.loading': 'Reading the pool…',
  'cloud.eleven.empty': 'No accounts yet — paste a key below, or import an .env that lists them.',
  'cloud.eleven.state.ready': 'ready',
  'cloud.eleven.state.cooldown': 'cooling',
  'cloud.eleven.state.disabled': 'disabled',
  'cloud.eleven.cooldown': 'cooling {wait}',
  'cloud.eleven.quotaUsed': 'used',
  'cloud.eleven.removeOne': 'Remove {key}',
  'cloud.eleven.clearAll': 'Remove all accounts',
  'cloud.eleven.keyLabel': 'Add an account',
  'cloud.eleven.keyPlaceholder': 'Paste an ElevenLabs API key',
  'cloud.eleven.add': 'Add key',
  'cloud.eleven.needKey': 'Paste a key first.',
  'cloud.eleven.added': 'Key works — the account joined the pool.',
  'cloud.eleven.importLabel': 'Import from .env',
  'cloud.eleven.importPlaceholder':
    'Paste .env contents — ELEVENLABS_API_KEYS, GROQ_API_KEY and GEMINI_API_KEY are read.',
  'cloud.eleven.import': 'Import',
  'cloud.eleven.pickFile': 'Choose .env',
  'cloud.eleven.needEnv': 'Paste the .env contents or choose a file first.',
  'cloud.eleven.imported': '{added} added · {rejected} rejected · {duplicate} already in the pool',
  'cloud.eleven.network': "Couldn't reach the daemon — the request failed.",
  'cloud.eleven.refresh': 'Refresh quotas',
  'cloud.eleven.checking': 'Checking…',
  'cloud.eleven.probed': '{ok} quotas refreshed · {failed} failed',
  'cloud.eleven.enableOne': 'Enable {key}',
  'cloud.eleven.disableOne': 'Disable {key}',
  'cloud.eleven.quotaTotal': 'of pool quota used',
  'cloud.eleven.groqOffHint':
    'Groq secondary engine is off — accuracy mode is running ElevenLabs alone.',
  'cloud.eleven.enableGroq': 'Turn on Groq',

  'cloud.footer': 'Keys are used only to test each connection and are never uploaded.',

  /* -------------------------------------------------- api usage & limits */
  'usage.title': 'API usage & limits',
  'usage.open': 'Show API rate limits, usage and keys',
  'usage.close': 'Close',
  'usage.blurb': '{calls} provider calls served by this daemon.',
  'usage.lastCall': 'Last call',
  'usage.clickFor': 'Click for limits, usage and keys',
  'usage.updated': 'updated {t} ago',
  'usage.noData': 'No provider call has been recorded yet.',
  'usage.daemonDown': 'T9 Cloud daemon is not running, so there is nothing to show.',
  'usage.outdated':
    'This T9 Cloud build is older than the usage view — the next update turns the gauge on.',
  'usage.tabLimits': 'Limits',
  'usage.tabUsage': 'Usage',
  'usage.tabKeys': 'API keys',
  'usage.tabHistory': 'History',
  'usage.timeline': '30-day timeline',
  'usage.last30': 'last 30 days',
  'usage.filter': 'Engine',
  'usage.all': 'all',
  'usage.when': 'when',
  'usage.engine': 'engine',
  'usage.op': 'op',
  'usage.status': 'status',
  'usage.loading': 'loading…',
  'usage.audio': 'audio',
  'usage.ringRequests': 'requests today',
  'usage.ringTokens': 'tokens/min',
  'usage.live': 'read live from headers',
  'usage.notPublished': 'not published',
  'usage.primary': 'primary engine',
  'usage.accounts': '{n} accounts',
  'usage.elevenEmpty': 'No ElevenLabs account in the pool yet — add one on the dashboard.',
  'usage.elevenChars': 'chars this month',
  'usage.elevenNote':
    'Scribe sends no quota headers, so these bars come from the subscription probe run when each account was added or refreshed. Each free account has its own monthly character quota; the pool rotates to the next one when a quota runs out.',
  'usage.reqDay': 'Requests per day',
  'usage.tokMin': 'Tokens per minute',
  'usage.left': 'left',
  'usage.used': 'used',
  'usage.headerNote':
    'Groq sends these on every inference call and the app copies them verbatim: requests per day and tokens per minute, both as Groq defines them.',
  'usage.standbyNote':
    'Waiting for the first inference call — quota headers only arrive when a request is actually metered.',
  'usage.model': 'Model',
  'usage.planNote':
    'Free plan, quoted from console.groq.com/docs/rate-limits. Your organisation exact limits are on its Limits page.',
  'usage.geminiNote':
    'The Google API-key endpoints send no quota headers, so remaining quota cannot be read from here. The counts below are calls this app made; the limits themselves are in AI Studio.',
  'usage.today': 'Today',
  'usage.lifetime': 'Total',
  'usage.tokensOut': 'Tokens out',
  'usage.latency': 'Latency',
  'usage.errors': 'Errors',
  'usage.recent': 'Recent calls',
  'usage.recentEmpty': 'Nothing yet.',
  'usage.keyIntro':
    'Add, replace or remove the keys this daemon uses. The full key is never shown back — only its first and last characters.',
  'usage.keyPlaceholder': 'Paste a new API key',
  'usage.keySave': 'Save',
  'usage.keyRemove': 'Remove',
  'usage.keySaved': 'Key saved — the daemon is using it right now.',
  'usage.keyRemoved': 'Key removed.',
  'usage.keySaveFailed': 'Could not save that key.',
  'usage.keyStorage': 'Stored beside .env, written only by this app:',

  /* Telegram login modal */
  'cloud.tg.modalTitle': 'Link Telegram',
  'cloud.tg.modalDesc':
    'Scan the code with your phone to connect Telegram as secure cloud storage.',
  'cloud.tg.close': 'Close',
  'cloud.tg.scan': 'Scan QR code',
  'cloud.tg.waiting': 'Waiting for the scan…',
  'cloud.tg.open': 'Open Telegram',
  'cloud.tg.done': 'Telegram connected',
  'cloud.tg.notReady':
    'The desktop app connects Telegram once credentials are configured. QR login is available in the installed app.',
  'cloud.tg.offline': 'The T9 Cloud daemon is not running.',
  'cloud.tg.expired': 'That code expired — generate a new one.',
  'cloud.tg.failed': 'Login failed. Try again.',
  'cloud.tg.retry': 'Try again'
};

const hinglish: Dict = {
  /* ---------------------------------------------------------- profile menu */
  'profile.crop': 'Photo ka crop karo',

  /* ------------------------------- background (profile menu → Background) */
  'profile.background': 'Background',
  'bg.title': 'BACKGROUND',
  'bg.video': 'Video chuno…',
  'bg.image': 'Wallpaper chuno…',
  'bg.reset': 'Default pe wapas',
  'bg.custom': 'Custom',
  'bg.default': 'Default',
  'bg.limit':
    'Video 3 minute tak, 1080p, bina awaaz. 4K file bhi chalti hai - app use screen ke size me rakhta hai, isliye kuch slow nahi hota.',
  'bg.busy': 'Taiyaar ho raha hai',
  'bg.cancel': 'Cancel',
  'bg.done': 'Background badal gaya.',
  'bg.failed': 'Ye file use nahi ho payi: {reason}',
  'bg.desktopOnly': 'Custom background sirf desktop app me chalta hai.',

  /* ------------------------------------------------------------ settings UI */
  'set.title': 'Settings',
  'set.sub': 'Language · appearance · app behaviour',
  'set.close': 'Close (Esc)',
  'set.tab.general': 'General',
  'set.tab.language': 'Language',
  'set.tab.appearance': 'Appearance',
  'set.tab.about': 'About',

  'set.trash.title': 'TRASH RETENTION',
  'set.trash.auto': 'Auto-delete: {value}',
  'set.trash.autoNever': 'kabhi nahi',
  'set.trash.days': '{n} din',
  'set.trash.desc1':
    'Trash ke records {n} din tak recoverable rahenge, phir khud delete ho jayenge.',
  'set.trash.descNever': 'Trash ke records hamesha recoverable rahenge.',
  'set.trash.desc2': 'Video files disk pe hamesha safe rahengi — sirf app ka record hatta hai.',
  'set.trash.custom': 'Custom days',
  'set.trash.zero': '0 = kabhi nahi',
  'set.trash.clean': 'Clean expired now',
  'set.trash.cleaning': 'Cleaning…',
  'set.trash.reset': 'Reset to 12 days',
  'set.trash.browser': 'Desktop app me hi SQLite purge chalega.',
  'set.trash.badDays': 'Days ek positive number hona chahiye (0 = kabhi nahi).',
  'set.trash.cleaned': '{n} purana trash record delete ho gaya — video files safe hain.',
  'set.trash.cleanNone': 'Koi expired trash record nahi mila.',
  'set.trash.cleanFail': 'Clean nahi hua: {e}',
  'set.trash.neverToast': 'Trash kabhi auto-delete nahi hoga.',
  'set.trash.toast': 'Trash {n} din baad auto-delete hoga.',

  'set.skip.title': 'SKIP STEP',
  'set.skip.status': '{n}s forward / back',
  'set.skip.desc': 'Transport ke ⏪ ⏩ buttons aur J / L keys itne seconds move karte hain.',
  'set.skip.custom': 'Custom seconds',
  'set.skip.range': '0.5 – 60',
  'set.skip.reset': 'Reset to {n}s',
  'set.skip.bad': 'Skip step positive number hona chahiye (seconds).',
  'set.skip.toast': 'Skip step {n}s — J / L aur transport buttons.',

  'set.time.title': 'PLAYHEAD FORMAT',
  'set.time.desc':
    'Playhead ka time transport ke neeche kaise likha jaye. Time pe click karke m:ss.cc, h:mm:ss ya plain seconds ab bhi type kar sakte ho.',
  'set.time.toast': 'Playhead format: {value}',

  'set.auto.title': 'AI TRANSCRIPT',
  'set.auto.label': 'Import karte hi apne aap transcript banao',
  'set.auto.on': 'On',
  'set.auto.off': 'Off (pehle poochho)',
  'set.auto.desc':
    ' Clip import hote hi app khud Groq Whisper + Gemini API call karke transcript bana sakti hai. Band karo to koi API call nahi hoti — transcript sirf editor me button dabane pe banta hai.',
  'set.auto.hint':
    'Transcript ek baar ban gaya to SQLite me save — dobara kabhi transcribe nahi hoga.',
  'set.autoResume.label': 'Project kholte hi adhoora transcript aage badhao',
  'set.autoResume.on': 'On',
  'set.autoResume.off': 'Off (khud se chalao)',
  'set.autoResume.desc':
    'Beech me ruka transcript (network gaya, power cut) agli baar project kholne par khud aage badh sakta hai. Sirf wahi plan resume hota hai jisme pehle se ek chunk ho chuka hai — jis project me transcript maanga hi nahi gaya, wo chup rehta hai.',
  'set.autoResume.hint':
    'Queue position SQLite me hai, isliye resume agle missing chunk se shuru hota hai — zero se nahi.',

  'set.lang.title': 'LANGUAGE',
  'set.lang.desc': 'Menus, buttons, settings aur dashboard ke labels turant badal jaate hain.',
  'set.lang.note': 'Lagte hi apply ho jaata hai aur is PC pe yaad rehta hai.',
  'set.lang.toast': 'Language: {name}',

  'set.look.title': 'ACCENT COLOUR',
  'set.look.desc': 'Buttons, selection, highlights aur focus ring me use hoti hai.',
  'set.typo.title': 'INTERFACE TYPOGRAPHY',
  'set.size.title': 'INTERFACE TEXT SIZE',
  'set.density.title': 'INTERFACE DENSITY',
  'set.panels.title': 'PANEL APPEARANCE',
  'set.panels.desc': 'Sirf foreground panels — background video kabhi blur ya filter nahi hota.',
  'set.motion.title': 'MOTION PREFERENCE',
  'set.motion.desc': 'Reduced Motion Windows ke "animations off" setting ko bhi follow karta hai.',
  'set.look.blue': 'T9 blue',
  'set.look.violet': 'Violet',
  'set.look.cyan': 'Cyan',
  'set.look.emerald': 'Emerald',
  'set.look.amber': 'Amber',
  'set.look.rose': 'Rose',
  'set.typo.clean': 'Clean',
  'set.typo.cinematic': 'Cinematic',
  'set.typo.gaming': 'Gaming',
  'set.size.sm': 'Small',
  'set.size.md': 'Default',
  'set.size.lg': 'Large',
  'set.density.compact': 'Compact',
  'set.density.comfortable': 'Comfortable',
  'set.panels.solid': 'Solid panels',
  'set.panels.translucent': 'Subtle translucent panels',
  'set.panels.minimal': 'Minimal panels',
  'set.motion.standard': 'Standard',
  'set.motion.reduced': 'Reduced Motion',
  'set.reset': 'Reset to defaults',
  'set.resetDone': 'Preferences T9 defaults pe reset ho gaye.',

  'set.about.title': 'ABOUT',
  'set.about.version': 'Version',
  'set.about.build': 'Build',
  'set.about.blurb':
    'Lambi Hinglish tech tutorials ke liye zero-RAM, transcript-first video cutter. FFmpeg bahar kaam karta hai — memory me kabhi kuch bada nahi rehta.',
  'set.about.help': 'Keyboard shortcuts',
  'set.about.helpHint': 'Shortcut sheet kholta hai.',

  /* ---------------------------------------------------------------- top bars */
  'bar.home': 'Home',
  'bar.settings': 'Settings',
  'bar.help': 'Help · keyboard shortcuts (Ctrl + /)',
  'bar.helpShort': 'Help',
  'bar.projectMenu': 'Project menu',

  /* tools panel (the 9-dots launcher) */
  'bar.tools': 'Tools & websites',
  'bar.toolsAdd': 'Website pin karo',
  'bar.toolsRemove': 'Pin hatao',
  'bar.toolsLocked': 'built-in hai, hataya nahi ja sakta',
  'bar.toolsName': 'Naam',
  'bar.toolsUrl': 'Website URL',
  'bar.toolsPin': 'Pin karo',
  'bar.toolsEmpty':
    'Abhi tak kuch pin nahi hai. + dabao aur apni site add karo — yahin save ho jayegi.',

  /* -------------------------------------------------------------- dashboard */
  'nav.home': 'Home',
  'nav.cloud': 'T9 Cloud',
  'nav.trash': 'Trash',
  'nav.sections': 'Dashboard sections',
  'nav.search': 'Search your projects',
  'dash.subtitle': 'Jahan chhoda tha, wahin se aage.',
  'dash.create': 'Create a new video',
  'dash.createHint': 'Start with a blank project',
  'dash.import': 'Import media',
  'dash.yourVideos': 'Your videos',
  'dash.recent': 'Recent projects',
  'dash.searchPlaceholder': 'Project search karo...',
  'dash.noMatches': 'Koi project match nahi hua',
  'dash.noMatchesSub': 'Koi doosra naam try karo.',
  'dash.newProject': 'New project',
  'dash.videosDesc': 'Har project jo aapne kabhi khola.',
  'dash.trashDesc':
    'Yahan sirf app ka record rakha hai — video file hamesha disk pe safe rehta hai.',
  'dash.autoDelete': 'Auto-delete',
  'dash.change': 'Change',
  'dash.trashEmpty': 'Trash khaali hai',
  'dash.trashEmptySub': 'Koi project remove nahi kiya gaya.',
  'dash.restore': 'Restore',
  'dash.emptyTrash': 'Empty Trash',
  'dash.emptyTrashWarn':
    '{n} delete ho gaya — permanently? Video files hamesha disk pe safe rehte hain.',
  'dash.emptyTrashDone': 'Trash empty ho gaya.',
  'dash.more': 'More options',
  'dash.moreFor': '{name} ke liye options',
  'dash.grid': 'Grid view',
  'dash.list': 'List view',
  'dash.loading': 'Projects load ho rahe hain…',
  'dash.nothingFound': 'Kuch nahi mila',
  'dash.nothingFoundSub': 'Search hatao ya naya project banao.',
  'dash.noProjects': 'Abhi koi project nahi hai',
  'dash.noProjectsSub': 'Import media se shuru karo — ya "Create a new video" se ek blank project.',
  'dash.openDemo': '…ya demo recording kholo',
  'dash.batch': 'Batch transcript',
  'dash.batchHint':
    'Ek saath bahut files queue karo — ek waqt me ek transcribe hogi, position har file ke saamne dikhegi.',

  /* --------------------------------------------------- create new project */
  'new.title': 'Naya Project Banao',
  'new.sub': 'Project set karo aur editing shuru karo.',
  'new.name': 'Project ka naam',
  'new.untitled': 'Untitled Project',
  'new.format': 'Video format',
  'new.formatSub': 'Apne project ka aspect ratio chuno.',
  'new.import': 'Media import karo',
  'new.optional': 'Optional',
  'new.importSub': 'Media ke saath shuru karo, ya baad me editor se import karo.',
  'new.pc': 'This PC',
  'new.pcSub': 'Videos, audio, images, GIFs',
  'new.link': 'Video Link',
  'new.linkSub': 'YouTube, Drive, waghairah',
  'new.tg': 'Telegram',
  'new.tgSub': 'Aapke Telegram se',
  'new.tgConnect': 'Pehle connect karo',
  'new.empty': 'Khaali Project',
  'new.emptySub': 'Zero se shuru karo',
  'new.more': 'Aur formats',
  'new.moreSub': '4:5, 4:3, waghairah',
  'new.advanced': 'Advanced settings',
  'new.advancedSub': 'Export folder, resolution aur dead air (optional)',
  'new.exportDir': 'Export folder',
  'new.exportRes': 'Resolution',
  'new.deadAir': 'Import par dead air cut karo',
  'new.deadAirHint':
    'FFmpeg silencedetect (desktop). Neeche wale gap se lambi khamoshi transcript me cut mark hoti hai.',
  'new.deadAirPause': 'Pause kam se kam',
  'new.choose': 'Chuno',
  'new.askEveryTime': 'Har baar poochho',
  'new.cancel': 'Cancel',
  'new.create': 'Project banao',
  'new.linkTitle': 'Video ka link paste karo',
  'new.linkHint': 'yt-dlp ise disk pe download karta hai — file app ki memory me nahi aati.',
  'new.linkPlaceholder': 'https://www.youtube.com/watch?v=…',
  'new.linkBack': 'Wapas',
  'new.busy': 'Taiyaar ho raha hai…',
  'new.ytMissing': 'Is machine pe yt-dlp installed nahi hai, isliye link import nahi chalega.',
  'new.failed': 'Project nahi ban paaya',
  'new.tgStarted': 'Telegram connect khul gaya',
  'frame.yt': 'YouTube Video',
  'frame.shorts': 'Shorts / Reels',
  'frame.square': 'Square Video',
  'frame.portrait': 'Portrait Post',
  'frame.classic': 'Classic TV',

  /* ------------------------------------------------------- t9 cloud setup */
  'cloud.titleAccent': 'Connect',
  'cloud.titleRest': 'karo',
  'cloud.sub': 'AI services aur Telegram ek baar setup karo, apna workflow unlock ho jayega.',
  'cloud.progress': '{done} of {total}',
  'cloud.progressLabel': 'Setup',
  'cloud.completeSetup': 'Complete setup',
  'cloud.rot1': 'T9 Cloud',
  'cloud.rot2': 'AI APIs',
  'cloud.rot3': 'T9 Connections',
  'cloud.rot4': 'Fast Setup',

  'cloud.gemini.name': 'Gemini API',
  'cloud.gemini.desc': 'AI analysis ke liye — best moments flag karta hai.',
  'cloud.groq.name': 'Groq API',
  'cloud.groq.desc': 'Fast transcription aur autocorrect yahin se chalta hai.',
  'cloud.groq.engineLabel': 'Secondary engine (Groq)',
  'cloud.groq.engineOn':
    'On — Groq ElevenLabs ke saath transcribe karta hai aur accuracy merge feed karta hai.',
  'cloud.groq.engineOff': 'Off — sirf ElevenLabs chalega; Groq fallback nahi.',
  'cloud.groq.engineError': 'Ye change save nahi ho paya.',
  'cloud.telegram.name': 'Telegram MTProto',
  'cloud.telegram.desc': 'Projects ko Telegram cloud storage me backup karta hai.',
  'cloud.t9.name': 'T9 Cloud',
  'cloud.t9.desc': 'AI aur Telegram services ko is app me coordinate karta hai.',
  'cloud.t9.version': 'Daemon version {version}',
  'cloud.t9.check': 'Status check karo',
  'cloud.daemonDown':
    'T9 Cloud daemon chal nahi raha, isliye abhi kuch connect nahi ho sakta. App ke saath apne aap chalu hota hai.',
  'cloud.telegram.manage': 'Connect manage karo',
  'cloud.telegram.connectedAs': 'Connected: {account}',

  'cloud.notConnected': 'Connected nahi',
  'cloud.connected': 'Connected',
  'cloud.incomplete': 'Setup adhoora hai',
  'cloud.needsSetup': 'Setup chahiye',

  'cloud.keyLabel': 'API key',
  'cloud.keyPlaceholder': 'Apni API key paste karo',
  'cloud.showKey': 'Key dikhao',
  'cloud.hideKey': 'Key chhupao',
  'cloud.saveTest': 'Save & test',
  'cloud.testing': 'Connection test ho raha hai…',
  'cloud.testOk': 'Connection saaf',
  'cloud.testFail': 'Connection fail',
  'cloud.savePending':
    'Key kaam kar rahi hai — ise securely save karna desktop app ke saath aayega.',
  'cloud.needBackend': 'Live connection test desktop app me chalega.',

  'cloud.scanQR': 'QR code scan karo',
  'cloud.configure': 'Configure karo',
  'cloud.setUp': 'Setup karo',

  /* the ElevenLabs account pool — the primary transcriber */
  'cloud.eleven.name': 'ElevenLabs Scribe',
  'cloud.eleven.desc':
    'Primary transcription engine — pool ke accounts har chunk uthate hain. Keys apni aap rotate hoti hain, free quota barabar kharch hota hai.',
  'cloud.eleven.ensemble':
    'Accuracy mode chalu: ElevenLabs aur Groq dono har chunk padhte hain, Gemini dono ko milata hai.',
  'cloud.eleven.listLabel': 'ElevenLabs accounts',
  'cloud.eleven.summary': '{total} accounts · {ready} ready · {cooling} cooling',
  'cloud.eleven.loading': 'Pool padha ja raha hai…',
  'cloud.eleven.empty': 'Abhi koi account nahi — neeche key paste karo, ya .env import kar lo.',
  'cloud.eleven.state.ready': 'ready',
  'cloud.eleven.state.cooldown': 'thoda ruka',
  'cloud.eleven.state.disabled': 'band',
  'cloud.eleven.cooldown': '{wait} baad',
  'cloud.eleven.quotaUsed': 'used',
  'cloud.eleven.removeOne': '{key} hatao',
  'cloud.eleven.clearAll': 'Sab accounts hatao',
  'cloud.eleven.keyLabel': 'Account add karo',
  'cloud.eleven.keyPlaceholder': 'ElevenLabs API key paste karo',
  'cloud.eleven.add': 'Key add karo',
  'cloud.eleven.needKey': 'Pehle key paste karo.',
  'cloud.eleven.added': 'Key kaam kar rahi — account pool me aa gaya.',
  'cloud.eleven.importLabel': '.env se import',
  'cloud.eleven.importPlaceholder':
    '.env paste karo — ELEVENLABS_API_KEYS, GROQ_API_KEY aur GEMINI_API_KEY padhe jayenge.',
  'cloud.eleven.import': 'Import karo',
  'cloud.eleven.pickFile': '.env chuno',
  'cloud.eleven.needEnv': 'Pehle .env paste karo ya file chuno.',
  'cloud.eleven.imported': '{added} add · {rejected} reject · {duplicate} pehle se',
  'cloud.eleven.network': 'Daemon tak nahi pahuncha — request fail ho gayi.',
  'cloud.eleven.refresh': 'Quota refresh karo',
  'cloud.eleven.checking': 'Check ho raha…',
  'cloud.eleven.probed': '{ok} quotas refresh · {failed} fail',
  'cloud.eleven.enableOne': '{key} enable karo',
  'cloud.eleven.disableOne': '{key} disable karo',
  'cloud.eleven.quotaTotal': 'pool quota used',
  'cloud.eleven.groqOffHint':
    'Groq secondary engine off hai — accuracy mode sirf ElevenLabs chala raha hai.',
  'cloud.eleven.enableGroq': 'Groq on karo',

  'cloud.footer': 'Keys sirf har connection test ke liye use hoti hain, kahin upload nahi hoti.',

  /* -------------------------------------------------- api usage & limits */
  'usage.title': 'API usage aur limits',
  'usage.open': 'API rate limit, usage aur keys dikhao',
  'usage.close': 'Band karo',
  'usage.blurb': 'Is daemon ne abhi tak {calls} provider call serve ki hain.',
  'usage.lastCall': 'Last call',
  'usage.clickFor': 'Click karo — limits, usage aur keys',
  'usage.updated': '{t} pehle update hua',
  'usage.noData': 'Abhi tak koi provider call record nahi hui.',
  'usage.daemonDown': 'T9 Cloud daemon chal nahi raha, isliye kuch dikhane ko nahi hai.',
  'usage.outdated':
    'Ye T9 Cloud build usage view se purana hai — agla update gauge chalu kar dega.',
  'usage.tabLimits': 'Limits',
  'usage.tabUsage': 'Usage',
  'usage.tabKeys': 'API keys',
  'usage.tabHistory': 'History',
  'usage.timeline': '30-day timeline',
  'usage.last30': 'last 30 days',
  'usage.filter': 'Engine',
  'usage.all': 'all',
  'usage.when': 'when',
  'usage.engine': 'engine',
  'usage.op': 'op',
  'usage.status': 'status',
  'usage.loading': 'loading…',
  'usage.audio': 'audio',
  'usage.ringRequests': 'requests aaj',
  'usage.ringTokens': 'tokens/min',
  'usage.live': 'headers se live',
  'usage.notPublished': 'publish nahi hota',
  'usage.primary': 'primary engine',
  'usage.accounts': '{n} accounts',
  'usage.elevenEmpty': 'Pool me abhi koi ElevenLabs account nahi — dashboard par add karo.',
  'usage.elevenChars': 'chars is mahine',
  'usage.elevenNote':
    'Scribe quota headers bhejta hi nahi, isliye ye bars subscription probe se aate hain jo account add/refresh hue waqt chala tha. Har free account ki apni monthly character quota hoti hai — ek khatam hone par pool agle account par chala jaata hai.',
  'usage.reqDay': 'Requests per day',
  'usage.tokMin': 'Tokens per minute',
  'usage.left': 'bache',
  'usage.used': 'use hue',
  'usage.headerNote':
    'Groq har inference call ke saath ye headers bhejta hai aur app ise copy karta hai: requests per day aur tokens per minute — dono Groq ke apne definition se.',
  'usage.standbyNote':
    'Pehle inference call ka wait hai — quota headers tabhi aate hain jab request sach me count ho.',
  'usage.model': 'Model',
  'usage.planNote':
    'Free plan, console.groq.com/docs/rate-limits se. Tumhare organisation ki exact limits uski Limits page par hain.',
  'usage.geminiNote':
    'Google ke API-key endpoints quota headers bhejte hi nahi, isliye Gemini ki remaining quota yahan se padhi nahi ja sakti. Niche ke count app ke apne hain; limits AI Studio me milti hain.',
  'usage.today': 'Aaj',
  'usage.lifetime': 'Kul',
  'usage.tokensOut': 'Tokens out',
  'usage.latency': 'Latency',
  'usage.errors': 'Errors',
  'usage.recent': 'Recent calls',
  'usage.recentEmpty': 'Abhi kuch nahi.',
  'usage.keyIntro':
    'Is daemon ki keys yahan se add, replace ya remove karo. Poori key kabhi wapas nahi dikhti — sirf pehle aur aakhir characters.',
  'usage.keyPlaceholder': 'Naya API key paste karo',
  'usage.keySave': 'Save',
  'usage.keyRemove': 'Hatao',
  'usage.keySaved': 'Key save ho gayi — daemon abhi isse use kar raha hai.',
  'usage.keyRemoved': 'Key hata di gayi.',
  'usage.keySaveFailed': 'Key save nahi ho payi.',
  'usage.keyStorage': 'Ke .env ke saath rakhi gayi hai, sirf is app se likhi jati hai:',

  /* Telegram login modal */
  'cloud.tg.modalTitle': 'Telegram link karo',
  'cloud.tg.modalDesc':
    'Phone se code scan karke Telegram ko secure cloud storage ki tarah connect karo.',
  'cloud.tg.close': 'Band karo',
  'cloud.tg.scan': 'QR code scan karo',
  'cloud.tg.waiting': 'Scan ka wait ho raha hai…',
  'cloud.tg.open': 'Telegram kholo',
  'cloud.tg.done': 'Telegram connected',
  'cloud.tg.notReady':
    'Desktop app Telegram tab connect karta hai jab credentials set ho. QR login installed app me milega.',
  'cloud.tg.offline': 'T9 Cloud daemon chal nahi raha.',
  'cloud.tg.expired': 'Code expire ho gaya — naya banao.',
  'cloud.tg.failed': 'Login fail ho gaya. Dobara try karo.',
  'cloud.tg.retry': 'Dobara try karo'
};

const hi: Dict = {
  /* ---------------------------------------------------------- profile menu */
  'profile.menu': 'प्रोफ़ाइल मेनू',
  'profile.open': 'प्रोफ़ाइल मेनू खोलें',
  'profile.picture': '{name} की प्रोफ़ाइल तस्वीर',
  'profile.edit': 'प्रोफ़ाइल संपादित करें',
  'profile.settings': 'ऐप सेटिंग्स',
  'profile.language': 'भाषा',
  'profile.help': 'सहायता और परिचय',
  'profile.back': 'वापस',
  'profile.cancel': 'रद्द करें',
  'profile.name': 'दिखाने का नाम',
  'profile.namePlaceholder': 'आपका नाम',
  'profile.save': 'सहेजें',
  'profile.saved': 'प्रोफ़ाइल सहेज दी गई.',
  'profile.nameEmpty': 'नाम खाली नहीं हो सकता.',
  'profile.hint': 'सिर्फ़ इस PC पर सहेजा जाता है — कुछ भी अपलोड नहीं होता.',
  'profile.photoPick': 'फ़ोटो चुनें',
  'profile.photoResetBtn': 'फ़ोटो हटाएँ',
  'profile.photoSet': 'प्रोफ़ाइल फ़ोटो अपडेट हो गई.',
  'profile.photoReset': 'डिफ़ॉल्ट फ़ोटो पर वापस.',
  'profile.photoBad': 'यह फ़ाइल मान्य इमेज नहीं है.',
  'profile.close': 'मेनू बंद करें',
  'profile.crop': 'फ़ोटो काटें',

  /* ------------------------------- background (profile menu → Background) */
  'profile.background': 'बैकग्राउंड',
  'bg.title': 'बैकग्राउंड',
  'bg.video': 'वीडियो चुनें…',
  'bg.image': 'वॉलपेपर चुनें…',
  'bg.reset': 'डिफ़ॉल्ट पर वापस',
  'bg.custom': 'कस्टम',
  'bg.default': 'डिफ़ॉल्ट',
  'bg.limit':
    'वीडियो 3 मिनट तक, 1080p, बिना आवाज़। 4K फ़ाइल भी चलती है — ऐप उसे स्क्रीन के साइज़ में रखता है, इसलिए कुछ धीमा नहीं होता।',
  'bg.busy': 'तैयार हो रहा है',
  'bg.cancel': 'रद्द करें',
  'bg.done': 'बैकग्राउंड बदल गया.',
  'bg.failed': 'यह फ़ाइल इस्तेमाल नहीं हो सकी: {reason}',
  'bg.desktopOnly': 'कस्टम बैकग्राउंड सिर्फ़ डेस्कटॉप ऐप में चलता है.',

  /* ------------------------------------------------------------ settings UI */
  'set.title': 'सेटिंग्स',
  'set.sub': 'भाषा · रूप · ऐप का व्यवहार',
  'set.close': 'बंद करें (Esc)',
  'set.tab.general': 'सामान्य',
  'set.tab.language': 'भाषा',
  'set.tab.appearance': 'रूप',
  'set.tab.about': 'परिचय',

  'set.trash.title': 'ट्रैश अवधि',
  'set.trash.auto': 'ऑटो-डिलीट: {value}',
  'set.trash.autoNever': 'कभी नहीं',
  'set.trash.days': '{n} दिन',
  'set.trash.desc1': 'ट्रैश रिकॉर्ड {n} दिन तक वापस पाए जा सकते हैं, फिर अपने आप हट जाते हैं.',
  'set.trash.descNever': 'ट्रैश रिकॉर्ड हमेशा वापस पाए जा सकते हैं.',
  'set.trash.desc2':
    'वीडियो फ़ाइलें डिस्क पर हमेशा सुरक्षित रहती हैं — सिर्फ़ ऐप का रिकॉर्ड हटता है.',
  'set.trash.custom': 'कस्टम दिन',
  'set.trash.zero': '0 = कभी नहीं',
  'set.trash.clean': 'अभी साफ़ करें',
  'set.trash.cleaning': 'साफ़ हो रहा है…',
  'set.trash.reset': '12 दिन पर रीसेट',
  'set.trash.browser': 'SQLite प्यूर्जी सिर्फ़ डेस्कटॉप ऐप में चलेगी.',
  'set.trash.badDays': 'दिन एक सकारात्मक संख्या होनी चाहिए (0 = कभी नहीं).',
  'set.trash.cleaned': '{n} पुराना ट्रैश रिकॉर्ड हटा — वीडियो फ़ाइलें सुरक्षित हैं.',
  'set.trash.cleanNone': 'कोई समाप्त ट्रैश रिकॉर्ड नहीं मिला.',
  'set.trash.cleanFail': 'साफ़ नहीं हुआ: {e}',
  'set.trash.neverToast': 'ट्रैश कभी ऑटो-डिलीट नहीं होगा.',
  'set.trash.toast': 'ट्रैश {n} दिन बाद ऑटो-डिलीट होगा.',

  'set.skip.title': 'स्किप स्टेप',
  'set.skip.status': '{n} सेकंड आगे / पीछे',
  'set.skip.desc': 'ट्रांसपोर्ट बटन और J / L कुंजियाँ प्लेहेड को इतने सेकंड चलाती हैं.',
  'set.skip.custom': 'कस्टम सेकंड',
  'set.skip.range': '0.5 – 60',
  'set.skip.reset': '{n} सेकंड पर रीसेट',

  'set.auto.title': 'AI ट्रांसक्रिप्ट',
  'set.auto.label': 'इंपोर्ट करते ही अपने-आप ट्रांसक्रिप्ट बनाएँ',
  'set.auto.on': 'चालू',
  'set.auto.off': 'बंद (पहले पूछें)',
  'set.auto.desc':
    ' क्लिप इंपोर्ट होते ही ऐप अपने-आप Groq Whisper + Gemini API कॉल करके ट्रांसक्रिप्ट बना सकती है। बंद करने पर कोई API कॉल नहीं होती — ट्रांसक्रिप्ट सिर्फ़ एडिटर में बटन दबाने पर बनता है।',
  'set.auto.hint':
    'ट्रांसक्रिप्ट एक बार बन जाने पर SQLite में सेव हो जाता है — दोबारा कभी transcribe नहीं होगा.',
  'set.autoResume.label': 'प्रोजेक्ट खोलते ही अधूरा ट्रांसक्रिप्ट आगे बढ़ाएँ',
  'set.autoResume.on': 'चालू',
  'set.autoResume.off': 'बंद (खुद से चलाएँ)',
  'set.autoResume.desc':
    'बीच में रुका ट्रांसक्रिप्ट (नेटवर्क गया, बिजली गई) अगली बार प्रोजेक्ट खोलने पर अपने-आप आगे बढ़ सकता है। सिर्फ़ वही प्लान रिज़्यूम होता है जिसमें पहले से एक चंक हो चुका है — जिस प्रोजेक्ट में ट्रांसक्रिप्ट माँगा ही नहीं गया, वह शांत रहता है।',
  'set.autoResume.hint':
    'क्यू की स्थिति SQLite में है, इसलिए रिज़्यूम अगले मिसिंग चंक से शुरू होता है — शून्य से नहीं.',
  'set.skip.bad': 'स्किप स्टेप एक सकारात्मक संख्या होनी चाहिए (सेकंड).',
  'set.skip.toast': 'स्किप स्टेप {n} सेकंड — J / L और ट्रांसपोर्ट बटन.',

  'set.time.title': 'प्लेहेड फ़ॉर्मेट',
  'set.time.desc':
    'ट्रांसपोर्ट के नीचे प्लेहेड का समय कैसे लिखा जाए। समय पर क्लिक करके m:ss.cc, h:mm:ss या सामान्य सेकंड अब भी टाइप कर सकते हैं।',
  'set.time.toast': 'प्लेहेड फ़ॉर्मेट: {value}',

  'set.lang.title': 'भाषा',
  'set.lang.desc': 'मेनू, बटन, सेटिंग्स और डैशबोर्ड के लेबल तुरंत बदल जाते हैं.',
  'set.lang.note': 'लगाते ही लागू हो जाता है और इस PC पर याद रहता है.',
  'set.lang.toast': 'भाषा: {name}',

  'set.look.title': 'एक्सेंट रंग',
  'set.look.desc': 'बटन, चयन, हाइलाइट और फोकस रिंग में इस्तेमाल होता है.',
  'set.typo.title': 'इंटरफ़ेस टाइपोग्राफी',
  'set.size.title': 'इंटरफ़ेस टेक्स्ट साइज़',
  'set.density.title': 'इंटरफ़ेस घनत्व',
  'set.panels.title': 'पैनल का रूप',
  'set.panels.desc': 'सिर्फ़ अग्रभाग के पैनल — पिछला वीडियो कभी धुंधला या फ़िल्टर नहीं होता.',
  'set.motion.title': 'गति प्राथमिकता',
  'set.motion.desc': 'Reduced Motion Windows की "animations off" सेटिंग भी मानता है.',
  'set.look.blue': 'T9 नीला',
  'set.look.violet': 'बैंगनी',
  'set.look.cyan': 'नीला-हरा',
  'set.look.emerald': 'हरा',
  'set.look.amber': 'पीला',
  'set.look.rose': 'गुलाबी',
  'set.typo.clean': 'साफ़',
  'set.typo.cinematic': 'सिनेमाई',
  'set.typo.gaming': 'गेमिंग',
  'set.size.sm': 'छोटा',
  'set.size.md': 'सामान्य',
  'set.size.lg': 'बड़ा',
  'set.density.compact': 'सघन',
  'set.density.comfortable': 'आरामदायक',
  'set.panels.solid': 'ठोस पैनल',
  'set.panels.translucent': 'हल्के पारदर्शी पैनल',
  'set.panels.minimal': 'न्यूनतम पैनल',
  'set.motion.standard': 'सामान्य',
  'set.motion.reduced': 'कम गति',
  'set.reset': 'डिफ़ॉल्ट पर रीसेट',
  'set.resetDone': 'प्राथमिकताएँ T9 डिफ़ॉल्ट पर रीसेट हो गईं.',

  'set.about.title': 'परिचय',
  'set.about.version': 'संस्करण',
  'set.about.build': 'बिल्ड',
  'set.about.blurb':
    'लंबी हिंग्लिश तकनीकी ट्यूटोरियल के लिए ज़ीरो-RAM, ट्रांसक्रिप्ट-फ़र्स्ट वीडियो कटर. FFmpeg बाहर काम करता है — मेमोरी में कभी कुछ बड़ा नहीं रहता.',
  'set.about.help': 'कीबोर्ड शॉर्टकट',
  'set.about.helpHint': 'शॉर्टकट शीट खोलता है.',

  /* ---------------------------------------------------------------- top bars */
  'bar.home': 'होम',
  'bar.settings': 'सेटिंग्स',
  'bar.help': 'सहायता · कीबोर्ड शॉर्टकट (Ctrl + /)',
  'bar.helpShort': 'सहायता',
  'bar.projectMenu': 'प्रोजेक्ट मेनू',

  /* tools panel (the 9-dots launcher) */
  'bar.tools': 'टूल्स और वेबसाइट्स',
  'bar.toolsAdd': 'वेबसाइट पिन करें',
  'bar.toolsRemove': 'पिन हटाएँ',
  'bar.toolsLocked': 'बिल्ट-इन है, हटाया नहीं जा सकता',
  'bar.toolsName': 'नाम',
  'bar.toolsUrl': 'वेबसाइट URL',
  'bar.toolsPin': 'पिन करें',
  'bar.toolsEmpty': 'अभी तक कुछ पिन नहीं है. + दबाकर अपनी साइट जोड़ें — यहीं सेव हो जाएगी.',

  /* -------------------------------------------------------------- dashboard */
  'nav.home': 'होम',
  'nav.cloud': 'T9 Cloud',
  'nav.trash': 'ट्रैश',
  'nav.sections': 'डैशबोर्ड खंड',
  'nav.search': 'अपने प्रोजेक्ट खोजें',
  'dash.subtitle': 'जहाँ छोड़ा था, वहीं से आगे बढ़ें.',
  'dash.create': 'नया वीडियो बनाएँ',
  'dash.createHint': 'खाली प्रोजेक्ट से शुरू करें',
  'dash.import': 'मीडिया आयात करें',
  'dash.yourVideos': 'आपके वीडियो',
  'dash.recent': 'हाल के प्रोजेक्ट',
  'dash.searchPlaceholder': 'प्रोजेक्ट खोजें...',
  'dash.noMatches': 'कोई प्रोजेक्ट मेल नहीं खाता',
  'dash.noMatchesSub': 'कोई दूसरा नाम आज़माएँ।',
  'dash.newProject': 'नया प्रोजेक्ट',
  'dash.videosDesc': 'हर वह प्रोजेक्ट जो आपने कभी खोला.',
  'dash.trashDesc':
    'यहाँ सिर्फ़ ऐप का रिकॉर्ड रहता है — वीडियो फ़ाइल हमेशा डिस्क पर सुरक्षित रहती है.',
  'dash.autoDelete': 'ऑटो-डिलीट',
  'dash.change': 'बदलें',
  'dash.trashEmpty': 'ट्रैश खाली है',
  'dash.trashEmptySub': 'अभी तक कोई प्रोजेक्ट हटाया नहीं गया.',
  'dash.restore': 'वापस लाएँ',
  'dash.emptyTrash': 'ट्रैश खाली करें',
  'dash.emptyTrashWarn':
    '{n} ट्रैश रिकॾर्ड हमेशा के लिए हटाएँ? वीडियो फ़ाइलें हमेशा डिस्क पर सुरक्षित रहती हैं।',
  'dash.emptyTrashDone': 'ट्रैश खाली कर दिया गया।',
  'dash.more': 'और विकल्प',
  'dash.moreFor': '{name} के विकल्प',
  'dash.grid': 'ग्रिड दृश्य',
  'dash.list': 'सूची दृश्य',
  'dash.loading': 'प्रोजेक्ट लोड हो रहे हैं…',
  'dash.nothingFound': 'कुछ नहीं मिला',
  'dash.nothingFoundSub': 'खोज हटाएँ या नया प्रोजेक्ट बनाएँ.',
  'dash.noProjects': 'अभी कोई प्रोजेक्ट नहीं है',
  'dash.noProjectsSub': 'मीडिया आयात से शुरू करें — या "नया वीडियो बनाएँ" से खाली प्रोजेक्ट.',
  'dash.openDemo': '…या डेमो रिकॉर्डिंग खोलें',
  'dash.batch': 'बैच ट्रांसक्रिप्ट',
  'dash.batchHint':
    'एक साथ कई फ़ाइलें क्यू करें — एक बार में एक ट्रांसक्राइब होगी, हर फ़ाइल की स्थिति दिखेगी.',

  /* --------------------------------------------------- create new project */
  'new.title': 'नया प्रोजेक्ट बनाएँ',
  'new.sub': 'प्रोजेक्ट सेट करें और एडिटिंग शुरू करें.',
  'new.name': 'प्रोजेक्ट का नाम',
  'new.untitled': 'बिना नाम का प्रोजेक्ट',
  'new.format': 'वीडियो फ़ॉर्मैट',
  'new.formatSub': 'अपने प्रोजेक्ट का आस्पेक्ट रेशियो चुनें.',
  'new.import': 'मीडिया आयात करें',
  'new.optional': 'वैकल्पिक',
  'new.importSub': 'मीडिया के साथ शुरू करें, या बाद में एडिटर से आयात करें.',
  'new.pc': 'यह पीसी',
  'new.pcSub': 'वीडियो, ऑडियो, इमेज, GIF',
  'new.link': 'वीडियो लिंक',
  'new.linkSub': 'YouTube, Drive, आदि',
  'new.tg': 'टेलीग्राम',
  'new.tgSub': 'आपके टेलीग्राम से',
  'new.tgConnect': 'पहले कनेक्ट करें',
  'new.empty': 'खाली प्रोजेक्ट',
  'new.emptySub': 'शुरू से बनाएँ',
  'new.more': 'और फ़ॉर्मैट',
  'new.moreSub': '4:5, 4:3, आदि',
  'new.advanced': 'एडवांस सेटिंग्स',
  'new.advancedSub': 'एक्सपोर्ट फ़ोल्डर, रेज़ोल्यूशन और डेड एयर (वैकल्पिक)',
  'new.exportDir': 'एक्सपोर्ट फ़ोल्डर',
  'new.exportRes': 'रेज़ोल्यूशन',
  'new.deadAir': 'आयात पर डेड एयर काटें',
  'new.deadAirHint':
    'FFmpeg silencedetect (डेस्कटॉप). नीचे दिए गैप से लंबी खामोशी ट्रांसक्रिप्ट में कट मार्क होती है.',
  'new.deadAirPause': 'कम से कम पॉज़',
  'new.choose': 'चुनें',
  'new.askEveryTime': 'हर बार पूछें',
  'new.cancel': 'रद्द करें',
  'new.create': 'प्रोजेक्ट बनाएँ',
  'new.linkTitle': 'वीडियो लिंक पेस्ट करें',
  'new.linkHint': 'yt-dlp इसे डिस्क पर डाउनलोड करता है — फ़ाइल ऐप की मेमोरी में नहीं आती.',
  'new.linkPlaceholder': 'https://www.youtube.com/watch?v=…',
  'new.linkBack': 'वापस',
  'new.busy': 'तैयार हो रहा है…',
  'new.ytMissing': 'इस मशीन पर yt-dlp इंस्टॉल नहीं है, इसलिए लिंक आयात नहीं चलेगा.',
  'new.failed': 'प्रोजेक्ट नहीं बन पाया',
  'new.tgStarted': 'टेलीग्राम कनेक्ट खुल गया',
  'frame.yt': 'YouTube वीडियो',
  'frame.shorts': 'Shorts / Reels',
  'frame.square': 'स्क्वेयर वीडियो',
  'frame.portrait': 'पोर्ट्रेट पोस्ट',
  'frame.classic': 'क्लासिक टीवी',

  /* ------------------------------------------------------- t9 cloud setup */
  'cloud.titleAccent': 'कनेक्ट करें',
  'cloud.titleRest': 'अपना वर्कस्पेस',
  'cloud.sub': 'AI सेवाएँ और Telegram एक बार सेट करें, आपका वर्कफ़्लो खुल जाएगा.',
  'cloud.progress': '{done} of {total}',
  'cloud.progressLabel': 'सेटअप',
  'cloud.completeSetup': 'सेटअप पूरा करें',
  'cloud.rot1': 'T9 Cloud',
  'cloud.rot2': 'AI APIs',
  'cloud.rot3': 'T9 Connections',
  'cloud.rot4': 'Fast Setup',

  'cloud.gemini.name': 'Gemini API',
  'cloud.gemini.desc': 'AI विश्लेषण के लिए — बेहतरीन पल चिह्नित करता है.',
  'cloud.groq.name': 'Groq API',
  'cloud.groq.desc': 'तेज़ ट्रांसक्रिप्शन और ऑटोकरेक्ट यहीं से चलता है.',
  'cloud.groq.engineLabel': 'सेकेंडरी इंजन (Groq)',
  'cloud.groq.engineOn':
    'On — Groq ElevenLabs ke saath transcribe karta hai aur accuracy merge feed karta hai.',
  'cloud.groq.engineOff': 'Off — sirf ElevenLabs chalega; Groq fallback nahi.',
  'cloud.groq.engineError': 'Ye change save nahi ho paya.',
  'cloud.telegram.name': 'Telegram MTProto',
  'cloud.telegram.desc': 'प्रोजेक्ट को Telegram क्लाउड स्टोरेज में बैकअप करता है.',
  'cloud.t9.name': 'T9 Cloud',
  'cloud.t9.desc': 'AI और Telegram सेवाओं को इस ऐप में समन्वित करता है.',
  'cloud.t9.version': 'डेमन संस्करण {version}',
  'cloud.t9.check': 'स्थिति जाँचें',
  'cloud.daemonDown':
    'T9 Cloud डेमन नहीं चल रहा, इसलिए अभी कुछ भी कनेक्ट नहीं हो सकता. यह ऐप के साथ अपने आप चालू होता है.',
  'cloud.telegram.manage': 'कनेक्शन प्रबंधित करें',
  'cloud.telegram.connectedAs': 'कनेक्टेड: {account}',

  'cloud.notConnected': 'कनेक्टेड नहीं',
  'cloud.connected': 'कनेक्टेड',
  'cloud.incomplete': 'सेटअप अधूरा',
  'cloud.needsSetup': 'सेटअप चाहिए',

  'cloud.keyLabel': 'API कुंजी',
  'cloud.keyPlaceholder': 'अपनी API कुंजी पेस्ट करें',
  'cloud.showKey': 'कुंजी दिखाएँ',
  'cloud.hideKey': 'कुंजी छिपाएँ',
  'cloud.saveTest': 'सहेजें और जाँचें',
  'cloud.testing': 'कनेक्शन जाँच रहा है…',
  'cloud.testOk': 'कनेक्शन सही',
  'cloud.testFail': 'कनेक्शन विफल',
  'cloud.savePending': 'कुंजी काम कर रही है — इसे सुरक्षित रूप से सहेजना डेस्कटॉप ऐप के साथ आएगा.',
  'cloud.needBackend': 'लाइव कनेक्शन जाँच डेस्कटॉप ऐप में चलती है.',

  'cloud.scanQR': 'QR कोड स्कैन करें',
  'cloud.configure': 'कॉन्फ़िगर करें',
  'cloud.setUp': 'सेट करें',

  /* the ElevenLabs account pool — the primary transcriber */
  'cloud.eleven.name': 'ElevenLabs Scribe',
  'cloud.eleven.desc':
    'प्राथमिक ट्रांसक्रिप्शन इंजन — पूल के ये खाते हर चंक उठाते हैं. कुंजियाँ अपने आप घूमती हैं और फ्री कोटा बराबर खर्च होता है.',
  'cloud.eleven.ensemble':
    'एक्यूरेसी मोड चालू: ElevenLabs और Groq दोनों हर चंक पढ़ते हैं, Gemini दोनों को मिलाता है.',
  'cloud.eleven.listLabel': 'ElevenLabs खाते',
  'cloud.eleven.summary': '{total} खाते · {ready} तैयार · {cooling} ठंडे',
  'cloud.eleven.loading': 'पूल पढ़ा जा रहा है…',
  'cloud.eleven.empty': 'अभी कोई खाता नहीं — नीचे कुंजी पेस्ट करें या .env आयात करें.',
  'cloud.eleven.state.ready': 'तैयार',
  'cloud.eleven.state.cooldown': 'ठंडा',
  'cloud.eleven.state.disabled': 'बंद',
  'cloud.eleven.cooldown': '{wait} में फिर से',
  'cloud.eleven.quotaUsed': 'इस्तेमाल',
  'cloud.eleven.removeOne': '{key} हटाएँ',
  'cloud.eleven.clearAll': 'सारे खाते हटाएँ',
  'cloud.eleven.keyLabel': 'खाता जोड़ें',
  'cloud.eleven.keyPlaceholder': 'ElevenLabs API कुंजी पेस्ट करें',
  'cloud.eleven.add': 'कुंजी जोड़ें',
  'cloud.eleven.needKey': 'पहले कुंजी पेस्ट करें.',
  'cloud.eleven.added': 'कुंजी चालू — खाता पूल में जुड़ गया.',
  'cloud.eleven.importLabel': '.env से आयात',
  'cloud.eleven.importPlaceholder':
    '.env पेस्ट करें — ELEVENLABS_API_KEYS, GROQ_API_KEY और GEMINI_API_KEY पढ़े जाते हैं.',
  'cloud.eleven.import': 'आयात करें',
  'cloud.eleven.pickFile': '.env चुनें',
  'cloud.eleven.needEnv': 'पहले .env पेस्ट करें या फ़ाइल चुनें.',
  'cloud.eleven.imported': '{added} जोड़े · {rejected} नकारे · {duplicate} पहले से',
  'cloud.eleven.network': 'डेमन तक नहीं पहुँच सका — अनुरोध विफल रहा.',
  'cloud.eleven.refresh': 'Quota refresh karo',
  'cloud.eleven.checking': 'Check ho raha…',
  'cloud.eleven.probed': '{ok} quotas refresh · {failed} fail',
  'cloud.eleven.enableOne': '{key} enable karo',
  'cloud.eleven.disableOne': '{key} disable karo',
  'cloud.eleven.quotaTotal': 'pool quota used',
  'cloud.eleven.groqOffHint':
    'Groq secondary engine off hai — accuracy mode sirf ElevenLabs chala raha hai.',
  'cloud.eleven.enableGroq': 'Groq on karo',

  'cloud.footer':
    'कुंजियाँ केवल प्रत्येक कनेक्शन जाँचने के लिए उपयोग होती हैं, कहीं अपलोड नहीं होतीं.',

  /* -------------------------------------------------- api usage & limits */
  'usage.title': 'API उपयोग और सीमाएँ',
  'usage.open': 'API दर सीमा, उपयोग और कुंजियाँ दिखाएँ',
  'usage.close': 'बंद करें',
  'usage.blurb': 'इस डेमन ने अब तक {calls} प्रोवाइडर कॉल पूरी की हैं.',
  'usage.lastCall': 'आख़िरी कॉल',
  'usage.clickFor': 'सीमा, उपयोग और कुंजियाँ देखने के लिए क्लिक करें',
  'usage.updated': '{t} पहले अपडेट हुआ',
  'usage.noData': 'अभी तक कोई प्रोवाइडर कॉल दर्ज नहीं हुई.',
  'usage.daemonDown': 'T9 Cloud डेमन नहीं चल रहा, इसलिए दिखाने को कुछ नहीं है.',
  'usage.outdated': 'यह T9 Cloud बिल्ड उपयोग दृश्य से पुराना है — अगला अपडेट गेज चालू कर देगा.',
  'usage.tabLimits': 'सीमाएँ',
  'usage.tabUsage': 'उपयोग',
  'usage.tabKeys': 'API कुंजियाँ',
  'usage.tabHistory': 'इतिहास',
  'usage.timeline': '30-दिन टाइमलाइन',
  'usage.last30': 'पिछले 30 दिन',
  'usage.filter': 'इंजन',
  'usage.all': 'सभी',
  'usage.when': 'कब',
  'usage.engine': 'इंजन',
  'usage.op': 'ऑप',
  'usage.status': 'स्थिति',
  'usage.loading': 'लोड हो रहा है…',
  'usage.audio': 'ऑडियो',
  'usage.ringRequests': 'आज की रिक्वेस्ट',
  'usage.ringTokens': 'टोकन/मिनट',
  'usage.live': 'हेडर से लाइव',
  'usage.notPublished': 'प्रकाशित नहीं',
  'usage.primary': 'प्राथमिक इंजन',
  'usage.accounts': '{n} खाते',
  'usage.elevenEmpty': 'पूल में अभी कोई ElevenLabs खाता नहीं — डैशबोर्ड से जोड़ें.',
  'usage.elevenChars': 'इस माह अक्षर',
  'usage.elevenNote':
    'Scribe कोटा हेडर भेजता ही नहीं, इसलिए ये बार्स सब्सक्रिप्शन प्रोब से आते हैं जो खाता जोड़े/रीफ्रेश करते समय चला था. हर निःशुल्क खाते की अपनी मासिक अक्षर सीमा होती है — समाप्त होते ही पूल अगले खाते पर चला जाता है.',
  'usage.reqDay': 'प्रति दिन अनुरोध',
  'usage.tokMin': 'प्रति मिनट टोकन',
  'usage.left': 'शेष',
  'usage.used': 'उपयोग',
  'usage.headerNote':
    'Groq हर इन्फ़रेंस कॉल के साथ ये हेडर भेजता है और ऐप उन्हें ज्यों का त्यों रखता है: प्रति दिन अनुरोध और प्रति मिनट टोकन — दोनों Groq की अपनी परिभाषा से.',
  'usage.standbyNote':
    'पहली इन्फ़रेंस कॉल की प्रतीक्षा है — कोटा हेडर तभी आते हैं जब अनुरोध सचमुच गिना जाता है.',
  'usage.model': 'मॉडल',
  'usage.planNote':
    'निःशुल्क योजना, console.groq.com/docs/rate-limits से. आपके संगठन की सटीक सीमाएँ उसके Limits पेज पर हैं.',
  'usage.geminiNote':
    'Google के API-key एंडपॉइंट कोटा हेडर ही नहीं भेजते, इसलिए Gemini की शेष कोटा यहाँ से नहीं पढ़ी जा सकती. नीचे की गणनाएँ ऐप की अपनी हैं; सीमाएँ AI Studio में मिलती हैं.',
  'usage.today': 'आज',
  'usage.lifetime': 'कुल',
  'usage.tokensOut': 'आउट टोकन',
  'usage.latency': 'विलंबता',
  'usage.errors': 'त्रुटियाँ',
  'usage.recent': 'हाल की कॉल',
  'usage.recentEmpty': 'अभी कुछ नहीं.',
  'usage.keyIntro':
    'इस डेमन की कुंजियाँ यहाँ से जोड़ें, बदलें या हटाएँ. पूरी कुंजी कभी वापस नहीं दिखती — केवल पहले और अंतिम अक्षर.',
  'usage.keyPlaceholder': 'नई API कुंजी पेस्ट करें',
  'usage.keySave': 'सहेजें',
  'usage.keyRemove': 'हटाएँ',
  'usage.keySaved': 'कुंजी सहेजी गई — डेमन अब इसी का उपयोग कर रहा है.',
  'usage.keyRemoved': 'कुंजी हटा दी गई.',
  'usage.keySaveFailed': 'कुंजी सहेजी नहीं जा सकी.',
  'usage.keyStorage': '.env के बग़ले रखी जाती है, केवल यही ऐप इसे लिखता है:',

  /* Telegram login modal */
  'cloud.tg.modalTitle': 'Telegram लिंक करें',
  'cloud.tg.modalDesc':
    'फ़ोन से कोड स्कैन करके Telegram को सुरक्षित क्लाउड स्टोरेज के रूप में जोड़ें.',
  'cloud.tg.close': 'बंद करें',
  'cloud.tg.scan': 'QR कोड स्कैन करें',
  'cloud.tg.waiting': 'स्कैन का इंतज़ार है…',
  'cloud.tg.open': 'Telegram खोलें',
  'cloud.tg.done': 'Telegram जुड़ गया',
  'cloud.tg.notReady':
    'डेस्कटॉप ऐप Telegram तब जोड़ता है जब क्रेडेंशियल सेट हों. QR लॉगिन इंस्टॉल किए गए ऐप में उपलब्ध है.',
  'cloud.tg.offline': 'T9 Cloud डेमन नहीं चल रहा.',
  'cloud.tg.expired': 'वह कोड समाप्त हो गया — नया बनाएँ.',
  'cloud.tg.failed': 'लॉगिन विफल रहा. फिर से कोशिश करें.',
  'cloud.tg.retry': 'फिर से कोशिश करें'
};

const DICTS: Record<UiLang, Dict> = { en, hinglish, hi };

const STORAGE_KEY = 't9-editor-lit.lang';

function isLang(v: unknown): v is UiLang {
  return v === 'en' || v === 'hi' || v === 'hinglish';
}

class I18nStore {
  /** The UI language. `hinglish` (the app's own voice) is the default. */
  lang = $state<UiLang>('hinglish');

  /**
   * Translate one key, filling `{placeholders}`.
   *
   * Reads `this.lang`, so a component that calls `t()` in its markup re-renders
   * the moment the language changes — no re-mount, no restart.
   */
  t(key: string, vars?: Record<string, string | number>): string {
    const table = DICTS[this.lang] ?? en;
    let out = table[key] ?? en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
    }
    return out;
  }

  /** The picker's label for the current language, in that language. */
  get currentNative(): string {
    return UI_LANGS.find((l) => l.id === this.lang)?.native ?? 'Hinglish';
  }

  setLang(lang: UiLang): void {
    if (!isLang(lang)) return;
    this.lang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* private mode */
    }
    // The dashboard greeting keeps its own two-language bank: Hinglish and
    // Hindi share the romanised `hi` lines, English has its own.
    greeting.setLang(lang === 'en' ? 'en' : 'hi');
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
  }

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (isLang(raw)) this.lang = raw;
    } catch {
      /* private mode */
    }
    if (typeof document !== 'undefined') document.documentElement.lang = this.lang;
  }
}

export const i18n = new I18nStore();

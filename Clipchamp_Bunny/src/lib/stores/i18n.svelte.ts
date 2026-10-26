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

  /* ------------------------------- background (profile menu → Background) */
  'profile.background': 'Background',
  'bg.title': 'BACKGROUND',
  'bg.video': 'Choose a video…',
  'bg.image': 'Choose a wallpaper…',
  'bg.reset': 'Back to default',
  'bg.custom': 'Custom',
  'bg.default': 'Default',
  'bg.limit': 'Video keeps 20 s at 720p, no sound — that is what keeps the app light.',
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

  'cloud.footer': 'Keys are used only to test each connection and are never uploaded.',

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
  'profile.menu': 'Profile menu',
  'profile.open': 'Profile menu kholo',
  'profile.picture': '{name} ki profile picture',
  'profile.edit': 'Edit profile',
  'profile.settings': 'App settings',
  'profile.language': 'Language',
  'profile.help': 'Help & About',
  'profile.back': 'Wapas',
  'profile.cancel': 'Cancel',
  'profile.name': 'Display name',
  'profile.namePlaceholder': 'Aapka naam',
  'profile.save': 'Save',
  'profile.saved': 'Profile save ho gaya.',
  'profile.nameEmpty': 'Naam khaali nahi ho sakta.',
  'profile.hint': 'Sirf is PC pe save hota hai — kuch upload nahi hota.',
  'profile.photoPick': 'Photo chuno',
  'profile.photoResetBtn': 'Photo hatao',
  'profile.photoSet': 'Profile photo update ho gayi.',
  'profile.photoReset': 'Wapas default photo pe.',
  'profile.photoBad': 'Ye file ek valid image nahi hai.',
  'profile.close': 'Menu band karo',

  /* ------------------------------- background (profile menu → Background) */
  'profile.background': 'Background',
  'bg.title': 'BACKGROUND',
  'bg.video': 'Video chuno…',
  'bg.image': 'Wallpaper chuno…',
  'bg.reset': 'Default pe wapas',
  'bg.custom': 'Custom',
  'bg.default': 'Default',
  'bg.limit': 'Video 20 second, 720p tak, bina awaaz — isi se app halka rehta hai.',
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

  'cloud.footer': 'Keys sirf har connection test ke liye use hoti hain, kahin upload nahi hoti.',

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

  /* ------------------------------- background (profile menu → Background) */
  'profile.background': 'बैकग्राउंड',
  'bg.title': 'बैकग्राउंड',
  'bg.video': 'वीडियो चुनें…',
  'bg.image': 'वॉलपेपर चुनें…',
  'bg.reset': 'डिफ़ॉल्ट पर वापस',
  'bg.custom': 'कस्टम',
  'bg.default': 'डिफ़ॉल्ट',
  'bg.limit': 'वीडियो 20 सेकंड, 720p तक, बिना आवाज़ — इसी से ऐप हल्का रहता है.',
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
  'set.skip.bad': 'स्किप स्टेप एक सकारात्मक संख्या होनी चाहिए (सेकंड).',
  'set.skip.toast': 'स्किप स्टेप {n} सेकंड — J / L और ट्रांसपोर्ट बटन.',

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

  'cloud.footer':
    'कुंजियाँ केवल प्रत्येक कनेक्शन जाँचने के लिए उपयोग होती हैं, कहीं अपलोड नहीं होतीं.',

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

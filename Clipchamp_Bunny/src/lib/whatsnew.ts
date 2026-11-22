/**
 * "What's New" content shown when a staged update is waiting.
 *
 * This is the single source of truth for the release notes the user reads
 * before deciding to restart into the new build. Keep entries in Hinglish,
 * deep and specific, with a *reason* for every change - the user asked for
 * "kya kya hai, deep detail, with reason", not a one-line changelog.
 *
 * Add a new release block at the top whenever a build ships; the modal
 * renders the whole list (newest first).
 */
export interface WhatsNewItem {
  title: string;
  detail: string;
  reason: string;
}

export interface WhatsNewRelease {
  version?: string;
  headline: string;
  items: WhatsNewItem[];
}

export const WHATS_NEW_RELEASES: WhatsNewRelease[] = [
  {
    version: 'reference',
    headline: 'Release notes (hand-written reference)',
    items: [
      {
        title: 'Export screen poori tarah naya (image-approved)',
        detail:
          "Export ab ek dedicated screen hai jisme Fast / Quality presets, exact-cut join aur gapless 60fps output ek saath milta hai. Ek hi FFmpeg pass me audio graph build hota hai (concat clause ';' ke peeche), aur native notification bhejta hai jab render complete ho. History panel me last export ka FFmpeg command + stderr tail bhi dekh sakte ho.",
        reason:
          "Purana export join path relative paths use karta tha, isliye bare output name Downloads me nahi land karta tha aur concat entries mismatch hoti thi. Absolute paths + ek extra ';' se exact ms cuts ab gapless join hote hain."
      },
      {
        title: 'Browser = Firefox F11 parity (fullscreen)',
        detail:
          'Chrome auto-hide, top-edge 4px reveal band, Esc collapses toolbar (fullscreen se BAHAR nahi aata), F6 address-bar focus, aur fullscreen button default hidden. F11 on/off setting ab only entering gate hai, exit hamesha allowed.',
        reason:
          'User ne Firefox jaisa fullscreen behavior maanga tha - accidental exit aur stuck fullscreen dono problems the; ab Esc sirf collapse karta hai, F11 hi exit karta hai.'
      },
      {
        title:
          'AI: user-run Gemini analysis + spoken-word bold + custom accent + YouTube default pin',
        detail:
          'Gemini analysis ab user khud trigger karta hai (auto nahi). Transcript me spoken words bold render hote hain. Accent color custom set kar sakte ho. YouTube tabs by default pinned hote hain taaki background me chale.',
        reason:
          'Auto-analysis se cost aur noise badhta tha; manual trigger se user control milta hai. Bold spoken words se read-along asaan hota hai, aur YouTube pin se tab accidentally close nahi hota.'
      },
      {
        title: 'Timeline: "Finished video" view',
        detail:
          'Cuts zero width collapse ho jate hain aur kept clips back-to-back render hote hain, taaki final video ka preview bina gaps ke dikhe. Cut / silence / filmstrip / suggestion display filters alag toggle hain.',
        reason:
          'Editor me cuts dekhna alag hai, final result dekhna alag - finished view se user ko exact output ka feel milta hai bina timeline clutter ke.'
      },
      {
        title: 'Word-level cut (selection toolbar)',
        detail:
          'Line ke neeche video ke upar se word select karke cut kar sakte ho. Exact ms boundaries, tiny splits allowed, blue range band show hota hai. Instant selection toolbar, audio-snapped ms boundaries. Ctrl+Shift+B browser shortcut.',
        reason:
          'Line-level cut se fine editing nahi hoti thi; word-level se user exact phrase remove kar sakta hai. Audio-snapping se cut point natural word boundary pe land karta hai.'
      },
      {
        title: 'Browser tabs ab header me favicon chips',
        detail:
          'Tabs 40px strip nahi lete - header me favicon chips. Durable bookmarks/pins, 2-finger swipe tabs, offline hint, real-page-only chip titles. Cold start ab Home pe land karta hai, last open tab pe nahi.',
        reason:
          'Separate tab strip RAM aur vertical space waste karta tha. Header chips se ek hi row me sab kuch. Cold start on Home se stale webview paint-over-Home bug fix hua.'
      },
      {
        title: 'Transcript: word wrap (Alt+Z), JSON recommended tag, import coverage warning',
        detail:
          'Alt+Z se transcript wrap toggle. Import ke time coverage warning deta hai agar transcript media duration se kam cover karta hai. JSON format recommended tag dikhata hai.',
        reason:
          'Long lines horizontal scroll karte the; wrap se reading asaan. Coverage warning se missing transcript segments pehle hi detect ho jate hain.'
      },
      {
        title: 'Trim: proportional floor (word-cut slivers fix)',
        detail:
          'Word-cut slivers ab trim ho jate hain instead of inverting (negative duration). Exact ms cuts ke saath chhote fragments bhi sahi trim hote hain.',
        reason:
          'Pehle chhote sliver cuts negative duration banate the jo render ko break karta tha; proportional floor se minimum valid length guarantee hoti hai.'
      },
      {
        title: 'PiP-style media flyout + drag/resize/close + remembered geometry',
        detail:
          'Media flyout ab PiP style hai - drag, resize, X close, geometry remembered. Window ops UI thread se off kiye gaye hain.',
        reason:
          'Flyout blocking UI thread se lag aata tha; offloading se smooth interaction. Remembered geometry se user ka layout persist hota hai.'
      },
      {
        title: 'uBlock Origin per-site controls via content bridge',
        detail:
          'uBlock Origin real per-site controls extension ke andar se kaam karte hain, extra webview nahi. Bridge patch verified against real installed uBOL extension.',
        reason:
          'Extra webview se RAM badhta tha; in-extension bridge se same functionality zero extra memory me.'
      },
      {
        title: 'Cold start + stale webview sweep',
        detail:
          'App start pe Home screen land hota hai. Fresh shell document stale page webviews sweep karta hai taaki video paint-over-Home na ho. First page storage pe wait nahi karta, har stage log me bolta hai.',
        reason:
          'Reload pe page webview dashboard ke upar paint hota tha - sweep + storage skip se startup clean aur debuggable.'
      },
      {
        title: "Update flow: staged build swap + What's New",
        detail:
          "Jab naya build stage hota hai, top bar me Update button + doc icon dikhata hai. App open pe What's New page automatically khulta hai detailed changes ke saath. Update Now se restart, Skip se dismiss - button nahi hat ta.",
        reason:
          "User ko bina restart ke bhi changes dekhne chahiye; doc icon se running app me bhi What's New access hota hai."
      }
    ]
  }
];

/** Convenience: the latest release (newest first). */
export const WHATS_NEW = WHATS_NEW_RELEASES[0];

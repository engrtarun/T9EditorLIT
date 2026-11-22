/**
 * "What's New" content, bound to the EXACT build it describes.
 *
 * STRICT RULE (see root AGENTS.md §15): a note is not evergreen documentation.
 * Every release block carries the `buildId` of the commit whose diff was read
 * to write it. The modal asks for notes by the staged marker's build id; if
 * there is no exact match it shows an explicit "no verified notes" state —
 * it never falls back to an older build's prose. A feature change that makes
 * an old note wrong must edit or delete that note in the SAME commit.
 *
 * Keep entries in Hinglish, specific, and always carry a real reason.
 */

export interface WhatsNewItem {
  title: string;
  detail: string;
  reason: string;
}

export interface WhatsNewRelease {
  /** The exact staged build id these notes were verified against. */
  buildId: string;
  headline: string;
  items: WhatsNewItem[];
}

export const WHATS_NEW_RELEASES: WhatsNewRelease[] = [
  {
    buildId: 'ci-0ed26d6',
    headline: 'Command palette + browser keys + media card',
    items: [
      {
        title: 'Command palette: typing actually works now',
        detail:
          'Palate ka onKey handler define tha lekin input se juda hi nahi tha — isliye type karne par Enter, ↑↓ aur Escape kuch nahi karte the. Ab input par onkeydown wired hai: type karo, arrow se move karo, Enter se chalao, Esc se band karo. Ek hi jagah se open tabs, recent projects, browsing history aur downloads milte hain.',
        reason:
          'Focus trap sirf comment me tha, code me nahi. Notes ke liye alag-alag jagah dhoondna padta tha; ab ek search sab data ko cover karta hai.'
      },
      {
        title: 'Ctrl+K Firefox ka search, Alt+K universal palette',
        detail:
          'Browser me Ctrl+K ab Firefox ki tarah address bar / search par focus karta hai. Command palette Alt+K se khulti hai — Home, Studio aur Browser, kahi bhi.dono keys ka matlab ab har screen par same hai.',
        reason:
          'Pehle Ctrl+K palette tha aur Alt+K browser search — same key alag screen par alag kaam karti thi. Firefox wali key Firefox jaisi rakhkar doosri ko universal kiya gaya.'
      },
      {
        title: 'Media flyout: pin X ke left, detail ke liye > right',
        detail:
          'Pin icon ab X ke left me hai aur X ke right me naya > chevron hai. Chevron dabaate hi card expand hoke batata hai ki audio kis tab se aa raha hai, aur “Keep open” se card 5 second baad hide nahi hota.',
        reason:
          'Multi-tab me audio chalne par notification jaldi chhup jati thi aur kis tab se aa raha hai ye pata nahi chalta tha. Chevron se wo detail aur keep-open dono mil gaye.'
      }
    ]
  },
  {
    buildId: 'ci-fa8b922',
    headline: 'Batch transcript studio-only + browser memory',
    items: [
      {
        title: 'Batch transcript sirf studio me',
        detail:
          'Home dashboard par batch panel aur dono batch buttons hata diye gaye. Panel ab sirf editor (studio) branch me mount hota hai; entry point transcript header ke ≡ menu me hai — Batch transcript option ke saath.',
        reason:
          'Home screen par batch panel chal rahe transcription ka dikhava deta tha jahan se user kuch kar hi nahi sakta tha. Entry sirf us jagah rakhi gayi jahan kaam hota hai.'
      },
      {
        title: 'Ctrl+1 … Ctrl+9 pure app me',
        detail:
          'Koi bhi tab open ho to Ctrl+1 se Ctrl+9 Home, Studio ya Browser — kahi se bhi us tab par jump karte hain; Ctrl+9 last tab. Nayi tab khulne par us screen par browser view bhi open ho jata hai.',
        reason:
          'Tab switch sirf browser view me kaam karta tha, jabaki tab chips har header me dikhte hain. Chips dikhne ka matlab tha unhe kahi se bhi pakadna possible hona chahiye.'
      },
      {
        title: 'Pinned sites: last 3, exact URL, auto-pin',
        detail:
          'Last teen pinned sites exact URL ke saath SQLite me yaad rakhe jate hain. Site dobara kholne par auto-pin hoti hai — jab tak user ne pehle usse explicitly unpin na kiya ho. Unpin karne par wo decision tombstone ki tarah save hoti hai, limit 3 hai.',
        reason:
          'Har launch par same teen sites dobara pin karna padta tha. Unpin ke baad dobara pin na hone se user ka faisla respect hota hai.'
      },
      {
        title: 'Browsing history ab SQLite me',
        detail:
          'History entry me exact URL, title aur exact millisecond timestamp hota hai. Pehle ye sirf localStorage me tha; ab durable SQLite kv me bhi likha jata hai aur startup par merge hota hai.',
        reason:
          'Webview storage wipe hone par visit log chala jata tha — Ctrl+H panel khali dikhta tha. SQLite copy se time aur URL dono bache rehte hain.'
      }
    ]
  }
];

/**
 * The only safe lookup. An unknown build gets a neutral state, never an older
 * build's notes. `installedBuild()` supplies the staged id from the on-disk
 * marker, so a stale hand-written list can never masquerade as current.
 */
export function whatsNewFor(stagedBuildId: string | undefined): WhatsNewRelease {
  if (!stagedBuildId) return UNVERIFIED_RELEASE;
  const id = stagedBuildId.trim().toLowerCase();
  return WHATS_NEW_RELEASES.find((r) => r.buildId.toLowerCase() === id) ?? UNVERIFIED_RELEASE;
}

export const UNVERIFIED_RELEASE: WhatsNewRelease = {
  buildId: '',
  headline: 'Is build ke liye koi verified notes nahi',
  items: [
    {
      title: 'Notes is exact build se jude hote hain',
      detail:
        'Jo build stage hua hai uske liye kisi ne release notes verify nahi kiye. Purane build ki baatein yahan dikhana galat hota, isliye kuch nahi dikhaya ja raha. Commit diff dekhein ya agle build me notes add karne ka request karein.',
      reason:
        'What’s New me purani/galat jaankari dikhne se user nayi build ke baare me galat faisla le sakta tha. Strict rule: sirf exact match dikhao.'
    }
  ]
};

/** Kept for callers that only want the newest verified notes. */
export const WHATS_NEW = WHATS_NEW_RELEASES[0];

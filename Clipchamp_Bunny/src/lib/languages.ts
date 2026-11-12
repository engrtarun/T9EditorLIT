/**
 * The languages the transcript panel offers.
 *
 * The list is deliberately short: the point is not a complete catalogue but
 * the handful of languages a person actually needs to correct a detector
 * that guessed wrong. The daemon pins a language only after two chunks agree
 * on it, and the text it produced is checked against the script it was
 * written in - so when the guess is wrong, the user needs one click to say
 * what it should have been, and no more.
 */
export interface LanguageOption {
  /** ISO-639-1 code, the same one the API accepts. */
  code: string;
  /** The name in the language itself. */
  label: string;
}

/** The languages offered in the override dropdown. */
export const LANGUAGES: LanguageOption[] = [
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'en', label: 'English' },
  { code: 'bn', label: 'বাংলা (Bengali)' },
  { code: 'ta', label: 'தமிழ் (Tamil)' },
  { code: 'te', label: 'తెలుగు (Telugu)' },
  { code: 'kn', label: 'ಕನ್ನಡ (Kannada)' },
  { code: 'ml', label: 'മലയാളം (Malayalam)' },
  { code: 'mr', label: 'मराठी (Marathi)' },
  { code: 'gu', label: 'ગુજરાતી (Gujarati)' },
  { code: 'pa', label: 'ਪੰਜਾਬੀ (Punjabi)' },
  { code: 'ur', label: 'اردو (Urdu)' },
  { code: 'ar', label: 'العربية (Arabic)' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
  { code: 'ru', label: 'Русский' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'th', label: 'ไทย' },
  { code: 'id', label: 'Bahasa Indonesia' }
];

/** The short label for a language code, for a badge. */
export function languageLabel(code: string | null | undefined): string {
  if (!code) return '';
  const hit = LANGUAGES.find((l) => l.code === code);
  if (hit) return hit.label.split(' (')[0];
  return code.toUpperCase();
}

/**
 * Is this line written in a different language from the rest of the
 * transcript?
 *
 * The badge is only worth showing when the line is the odd one out: a chip on
 * every line of a Hindi video is noise, and a chip on the one English line is
 * information.
 */
export function isLanguageSwitch(lineLang: string | undefined, jobLang: string | null): boolean {
  if (!lineLang) return false;
  if (!jobLang) return true;
  return lineLang !== jobLang;
}

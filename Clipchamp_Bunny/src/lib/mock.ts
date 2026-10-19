import type { TranscriptLine } from './types';

/** Raw transcript rows, ids added below so the literal stays readable. */
type Row = Omit<TranscriptLine, 'id'>;

const ROWS: Row[] = [
  {
    startSec: 0,
    endSec: 4.2,
    text: 'Namaste dosto, swagat hai aapka is channel par.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.98
  },
  {
    startSec: 4.2,
    endSec: 7.8,
    text: 'Namaste dosto, swagat hai aapka— matlab aaj hum karna hai bahut hi',
    flag: 'repeat',
    keep: 'cut',
    confidence: 0.61
  },
  {
    startSec: 7.8,
    endSec: 12.4,
    text: 'bahut hi interesting ek topic pe baat karne wale hain.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.97
  },
  {
    startSec: 12.4,
    endSec: 19.1,
    text: 'Toh aaj ka topic hai Vite kya hota hai aur aapko kaise use karna hai.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.99
  },
  {
    startSec: 19.1,
    endSec: 26.5,
    text: 'Toh ye... ye Vite matlab hai ki— [pause] chalo dekhte hain.',
    flag: 'fumble',
    keep: 'cut',
    confidence: 0.48
  },
  {
    startSec: 26.5,
    endSec: 34.0,
    text: 'Vite ek build tool hai jo development server bahut fast deta hai.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.96
  },
  {
    startSec: 34.0,
    endSec: 41.2,
    text: 'Jaise maan lijiye aap React use kar rahe ho, toh ye aapko — ',
    flag: 'none',
    keep: 'keep',
    confidence: 0.95
  },
  {
    startSec: 41.2,
    endSec: 50.8,
    text: 'Ek example sochiye ki aapko ek calculator banana hai.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.97
  },
  {
    startSec: 50.8,
    endSec: 61.4,
    text: 'Calculator banana hai na, toh aap— chodo, calculator se hi shuru karte hain.',
    flag: 'wrong-example',
    keep: 'cut',
    confidence: 0.44
  },
  {
    startSec: 61.4,
    endSec: 68.9,
    text: 'Aap calculator bana rahe ho, aur aapko lagta hai bundler slow hai.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.94
  },
  {
    startSec: 68.9,
    endSec: 73.0,
    text: 'Aur wahi cheez Vite 10 second mein kar deta hai.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.99
  },
  {
    startSec: 73.0,
    endSec: 79.5,
    text: 'Aur ye baat bahut important hai ki— [long silence]',
    flag: 'silence',
    keep: 'cut',
    confidence: 0.2
  },
  {
    startSec: 79.5,
    endSec: 88.2,
    text: 'Vite ke andar do server hote hain, ek dev server aur ek preview server.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.96
  },
  {
    startSec: 88.2,
    endSec: 95.7,
    text: 'Dev server aapka code browser me live reload karta hai.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.97
  },
  {
    startSec: 95.7,
    endSec: 101.0,
    text: 'Aur preview server production build ko serve karta hai.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.96
  },
  {
    startSec: 101.0,
    endSec: 110.4,
    text: 'Ab baat karte hain configuration ki, yahan pe dekhiye vite.config.js.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.98
  },
  {
    startSec: 110.4,
    endSec: 118.9,
    text: 'Ismein hum plugin define kar rahe hain, jaise React plugin.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.97
  },
  {
    startSec: 118.9,
    endSec: 126.0,
    text: 'Ab hum install karenge, terminal kholiye aur type karo—',
    flag: 'none',
    keep: 'keep',
    confidence: 0.98
  },
  {
    startSec: 126.0,
    endSec: 133.5,
    text: 'npm install vite. Ye command aapko vite install kar degi.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.98
  },
  {
    startSec: 133.5,
    endSec: 142.1,
    text: 'Ab start karne ke liye likhiye— npx vite, aur ye server start ho jayega.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.97
  },
  {
    startSec: 142.1,
    endSec: 149.0,
    text: 'Dekha? Server toh— ye toh poora— [fumble] hmm.',
    flag: 'fumble',
    keep: 'cut',
    confidence: 0.4
  },
  {
    startSec: 149.0,
    endSec: 158.4,
    text: 'Server toh ek second me start ho gaya, jo CRA me 30 second leta.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.96
  },
  {
    startSec: 158.4,
    endSec: 164.2,
    text: 'Ye CRA ka example— matlab CRA bhi accha tha, dono acche hain.',
    flag: 'wrong-example',
    keep: 'cut',
    confidence: 0.55
  },
  {
    startSec: 164.2,
    endSec: 172.0,
    text: 'Dekhiye, terminal me localhost colon 5173 dikha raha hai.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.98
  },
  {
    startSec: 172.0,
    endSec: 180.5,
    text: 'Ab aap project structure dekhiye, yahan pe src folder hai.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.97
  },
  {
    startSec: 180.5,
    endSec: 188.0,
    text: 'Ismein main file hai, aur components ka ek folder hai.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.96
  },
  {
    startSec: 188.0,
    endSec: 193.5,
    text: 'Ab sabse important baat— production build. [pause]',
    flag: 'silence',
    keep: 'cut',
    confidence: 0.22
  },
  {
    startSec: 193.5,
    endSec: 202.1,
    text: 'Production build ke liye likhiye npm run build.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.99
  },
  {
    startSec: 202.1,
    endSec: 210.6,
    text: 'Ye command aapka code bundle karke dist folder me daal deti hai.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.97
  },
  {
    startSec: 210.6,
    endSec: 217.0,
    text: 'Aur ye build CRA se bhi tez hai, kyunki Vite Rollup use karta hai.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.95
  },
  {
    startSec: 217.0,
    endSec: 223.5,
    text: 'Rollup ke baare me main aage ek alag video me baat karunga.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.98
  },
  {
    startSec: 223.5,
    endSec: 229.0,
    text: 'Rollup ke baare me— [fumble] matlab Rollup bhi accha hai.',
    flag: 'fumble',
    keep: 'cut',
    confidence: 0.42
  },
  {
    startSec: 229.0,
    endSec: 237.4,
    text: 'To ye tha Vite ka pura intro, aur aage hum plugins padhenge.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.97
  },
  {
    startSec: 237.4,
    endSec: 245.0,
    text: 'Plugin matlab kya hota hai, ye next video me detail me samjhaunga.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.96
  },
  {
    startSec: 245.0,
    endSec: 250.5,
    text: 'Plugin— waise plugin toh— [pause] chodo, agla video.',
    flag: 'fumble',
    keep: 'cut',
    confidence: 0.38
  },
  {
    startSec: 250.5,
    endSec: 258.0,
    text: 'Agar aapko ye video pasand aayi toh like zaroor kariye.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.99
  },
  {
    startSec: 258.0,
    endSec: 266.5,
    text: 'Aur bell icon daba lena taaki next video ka notification aaye.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.99
  },
  {
    startSec: 266.5,
    endSec: 274.0,
    text: 'Milte hain next video me, tab tak ke liye— bye.',
    flag: 'none',
    keep: 'keep',
    confidence: 0.98
  }
];

/**
 * Realistic mock transcript for the prototype.
 * Shape mirrors what Groq Whisper + Gemini will return, so swapping in the real
 * backend is a data-source change, not a shape change.
 */
export const MOCK_LINES: TranscriptLine[] = ROWS.map((row, i) => ({
  ...row,
  id: `ln-${String(i).padStart(3, '0')}`
}));

export const MOCK_DURATION_SEC = 274;

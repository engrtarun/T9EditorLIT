# 40 Edge Cases — Playbook (Analysis Only, No Code)

> Ye document sirf **thinking, research aur analysis** hai — isme koi code nahi hai.
> Har case real-life hai, T9EditorLIT (transcript-first cutter, Groq Whisper + Gemini
> flags, FFmpeg child processes, SQLite state, 8 GB i3 / Zero-RAM) par aa sakta hai.
>
> **Constraints har fix me follow hui:**
>
> - **Free tools only** — ffmpeg/ffprobe, local heuristics, Groq free tier (daemon ke
>   through), Gemini free tier (analyze pass), SQLite. Koi paid service nahi.
> - **Device capability** — i3, 8 GB RAM, ~1 GB free. Koi bhi fix full-file decode,
>   RAM buffering, ya parallel API-flood use nahi karta.
> - **Fast + accurate** — jo kaam locally free me hota hai wo API ko nahi diya jaata.
> - **Quality > quantity** — auto-delete ka risk nahi liya jaata; suggest + confirm.

---

## 0. Live Evidence — ek real video jo is repo ke user ne di (aaj)

File: `C:\Users\pocot\Downloads\Mobile Devices\InShot_20261111_195238486.mp4`
Ye "InShot-type mobile video" ki perfect specimen hai — cases 31–40 isi par grounded hain.

### File DNA (ffprobe)

| Fact         | Measured value                                              | Matlab                                                             |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Size         | **5,307,984,977 bytes (5.3 GB)**                            | 50 min ki tutorial ke liye bahut bada                              |
| Duration     | 2989.98 s = **49:50**                                       | lamba single file                                                  |
| Video        | H.264 High, 1920×1080, **~30 fps but avg 29.998 (VFR-ish)** | frame-index math drift karega                                      |
| Bitrate      | **14 Mbps** (video)                                         | InShot re-export bloat — content to notes-app screen recording hai |
| Pixel format | **yuvj420p (full range)** + bt470bg / smpte170m color tags  | SD-era color metadata HD video par — decoders disagree karte hain  |
| Audio        | AAC LC, **44.1 kHz stereo, 189 kbps**                       | ASR ke liye 16k mono chahiye                                       |
| Muxer        | Lavf61.1.100, language "und"                                | InShot signature; koi camera metadata nahi                         |

### Audio DNA (ffmpeg silencedetect −30 dB / 0.8 s + ebur128 + astats)

| Fact          | Measured value                                 | Matlab                                              |
| ------------- | ---------------------------------------------- | --------------------------------------------------- |
| Speech        | **1582 s (26:22) = 52.9%**                     | case-1 type nahi, par bhi ~47% silence hai          |
| Silence       | 1407.6 s (23:28), **274 periods**              | jump-cut editing ka signature                       |
| Gap sizes     | **115 × <1.5 s**, 113 × 1.5–5 s, **46 × >5 s** | micro-gaps + real dead zones dono hain              |
| Longest gaps  | **87.4 s, 52.7 s, 49.9 s, 47 s, 46.6 s**       | intro/outro/section breaks ki tarah bade dead zones |
| First silence | 0 s se                                         | video **silent disclaimer card** se shuru hoti hai  |
| Loudness      | **−21.4 LUFS integrated**, LRA 6.6 LU          | steady teaching voice, consistent                   |
| True peak     | **−0.2 dBFS**                                  | near-clipping normalization (InShot max-normalize)  |
| RMS (overall) | −27 dB, crest 21.7                             | speech high-energy, gaps digital-level              |

### Size ka sach

|                                                | Bytes      | % of file |
| ---------------------------------------------- | ---------- | --------- |
| Poora file                                     | 5.3 GB     | 100%      |
| Sirf audio (16k mono opus, transcript ke liye) | **6.0 MB** | **0.11%** |

Transcript ke liye 5.3 GB me se sirf 6 MB chahiye — **99.89% bytes drop, zero accuracy loss**.

### Transcript DNA (app ke apne daemon se transcribe hua — Groq free tier, ₹0)

Live pipeline test: 6 MB opus ek hi chunk me daemon `POST /v1/transcribe` ko diya,
**354 segments** wapas aaye. Ye transcript DNA cases 39–40 ka proof hai.

| Fact                | Measured value                                                                                                                                                                                       | Matlab                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Segments / words    | **354 segments, 4,999 words**                                                                                                                                                                        | ~100 wpm — steady teaching pace (LRA 6.6 se match)                                                                                                         |
| Script              | **350/354 segments Devanagari**                                                                                                                                                                      | Whisper ne Hinglish boli ke liye **khud Hindi script chuni** — English tech terms Latin me hi bache ("Vector Database", "context window", "hybrid search") |
| Phonetic mangling   | RAG → "**Retrive Argument Document General**"/"argumented"; birthday song → "**बर्थडे सोंद**"; LLM → एलएम/एलेलम/एलएलम; ChatGPT → चैट जीपीटी/**चैनल जीपीटी**; flagship models → "**फ्लेक्सिप एडिया**" | autocorrect pass ki zaroorat ka live proof                                                                                                                 |
| Retakes             | Intro line **2×** (14–26 s); RAG definition **3×** (405–426 s); "**link in description**" **5× cluster** (544–558 s)                                                                                 | retake-highlight case ka evidence                                                                                                                          |
| Hallucination zones | 961–1049 s "**पातर नानी स्टूड चाव दंजिर सैस्टो**"; 1078 s "प्रति प्रति प्रति"; 2468–2472 s "**झाल**" ×5 (har ek 0.7 s); 2793–2861 s "प्रेमोग स्पूर्ट/स्ट्रॉप/प्रस्तुति प्रस्तुति"                    | **sab 46 dead zones ke andar hi** — screen-typing moments par Whisper ne shabdein likh di                                                                  |
| Micro segments      | **46 segments < 2 s; 19 segments ≤ 4 chars**                                                                                                                                                         | jump-cut dense zones (850–874 s har phrase alag segment)                                                                                                   |
| Teaching words      | समझ-family **29 segments**, basically **12**, सब्सक्राइब **8**, कमेंट **5**                                                                                                                          | engagement style — hooks timeline ke anmol hisse hain                                                                                                      |
| Outro emotion       | "**सब्सक्राइब नहीं करोगे तो मेरे खाते में पैसा कैसे आएगा**" (2981 s)                                                                                                                                 | humor + hook — cut suggestions ko ye bachana hai                                                                                                           |

### Content DNA (frames se)

- **0 s:** silent DISCLAIMER card (educational purpose, no endorsement) — sketch-art background par.
- **4 s → end:** Hinglish AI tutorial — "**RAG (Retrieval-Augmented Generation) ko Simple Breakdown**".
- Layout: **screen recording** (notes/breakdown app) + **face-cam top-right** (presenter, printed shirt, tablet) + **sketch-art background**.
- Teaching style: **analogies** — "Detective & CID Investigation", "Retrieval Pyramid (Level 1 Keyword Filter → Level 2 Vector Search → Level 3 Agentic LLM)", "Real Estate Property Agent", "Law & Legal Tech use case".
- Examples typed live: "google search / vector search", "birthday song", "ihaggu halwal" (demo gibberish typing).
- **Watermark rotate hota hai:** LinkedIn (4 min) → Instagram (12 min) → YouTube (20 min) → "STAY CONNECTED ON" banner (28 min+), handle `EngrTarunDilwal`.
- Emotion: teaching energy steady (LRA 6.6), analogy moments par hand gestures (pointing), kabhi-kabhi thinking pause (hand on face). Jump cuts se dead time pehle se kaata gaya hai — jo silence bacha hai wo natural pauses + section breaks + demo-typing zones hai.

---

## 0.1 Paanch Cross-Cutting Principles — "in problems ka aisa solution kyun hoga"

1. **Pehle naapo, phir kaato (measure-first).** Har fix ek local measurement se shuru
   hota hai — ffprobe duration/codec, astats noise floor, ebur128 loudness, silence map.
   Fixed thresholds har device par toot jaate hain (fan-noise phone me silence −28 dB hota
   hai, studio me −60 dB). Measurement free hai, guess mehnga.
2. **Local free hai, API mehnga hai.** Jo decision ffmpeg/SQLite/Go-daemon locally le
   sakta hai (silence map, language guess, loudness, music-ratio) wo API se nahi maanga
   jaata. API sirf tab, jab text hi uska output ho. Isi se cost 20–100x girti hai.
3. **Original media sacred, copies disposable.** Transcription-copy (16k mono), proxy,
   remux, loudnorm copy — sab tmp me, transcript ke baad delete. Original file kabhi
   destructive edit nahi hota. User ka source hamesha byte-identical rehta hai.
4. **State disk par, RAM me kuch nahi.** Har fix SQLite mapping/checkpoint par khada hai
   (chunk→original-time map, per-segment job ledger, creator lexicon, cache hash).
   8 GB box par crash-resume aur zero-RAM dono free me mil jaate hain.
5. **UI honesty > silent magic.** Jab system unsure hai (crosstalk, stutter, rare language,
   music section) — flag dikhao, suggest karo, confirm lo. Auto-delete ka trust dobara nahi
   banta: ek hallucinated line aur poori transcript par shak ho jaata hai.

In 5 principles ko 40 cases me bar-bar dekhoge — kyunki ye hi "kyun" ka jawab hai.

---

## Case Index (40)

| #   | Case (one-line)                                            | Group |
| --- | ---------------------------------------------------------- | ----- |
| 1   | 1 hr video, sirf 3 min speech — API kharcha 20x kam        | A     |
| 2   | Cost/ETA transcript se pehle dikhana                       | A     |
| 3   | Same file dobara / crash-retry — paisa na dobara lage      | A     |
| 4   | Batch day: 30 files + Groq 429 rate-limit                  | A     |
| 5   | 2 GB movie / Telegram vault file — kya bhejna hai API ko   | A     |
| 6   | Studio WAV 96 kHz/24-bit — bloat ka ilaaj                  | A     |
| 7   | Chhote clips (1 s se kam)                                  | A     |
| 8   | API duration limit — lambe file ka chunking                | B     |
| 9   | Chunk-boundary par word tear                               | B     |
| 10  | Network gir gaya / power chali gayi / API down             | B     |
| 11  | 12+ languages ek video me, English font + Hinglish         | C     |
| 12  | Hinglish code-switch ek hi sentence me                     | C     |
| 13  | Language galat detect (accented English → hi)              | C     |
| 14  | Devanagari/Urdu tofu boxes English font me                 | C     |
| 15  | Rare language ki translation quality                       | C     |
| 16  | Do English songs overlap                                   | D     |
| 17  | Pure music video — bolna hi nahi                           | D     |
| 18  | BGM voice se zyada + quiet master                          | D     |
| 19  | Noise (fan/street/hiss) se silence-detect tootna           | D     |
| 20  | Sargoshi / ASMR speech                                     | D     |
| 21  | Hall reverb (echo tail)                                    | D     |
| 22  | Do log ek saath (crosstalk interview)                      | D     |
| 23  | [Music]/[Applause] bracket tags transcript me              | D     |
| 24  | "Thank you for watching" loop (silence hallucination)      | E     |
| 25  | Intro/outro music hallucination                            | E     |
| 26  | Stutter/retake repeats auto-delete ka risk                 | E     |
| 27  | Corrupt/VFR phone file (WhatsApp mp4)                      | F     |
| 28  | Audio-only file (MP3/podcast)                              | F     |
| 29  | 4K60 5 GB file, 8 GB RAM                                   | F     |
| 30  | A/V offset (audio pehle, video baad)                       | F     |
| 31  | InShot re-export bloat: 5.3 GB / 50 min @14 Mbps           | G     |
| 32  | VFR ~30 fps — frame-seek drift                             | G     |
| 33  | yuvj420p + SD color tags HD par — color shift              | G     |
| 34  | AAC 44.1k stereo → 16k mono ASR copy (6 MB proof)          | G     |
| 35  | 274 micro-gaps + 46 dead zones — ek map, do matlab         | G     |
| 36  | Generation loss (re-encode ka re-encode)                   | G     |
| 37  | Face-cam overlay — filmstrip/crop ki samajh                | G     |
| 38  | Rotating watermark + "STAY CONNECTED" banner               | G     |
| 39  | Hinglish phonetic Whisper output → autocorrect + lexicon   | G     |
| 40  | Video ka energy/emotion arc — intro/teach/demo/outro shape | G     |

---

# Group A — API ka kharcha aur speed

### Case 1: Ghanta-bhar video, sirf 3 min bolna _(diya hua case)_

**Scene:** User 1 hr ki lecture/recording deta hai jisme 57 min silence hai (paused
recording, dead air, waiting) aur sirf 3 min speech.
**Problem:** Poora 1 hr Groq ko bhejoge → ~20x zyada paisa, ~20x zyada wait, aur
silence par Whisper hallucinate karta hai (Case 24).
**Fix:** Transcription se pehle ek **audio map** banao — ffmpeg `silencedetect`/`astats`
child process se speech regions nikalo (noise floor measure karke **adaptive threshold**,
fixed −30 dB nahi). Sirf speech spans ko ek tmp audio file me jodo (0.5 s padding ke
saath), sirf wahi ~3 min API ko do. Concat-time ↔ original-time mapping SQLite me rakho,
taaki cut decisions original timeline par wapas map ho.
**Kyun kaam karega:** Media-level detection local aur free hai (ffmpeg child, Zero-RAM
compliant); API sirf wahi audio sunti hai jisme awaaz hai. Groq per-second-of-audio bill
karta hai — 1 hr → 3 min matlab ~95% saving, upload + inference dono fast. Hallucination
bhi ghategi kyunki hallucination ka ghar hi silence hai. Yehi app ke daemon ka design hai
(chunks + offset_secs) — bas chunks ab speech-region bane, blind splits nahi.

### Case 2: Paise pehle dikhana (cost preview)

**Scene:** User ne 2 hr ki movie daali, Transcript button dabaya, aur baad me pata
chala kitna kharcha hua.
**Problem:** Cost ka andaza nahi hota; badi file par surprise; trust kam.
**Fix:** Transcript button ke upar hi ffprobe se duration nikaalo, current model rate se
**estimate card** dikhao ("~50 min audio ≈ ₹X, ~40 s wait"), aur model choice do
(turbo = sasta-fast, large = accurate). Estimate SQLite me save karo; baad me
actual-vs-estimate compare karke card ko aur accurate banao.
**Kyun kaam karega:** ffprobe sirf header padhta hai — instant aur free; cost model
predictable hai (per audio second). Jab user ko pehle se pata ho, wo galat file par
paisa nahi udayega. Ye Principle 5 (UI honesty) ka seedha roop hai.

### Case 3: Wahi file dobara (dedupe + resume)

**Scene:** App 40-min transcript ke baad crash ho gaya. User ne file dobara drag ki.
Agale din ne wahi video dusre naam se daali.
**Problem:** Poora API spend dobara; time double.
**Fix:** File ka **content-hash** (sha256 stream, ffmpeg se, RAM me poora file nahi)
SQLite me transcript ke saath key karo. Naya job pehle cache check kare. Interrupted
job ko **per-segment checkpoint** ki tarah resume karo — sirf bache hue segments API
jaate hain. Same audio, alag naam → hash match → "transcript already hai, use karein?"
**Kyun kaam karega:** Hashing deterministic hai; transcript pure function hai (same
audio → same text). Per-segment idempotency ka matlab crash ka nuksaan sirf current
segment tak. Hash-streaming RAM-safe hai (poora file memory me nahi).

### Case 4: Batch day — 30 files ek saath + Groq 429

**Scene:** User ek saath 30 voice-notes/recordings daal deta hai.
**Problem:** Parallel API calls → Groq 429 (rate limit), 30 ffmpeg children local RAM
mar dete hain, UI jam, kisi file ka pata hi nahi chalta.
**Fix:** Ek **sequential (ya max-2) worker queue** SQLite me (daemon ke queue ka hi
extension). Har file ka cost estimate list me pehle dikhe — user select/deselect kar
sake. Daemon me token-bucket pacing; 429 aaye to exponential backoff + **queue position
UI me** ("3/30, is file pe chal raha hai").
**Kyun kaam karega:** Bottleneck API ki throughput hai, local nahi — sequential queue
hi honest speed hai. Zero-RAM directive parallelism par pabandi lagata hai. Queue
position dikhane se user ka "system zinda hai" bharosa bana rehta hai.

### Case 5: 2 GB movie / Telegram vault file

**Scene:** User Telegram vault (1.9 GB split chunks) se movie drag karke daala.
**Problem:** Poora container API ko nahi ja sakta (Groq 25 MB/chunk limit), aur video
bytes transcription ke liye bekaar hain.
**Fix:** **Audio-only extraction** child process: 16 kHz mono opus/flac tmp file —
2 GB movie ≈ 25–60 MB audio (is repo ki live proof: 5.3 GB → 6 MB). 25 MB se chhota
to direct chunk; bada to Case-8 wali silence-aligned splitting. Tmp file transcript
ke baad delete.
**Kyun kaam karega:** ASR ke liye sirf speech matters — video bytes ka 99%+ drop
bina accuracy loss. Zero-RAM ka direct fayda: ffmpeg child disk-se-disk stream karta
hai, heap me kuch nahi aata. Telegram vault ke liye bhi: download audio track only.

### Case 6: Studio WAV (96 kHz / 24-bit, 500 MB)

**Scene:** User podcast ka raw WAV daala.
**Problem:** Bytes 10–20x zyada; upload time aur disk I/O barbaad; ASR ko waise bhi
16k mono chahiye.
**Fix:** Wahi audio-only pre-pass: **16k mono FLAC** transcription-copy. Waveform bhi
isi chhote file se banao. Original ko kahin mat chhedo.
**Kyun kaam karega:** Human speech ka content ~50 Hz–8 kHz me hai; 96 kHz sampling
ASR accuracy me kuch nahi badhata. FLAC lossless hai, to transcription-copy original
ke barabar hai. Ek transcode, teen fayde (upload, waveform, disk). Yehi Case 34 ka
general roop hai — live proof: 5.3 GB → 6 MB.

### Case 7: Chhote clips (1 s se kam)

**Scene:** User ne 0.5 s ka clip daala, ya batch me 100 chhote snippets.
**Problem:** Whisper sub-0.02 s audio par error deta hai; 100 alag API calls = fixed
overhead × 100 = latency aur quota barbaad. Is repo ke test suite me iska asli bug
mila tha: silent duck-meme par Whisper ne "What?" likh diya aur bill utha.
**Fix:** **Min-duration guard** (neeche wale ko "too short" mark karo, transcript
skip), aur **micro-clips ko ek request me jodo** (concat + offset map). Daemon ka
no-speech gate (silence + energy check, Groq tak na jaane wala) pehle chale.
**Kyun kaam karega:** API call ki fixed overhead (TLS, queue, model load) duration se
independent hai — batching usi ko amortize karti hai. Duck-meme gate proof hai ki
local check se API call pura bach sakta hai.

---

# Group B — Chunking aur resilience

### Case 8: Lambe files ka chunking (API duration limit)

**Scene:** 3 hr ki kacheri recording ek hi request me nahi jaati.
**Problem:** Mid-speech split → words phat jaate hain, timestamps drift karte hain.
**Fix:** Chunks **silence boundaries par kaato** (Case-1 ka audio map hi boundaries
deta hai), har chunk apna `offset_secs` carry kare, SQLite mapping table original
timeline banaye. Chunk size 25 MB ke andar (16k mono opus me ~2 hr).
**Kyun kaam karega:** Silence boundary par cut = natural pause = koi word adhoora
nahi. Deterministic hai — same file, same map, same chunks. Poora ffmpeg-local, free.
Daemon ka contract (ChunkRequest + offset_secs) isi ke liye bana hai.

### Case 9: Chunk-boundary par word tear

**Scene:** "decision" word do hisso me gaya — "deci" chunk-1 me, "sion" chunk-2 me.
**Problem:** Transcript me toota word; cut preview me galat text; user ka bharosa khatam.
**Fix:** Chunks ke beech **~1 s overlap** rakho; overlap zone ke words ko **reconcile**
karo (same/similar text + paas ke timestamps = ek word, merge). SQLite mapping me
overlap already handled hai kyunki map original-time hai.
**Kyun kaam karega:** Overlap+reconcile streaming ASR ka standard pattern hai — do
aadhe word ek poora ban jaate hain jab overlap unhe dono taraf se dekhta hai. Cost
sirf +1–2% audio ki.

### Case 10: Network gir gaya / power chali gayi / API down

**Scene:** 50-min job 20 min chalne ke baad internet chala gaya; ya Groq down hai.
**Problem:** Poora kaam barbaad lage; restart par paisa dobara.
**Fix:** Do-layer: **(a) per-segment checkpoint** — job SQLite ledger se resume, sirf
pending segments retry. **(b) Plan-B offline** — transcript na ho to bhi **silence-cut
chalta hai** (audio map se), transcript baad me fill hota hai; UI me "transcript
pending" badge.
**Kyun kaam karega:** Cut decision ka bada hissa (silence trimming) local hai —
transcript uska garnish hai. Dono decouple karne se app API ke death par bhi usable
rehta hai. Resume ledger SQLite-pattern hai jo repo (queue/locks) pehle se use karta
hai — naya mechanism nahi, same idea.

---

# Group C — Bhasha aur script

### Case 11: 12+ languages ek video me _(diya hua case)_

**Scene:** Travel vlog — 12+ languages bol gaya; app English font + Hinglish display
use karti hai.
**Problem:** (a) segments me language flip-flop, (b) Devanagari/Tamil/Arabic text
English font me tofu boxes, (c) user ko Hinglish chahiye.
**Fix:** Teen layers: **(i)** Whisper auto-detect per segment rakho, par display me
"lang" badge dikhao (honesty). **(ii)** UI ke liye **task=translate** mode offer karo —
sab English me fold, ek API flag, extra call nahi. **(iii)** Hinglish/romanization
chahiye to **Gemini flag-pass** (daemon `/v1/analyze` already wired) se romanize
karwao — destructive nahi, original text SQLite me safe. Font fallback (Case 14)
display layer handle kare.
**Kyun kaam karega:** Whisper 30-s windows per language detect karta hai — multilingual
me wobble normal hai, badge se user ko truth milti hai. Translation ek flag hai, paisa
wahi audio ka. Romanization ko LLM-pass dena Python-free hai aur architecture me
Gemini pehle se hai. Original text safe = kabhi bhi re-run possible.

### Case 12: Hinglish code-switch (ek hi sentence me do bhashayein)

**Scene:** "yaar wo decision galat tha bro" — ek sentence hi Hindi+English.
**Problem:** Output script wobble karti hai; text padhna mushkil; accuracy flags kharab.
**Fix:** Language detect **per request pin** karo (e.g. hi), output ko post-pass me
normalize karo (Gemini correct-pass ya local string rules); raw Whisper text
(`original_text`) SQLite me rakho, sirf display normalize ho.
**Kyun kaam karega:** Code-switch Whisper ki strong side hai — accuracy theek rehti
hai, problem sirf presentation ki hai. Pinning se per-request auto-detect ka extra
kaam bhi skip hota hai (faster + cheaper). Daemon ka `prompt` field isi ka hook hai:
"Hinglish tech vocabulary" bias already planned hai.

### Case 13: Language galat detect (accented English → hi)

**Scene:** Indian-English speaker ki video; Whisper ne language=hi pakda aur Hindi
script me likh diya.
**Fix:** UI me **detected-language chip + override dropdown** (pin en/hi/ta/…);
pinned language API ko bhejo. Pin hone par auto-detect skip.
**Kyun kaam karega:** Language detect sirf first 30 s par hoti hai — accent wahan
misleading ho sakta hai, aur user ke paas ground truth hai. Detect-skip = latency
kam. Principle 5: user ko control, system ko guess.

### Case 14: Tofu boxes (Devanagari/Urdu English font me)

**Scene:** Transcript panel me Hindi text □□□ dikh raha hai.
**Fix:** **Font-fallback stack** (UI font + Noto Devanagari/Naskh fallbacks) + CSS
`dir="auto"` per segment. Original text ko destructive transliteration se kabhi
replace mat karo — sirf display normalize (Case 12).
**Kyun kaam karega:** Rendering issue OS/browser layer par solve hota hai, API layer
par nahi. Fallback fonts ek hi baar bundle me aate hain, per-file cost zero.
Transliteration ko LLM-pass (Case 11) dena reversible aur optional hai.

### Case 15: Rare language ki translation quality

**Scene:** Bhojpuri/Maithili bol gaya; Whisper ne detect kiya, par translation ajeeb.
**Fix:** **Source text primary display**, translated text secondary + "via
translation" badge; re-run option pinned language ke saath.
**Kyun kaam karega:** Whisper jitni saaf bhasha likhta hai, uske aage translation
quality ka bottleneck hai. Ground-truth text rakhne se user turant cut kar sakta hai;
translation baad me improve ho sakti hai bina re-transcribe kiye. Ek hi API call ka
paisa, do fayde.

---

# Group D — Music aur noise

### Case 16: Do English songs overlap _(diya hua case)_

**Scene:** Montage me do English tracks cross-fade hote hain, beech me thoda dialogue.
**Problem:** Whisper lyrics hallucinate karta hai; API ka paisa waste; timeline par
garbage text; cut-suggestions meaningless.
**Fix:** Case-1 ke audio map se **speech-ratio** nikalo. Speech ratio bahut kam (≈5%)
→ file ko **"music project"** mark karo: transcript skip/optional, timeline
**energy/beats** se banao (waveform peaks local hain), jahan thoda speech hai sirf
wahan API bhejo, aur UI lyrics-warning dikhaye.
**Kyun kaam karega:** ASR ka kaam bolna hai, gaana nahi; app ka use-case cutting hai,
lyrics nahi. Speech-ratio neeche = API call ka ROI negative — **reject hi sabse sasta
"accurate" answer hai**. Energy timeline free hai. Kharcha ~100% bacha.

### Case 17: Pure music video (gaana hi gaana)

**Scene:** User ne song track daala, koi bolna nahi.
**Fix:** Case-16 ke detector ka extreme case: **"no speech found" card** dikhao,
transcript skip, project ko **waveform-first editing mode** me daalo (silence-cut ki
jagah beat/energy cut).
**Kyun kaam karega:** Honest UI — feature jo nahi hai uska button na ho. Daemon me
no-speech gate already tested hai (duck-meme test: 0 API calls). API call reject
karna time + paisa + hallucination teeno bachata hai.

### Case 18: BGM voice se zyada (vlog/music bed) + quiet master

**Scene:** Vlogger background music loud rakhta hai; baat dhundhli hai. (Doosra
roop: master recording hi −20 LUFS quiet hai.)
**Fix:** **Loudness pre-pass** (ebur128/astats): voice-to-music ratio aur master level
measure karo. Zaroorat ho to sirf **transcription-copy** par ffmpeg filters
(bandpass/afftdn/loudnorm) chalao — original untouched, tmp copy discard. Silence
threshold bhi isi measurement se aaye (Case 19).
**Kyun kaam karega:** Ek file ka measurement → per-file decision; global thresholds
jaisa fragile kuch nahi. Filters disk par tmp copy par lagte hain, RAM par nahi —
Zero-RAM safe. Original media sacred rehta hai (Principle 3). Live video iska proof:
−21.4 LUFS, peak −0.2 dBFS — aisi files par normalize/de-cllip decision measurement
ke bina guess hi hai.

### Case 19: Noise (fan/street/hiss) se silence-detect tootna

**Scene:** Phone recording fan ke neeche — "silence" bhi −28 dB hai; −30 dB fixed
threshold kuch detect hi nahi karta → koi cut nahi. Ulta: studio recording me breaths
tak cut bana dete hain.
**Fix:** **Per-file adaptive threshold**: noise floor measure karo (quietest
percentile astats se), threshold = floor + margin. UI me ek sensitivity slider
(conservative / balanced / aggressive).
**Kyun kaam karega:** "Silence" absolute nahi, relative hota hai. Fan-phone me room
tone −28 dB hai aur speech −6 dB; studio me −60 vs −18 — **relative margin dono par
kaam karta hai**. Measurement pehle, decision baad me (Principle 1).

### Case 20: Sargoshi / ASMR speech

**Scene:** Whispered video — speech ki energy noise floor ke barabar.
**Problem:** Adaptive threshold bhi fail; whispered words cut ho jaate hain.
**Fix:** **Sensitivity slider + speech-tail padding** (cut boundaries ko +0.4 s) +
"don't auto-cut this region" per-segment override. Daemon me optional **local VAD**
(ONNX, CPU) energy-heuristic ki jagah — Go/Rust-friendly, Python-free.
**Kyun kaam karega:** Whisper-speech aur noise statistical overlap karte hain —
perfect auto-detection impossible hai. Jab detection unreliable ho, control user ko
do (Principle 5). ONNX VAD CPU par chal sakta hai; default ffmpeg-heuristic rakhna
cheap hai — VAD sirf "ASMR mode" me.

### Case 21: Hall reverb (echo tail)

**Scene:** Auditorium recording — speech ke baad tail 0.5 s tak goonjti hai.
**Problem:** Reverb tail ke baad ke micro-gaps ko detector cuts bana deta hai; har
sentence ke baad chhote cuts.
**Fix:** **Min-silence length badhao** (tail ko silence nahi, speech ka hissa maano),
aur detection ke baad **regions ko merge karo jo 1 s se kam gap par hain** (Case 35
ka merge rule, general form).
**Kyun kaam karega:** Reverb energy-profile me speech jaisa dikhta hai — silencedetect
tail ko speech samajh lega (theek) par tail ke baad ke gaps par cut bana dega (galat).
Gap-merge absorbs karta hai. Cost: zero, same map par classification.

### Case 22: Do log ek saath (crosstalk / interview)

**Scene:** Podcast me guest host ke bolte waqt bol padta hai.
**Problem:** Silence detector "pauses" dekhta hai jo actually competing speech hai —
auto-cut content delete kar deta hai.
**Fix:** Overlap detection (low SNR + no-gap regions) → segment par **"crosstalk
likely" flag**; auto-cut in regions ko kabhi na chhue, sirf manual allow.
**Kyun kaam karega:** Deletion ke liye false-negative (cut nahi karna jab hona chahiye)
false-positive (content delete) se hamesha better hai. Flag-and-preserve Principle 5
hai. Whisper bhi overlapping speech me low-confidence hota hai — dono signals agree
karte hain.

### Case 23: [Music] / [Applause] bracket tags

**Scene:** Transcript me "[Music]", "[Applause]", "[Door slams]" — cut-preview text
ganda, user confuse.
**Fix:** Post-pass bracket tags parse karo → **UI icon** (♪, 👏), cut text me exclude;
SQLite me tag rakho.
**Kyun kaam karega:** Ye tags Whisper ka **useful signal** hai (non-speech hai) —
delete nahi, repurpose karo. Bracket region = mostly auto-cut-friendly region. Ek
string-level pass, free.

---

# Group E — Whisper failure modes

### Case 24: "Thank you for watching" loop (silence hallucination)

**Scene:** Lecture ke end me 2 min silence — Whisper ne 30 baar "Thank you for
watching." likha.
**Fix:** Root fix Case 1 me hi hai (silence API tak pahunchne hi na de). Phir bhi
defense-in-depth: **post-pass repeated n-gram dedupe** (same text + clustered
timestamps) → single instance + "(repeated)" flag.
**Kyun kaam karega:** Whisper ki hallucination non-speech audio par concentrated hai —
input hi clean kar do. Output-side dedupe cheap insurance hai. Is repo ke daemon me
no-speech gate + word-over-silence-drop rules already isi family ke proofs hain.

### Case 25: Intro/outro music hallucination

**Scene:** Song intro 20 s — transcript me random "lyrics"/speech.
**Fix:** No-speech regions (audio map) ko transcript me **♪ placeholder** do; chunking
un regions ko skip kare.
**Kyun kaam karega:** Intro/outro #1 hallucination zone hai (music + no speech).
Region-skip free hai aur hallucination ka input hi hata deta hai. Live video ka
silent disclaimer card (0 s se silence) iska textbook example hai.

### Case 26: Stutter/retake repeats auto-delete ka risk

**Scene:** Speaker ne "I mean... I mean the third option" bola; app ka retake-cut
dono delete kar deta hai — par dusra repeat emphasis tha.
**Fix:** Auto-delete ki jagah **highlight + one-click confirm**; fillers (um/uh/hmm)
alag category, default optional; daemons `tone_profile` field (analyze pass) me
creator ka style describe hota hai — intentional restatement vs fumble.
**Kyun kaam karega:** Deletion irreversible hai (undo ho sakta hai par trust nahi).
Repetition = emphasis ho sakti hai — model galat ho sakta hai, user nahi.
Suggest-not-act Principle 5 hai, aur tone-profile already architecture me hai.

---

# Group F — Media aur decode

### Case 27: Corrupt / VFR phone file (WhatsApp mp4)

**Scene:** WhatsApp se aayi mp4 — metadata toota, seek jagah-jagah atakta hai.
**Fix:** **ffprobe import gate**: duration/codec/seek health-check import par hi.
Kharab ho to **remux copy** (`-c copy`) tmp me banao — fast, lossless; preview proxy
bhi yahin bana sakte ho.
**Kyun kaam karega:** Remux seconds leta hai aur bytes decode nahi karta; timeline
ke saare operations phir clean container par chalte hain. Import-time gate =
problems front-loaded, debugging nahi. Ye Case 32 (VFR) ka bhi home hai.

### Case 28: Audio-only file (MP3 / podcast)

**Scene:** User ne MP3 daala; video preview blank.
**Fix:** Project type detect karo: **"audio project" mode** — waveform + transcript +
cut full; filmstrip/preview stage gracefully disabled (grey card, label ke saath).
**Kyun kaam karega:** Cutter ka core kaam audio-based hai; MP3 usme fully participate
karta hai. Feature-absence ko graceful dikhana crash se better hai (Principle 5).

### Case 29: 4K60 5 GB file, 8 GB RAM

**Scene:** Sabse common heavy case.
**Fix:** Transcript ke liye sirf audio (Case 5), waveform chhote 16k file se,
filmstrip **sparse thumbnails** (ffmpeg child, per-thumb), preview stage **proxy
copy** par (Case 27 me bani), original file full-length kabhi decode nahi hota.
**Kyun kaam karega:** Har layer apni chhoti copy use karti hai — yehi Zero-RAM
directive hai. 5 GB file ka RAM footprint ≈ 0, kyunki koi full-media buffer exist
hi nahi karta. Live proof: 5.3 GB file se sirf 6 MB audio nikla, koi frame-decode
nahi hua.

### Case 30: A/V offset (audio pehle, video baad)

**Scene:** Camera late start hua — transcript timestamps video time se 0.7 s shifted.
**Problem:** Transcript accurate hai par cut points video par galat jagah lagte hain.
**Fix:** Import par **A/V offset measure** (ffprobe start_time + first-non-silent
frame check); timeline mapping me offset apply (SQLite per-project).
**Kyun kaam karega:** Ek measurement, permanent fix — warna user har cut manually
adjust karta. Offset per-file hota hai, global assumption tootega.

---

# Group G — "InShot-type mobile video" (upar wali live file ke 10 cases)

Ye group upar ke **measured evidence** par khada hai — har case me wahi file ka data
quote hai. Jyadatar mobile-edited videos isi family ki hongi: InShot/VN/CapCut re-export,
jump cuts, face-cam overlay, screen recording, Hinglish speech.

### Case 31: 5.3 GB / 50 min @14 Mbps — re-export bloat _(live proof)_

**Scene:** Ye file khud — 50 min ki notes-app tutorial, 1080p, **14 Mbps**, 5.3 GB.
InShot ne source ko dobara encode karke phoonk diya; content to screen recording hai,
jiska visual entropy kam hota hai.
**Problem:** Disk par 5.3 GB (8 GB box me tmp + app data ke liye tight), import/wait
dhire, aur user ko lagta hai "heavy video" hai. Processing ko 14 Mbps ki zaroorat hi
nahi — sirf final render ko.
**Fix:** Import gate me ffprobe se **"bytes vs duration" sanity card** dikhao ("50 min,
5.3 GB — InShot bloat"), aur pipeline ko **audio-first** banao (Case 5/34): transcript,
waveform, cut-sab audio se; video bytes sirf preview/proxy aur final render me chhuete
hain. Optional: "archive copy" advice (1080p @4 Mbps = ~1.5 GB, 70% bachat) — user
chahe tab, kabhi auto nahi.
**Kyun kaam karega:** Poora pipeline 6 MB audio par chal sakti hai (live proof) — 5.3 GB
file ko humne **poora decode kiye bina** transcript nikaal liya. Disk-space precheck
se beech me "no space" wala half-done state kabhi nahi aata. Kharcha zero, sab local.

### Case 32: VFR ~30 fps — frame-seek drift _(live proof)_

**Scene:** ffprobe: r_frame_rate 30/1 ms nahi, **avg 29.998** — InShot exports
variable-frame-rate hote hain; 89,701 frames, timebase 1/1000 ms.
**Problem:** Frame-index math (frame #N = time N/30) 50 min par seconds me drift ho
jaata hai — cut point transcript ke hisaab se sahi, video par aage-peeche.
**Fix:** Import par VFR detect (ffprobe avg vs r_frame rate mismatch); timeline
**PTS-based** seeking use kare, frame-count math nahi. Optional: preview proxy ko
constant-frame-rate bana do (ek hi baar, proxy me) — original kabhi nahi.
**Kyun kaam karega:** Transcript aur cut decisions time-based (seconds) hain —
PTS seek unke saath exact baithta hai; frame-index math VFR par by-definition galat
hai. Proxy CFR preview smooth kar deta hai bina original ko chhue (Principle 3).

### Case 33: yuvj420p + SD color tags HD par — color shift _(live proof)_

**Scene:** File ke tags: **bt470bg / smpte170m / full-range (pc)** — SD-era color
matrix HD video par. Kuch decoders/players ise limited-range bt601 samajhte hain.
**Problem:** Preview stage aur proxy me colors washed/shifted dikhte hain; user ko
lagta hai app ne quality kharab ki. Sketch-art background (flat mint green) par shift
turant dikhta hai.
**Fix:** Proxy/preview copies me **explicit standardized flags** (bt709, limited
range) lagao — ek hi transcode decision, import ke waqt. Original ko kahin mat
chhedo; UI me "source color metadata non-standard" info chip (ek baar, per project).
**Kyun kaam karega:** Problem metadata ki hai, pixels ki nahi — downstream copies ko
standard flag dena deterministic preview deta hai har device par. Chip se user ka
"app ne bigada" wala shak chala jaata hai. Free, one pass.

### Case 34: AAC 44.1 kHz stereo → 16k mono ASR copy _(live proof: 5.3 GB → 6 MB)_

**Scene:** Measured: is file ka audio extract (16k mono opus) **6.0 MB** = 0.11% of
5.3 GB. Daemon ka contract bhi yahi hai — chunks ≤25 MB, `offset_secs` mapping.
**Problem:** Agar app original audio (189 kbps stereo) ko hi API ko de, to upload 6x
bada hota, waveform bhi heavy file se banta, aur 25 MB/chunk limit jaldi tootati.
**Fix:** Import ke baad **ek hi baar** transcription-copy banao (16k mono opus/flac) —
isi se waveform banao, isi ko chunk-split karke daemon ko do, SQLite me mapping rakho,
kaam hone par tmp delete. Original audio stream kabhi re-encode nahi hota (final render
me stream-copy ya alag pass).
**Kyun kaam karega:** Speech ~50 Hz–8 kHz me hai — 16k mono me ASR accuracy same.
6 MB chunk Groq free tier me aaram se jaata hai; upload seconds me. Ye file hi
proof hai: poora transcript bina ek bhi video-frame decode kiye ban gaya.

### Case 35: 274 micro-gaps + 46 dead zones — ek map, do matlab _(live proof)_

**Scene:** Is file ka silence map: **274 gaps** — 115 chhote (<1.5 s, breathing/edit
seams), 113 medium (1.5–5 s), **46 bade (>5 s, longest 87.4/52.7/49.9 s)**. Transcript
me 46 segments <2 s aur 19 segments ≤4 chars ("झाल" ×5) inhi ke aaspaas hain.
**Problem:** Ek flat cut-list: 274 buttons timeline par = noise; par 46 bade zones
**23:28 silence** ka majority hain — asli cutting opportunity. Micro-gaps ko cut kiya
to video kankad-kankad ho jaata hai.
**Fix:** Same map par **two-tier classification**: micro-gap (<1.5 s) = merge into
neighbors (edit seam hai, cut nahi); bada zone (>5 s) = **cut candidate** card with
duration. UI dikhaye: "46 bade gaps = ~X min cuttable" — 274 nahi. Reverb wali files
ke liye merge threshold Case 21 jaisa per-file adaptive.
**Kyun kaam karega:** Detection to pehle se hai (free) — bas classification ka
threshold kaam. 274 → 46 ka collapse UI ke decision-load ko 6x ghatata hai, aur
"kitna katega" ka honest number pehle hi mil jaata hai. Live video me ye kaam
karta dikha: hallucination zones bhi yahi 46 the (Case 24/25 ka input).

### Case 36: Generation loss — re-encode ka re-encode _(live proof)_

**Scene:** Ye file pehle hi InShot ke re-encode se guzar chuki hai (source ka 2nd
generation). 14 Mbps bloat ne blocks chhupa rakhe hain — par final render ke re-encode
par wo dikhenge, especially sketch-art ke flat gradients me (banding).
**Problem:** Pipeline me 2 encodes ho sakte hain (proxy + final render) = 3rd/4th
generation, quality visibly girti hai, aur user ko video ka "pata nahi kyun kharab
lagta hai" feeling.
**Fix:** **Encode-count discipline**: proxy low-res par high-enough per-pixel bitrate
(banding na aaye), final render ek hi pass, aur render settings content-aware
(quiet screen-recording ko aggressive CRF ki zaroorat nahi). Har project SQLite me
"encodes so far" counter — 2 se zyada ho to UI warn kare.
**Kyun kaam karega:** Generation loss additive hai — count karna use rokne ke barabar
hai. Screen-recording content (low entropy) me high bitrate by definition wasteful,
to render ka quality-vs-size decision measurement-based ho sakta hai, guess par nahi.

### Case 37: Face-cam overlay (top-right) — filmstrip/crop ki samajh _(live proof)_

**Scene:** Is video me presenter ka face-cam **top-right** chipka hai, screen
recording ke upar; gestures (pointing, hand-on-face) frame ke edge tak aate hain.
**Problem:** Scene-change detection aur filmstrip thumbnails hand-movement ko "scene"
samajh lete hain — har thumb alag dikhta hai jabki screen content same hai; crop
suggestions (shorts/reels) face-cam box ko kaat dete hain.
**Fix:** Import par **static-overlay region detect** karo (sparse frames ka variance
check — ffmpeg child, free): top-right box static hai = overlay. Filmstrip/thumbs
us region ko mask kare; face-cam box ko project metadata me "safe crop zone" ke
roop me rakho.
**Kyun kaam karega:** Overlay static hai — variance analysis per-frame nahi, sparse
sampling se hi pakda jaata hai (Zero-RAM). Thumbs phir screen-content ke hisaab se
stability dikhati hain, aur reels-crop face-cam ko kaat kar faceless karne se bachta hai.

### Case 38: Rotating watermark + "STAY CONNECTED ON" banner _(live proof)_

**Scene:** Is file me watermark **rotate** hota hai: LinkedIn (4 min) → Instagram
(12 min) → YouTube (20 min) → "STAY CONNECTED ON" banner (28 min+), handle
`EngrTarunDilwal` bottom-left.
**Problem:** Perceptual checks (thumbnail-dedupe, scene-stability) watermark-icon
change ko content change samajh sakte hain; blur/crop suggestions watermark ko content
maan kar galat jagah blur kar sakte hain.
**Fix:** Watermark region ko **learn-once** karo (bottom-left static region, Case 37
ke variance pass me hi pakda jaata hai), us region ko perceptual checks se exclude
karo, aur per-section watermark metadata SQLite me rakho.
**Kyun kaam karega:** Watermark static-but-changing-content hai — variance analysis
ise "content nahi" classify kar deta hai. Ek hi pass (Case 37 wala) do kaam karta hai.
Blur/sab kuch user-controlled rahta hai, auto-destructive nahi.

### Case 39: Hinglish phonetic Whisper → autocorrect + creator lexicon _(live proof)_

**Scene:** Transcript me: RAG → "**Retrive Argument Document General**"; birthday
song → "**बर्थडे सोंद**"; LLM → एलएम/एलेलम/एलएलम; ChatGPT → **चैनल जीपीटी**; flagship
models → "**फ्लेक्सिप एडिया**". Script bhi wobble: 350/354 segments Devanagari (Hinglish
boli par Whisper ne Hindi script chuni).
**Problem:** Phonetic spelling par retake/fumble flags galat lagte hain; user ko
Hinglish display chahiye; tech terms har video me bar-bar tootte hain.
**Fix:** Daemon ka `/v1/correct` pass (already wired) + **creator lexicon** SQLite me:
channel ki vocabulary ("RAG", "LLM", "Vector Database", "Context Window", "Hybrid
Search", "UPI ID", channel handle, purani videos ke corrections) ek baar seekho, har
nayi video par prompt-bias banao. `original_text` field me raw Whisper rakhta hi hai —
destructive nahi.
**Kyun kaam karega:** Daemon ka khud ka comment yahi bolta hai — phonetic spelling
flag-accuracy ko ghatati hai, isliye correct pehle chalta hai. Lexicon persistent hai:
cost ek baar per word, fayda har video. Ye video ke 354 segments ka whole-audio call
ek baar hua — next video par lexicon wahi terms pehle se sahi likhega.

### Case 40: Video ka energy/emotion arc — intro/teach/demo/outro shape _(live proof)_

**Scene:** Is video ka arc data me saaf hai: **0–87 s silent disclaimer card** (0 s
se silence), 14 s par intro **retake ke saath** ("हेलो एंड वेलकम..." 2×), 830–990 s
**jump-cut dense teaching** (phrase-per-segment), 961–1078 s **demo-typing dead zone**
(jis par Whisper hallucinated), 2214–2299 s **UPI example** ka sharp precise section,
2896 s ke baad **outro** (part-2 hook + "**सब्सक्राइब नहीं करोगे तो मेरे खाते में पैसा
कैसे आएगा**" joke). LRA 6.6 = voice steady; energy emotions gestures me hai (frames),
pace me hai (100 wpm, "समझ" 29 segments, "basically" 12).
**Problem:** Flat transcript me "video ki shape" nahi dikhti — user ko nahi pata kaunsa
hook, story, ya dead-zone kaunsa hai; cut-suggestion seedha sabhi silence par chala
jaata hai aur **outro joke / comment hooks / intro** bhi kat jaate hain (creator ka
engagement paisa).
**Fix:** Audio map + transcript se **shape strip** banao (sab local, free): intro
(positional — start par bada gap), teach zones (speech density high, pace steady),
story zones (long continuous speech, wahi "ठग्गू अलवाई"/"chor-police" jaise analogies
— repeat-pattern-free long segments), demo-typing zones (silence + screen unchanged),
outro (end par CTA words: subscribe/comment/part — lexicon se match). Cut-suggestions
shape ko respect karein: dead zones cut, hooks/intro/outro **suggest-keep** (Principle 5).
**Kyun kaam karega:** Shape ke saare inputs pehle se hain — silence map (already),
segment lengths, pace, lexicon match (Case 39). Koi extra API call nahi. Is video par
ye kaam karta dikha: 46 dead zones = demo/intro/outro thi; hooks (कमेंट/सब्सक्राइब ×8/5)
transcript me already tagged ke barabar hain. Creator ka style analogies hai — aur
analogies hi is video ke sabse valuable segments hain, jo flat auto-cut hamesha
bachata nahi.

---

## Closing note

Ye 40 cases isi do meta-questions par ghate hain: **"API ko kya dena hai"** aur
**"original ko kya chhoona hai"**. Group G ke live numbers (5.3 GB → 6 MB, 274 → 46,
350/354 Devanagari, 5× retake cluster) ye bhi prove karte hain ki poora playbook
**free tools + local measurements** par khada hota hai — na budget chahiye, na GPU,
na RAM.

---
---

# PART 2 — MiMO V2.6 Addendum: Review · Bugs · Hybrid Verification · Naye Cases · HLD

> **Signature: MiMO V2.6** (opencode / mimo-v2.6-flash-free) · 2026-11-12
>
> **Upstream:** GLM 5.3 ke 40 cases **bilkul untouched** hain — koi line delete ya
> edit nahi ki gayi. Ye part sirf **append** hai: meri rai, bugs, hybrid
> verification design, naye cases 41–52, aur HLD.
>
> **Scope:** analysis only — **koi code nahi**. Is MD ke basis par baad me
> multi-agents repo me code karenge (P0/P1/P2 build order M6 me hai).
>
> **Evidence jo maine padha (ground ke liye):**
> - `docs/EDGE_CASES_40.md` (GLM 5.3) — poora
> - `temp\opencode\inshot\transcript_digest.txt` (354 segments) + `audio_analysis.txt`
>   (ebur128 + silencedetect raw) — cross-check ke liye
> - Repo source (bugs wahan se nikle, guess nahi): `go/internal/vad/vad.go`,
>   `go/internal/api/server.go` (runTranscribe), `go/internal/cloud/cloud.go`
>   (confidence filter, word attach), `go/internal/model/model.go` (Segment/Words)

---

## M0. Meri overall rai (ek paragraph)

Direction **bilkul sahi** hai — measure-first, local-first, suggest-not-act,
original sacred. GLM 5.3 ne 40 cases me kya nahi kiya wo do cheezein: **(1)** sab
kuch ek-ek free tool par chhod diya har decision par — jabki "hybrid multi-free-tool"
(2-of-3 voting) se galti ki gunjais kahin kam hoti, aur **(2)** playbook aur asli
daemon code ek dusre ko nahi jaante — Case 1 ka speech-span concat daemon ke
`offset_secs` scalar contract se takraata hai, Case 19 ka "astats percentile" method
chalta hi nahi, aur live evidence se do aise hallucination segments nikle jo abhi ke
segment-level gate se bach jaate hain. Neeche har case ki rai (M1), phir wahi bugs
evidence ke saath (M2), phir hybrid verification matrix (M3), phir aapka
**Groq + ElevenLabs → Gemini ensemble** budget ke saath (M4), naye cases (M5), aur
HLD (M6).

---

## M1. Review table — 40 cases par MiMO V2.6 ki rai

Rai symbols: ✅ = jaisa hai waisa sahi · 🟡 = sahi par extend karo · 🔴 = method me
kami, sudharna zaroori (detail M2 me).

| # | Rai | Ek-line addendum (meri suggestion) |
|---|---|---|
| 1 | 🟡 | Core win ✅, par concat spans ke liye scalar `offset_secs` nahi chalega → span-map contract zaroori (B1 / Case 43). |
| 2 | 🟡 | Estimate card ab **pipeline-wise** price kare (groq-only vs ensemble) aur ETA dikhaye — ensemble me Groq ∥ Scribe parallel, ETA = max, sum nahi (M4). |
| 3 | 🟡 | File-hash dobara-export ko nahi pakadta (same audio, naya container) → **audio-hash** primary key + cache key me model+language+prompt-version bhi (B6, Case 45). |
| 4 | 🟡 | Sahi — ledger me TPD/reset-time dikhao aur ab **multi-key rotation** bhi chahiye (4×11labs) (Case 42). |
| 5 | 🟡 | Sahi — ek cheez missing: multi-track files (commentary/default track trap) me **kaunsa audio track** chunna hai, wo import gate me decide ho. |
| 6 | ✅ | Solid, koi objection nahi. Ek WAV banao jo VAD bhi padhe aur upload usi se ho (do copies nahi). |
| 7 | 🟡 | Min-duration guard **user ke explicitly imported clip** par fail-open: skip nahi, "manual-only" mark. Micro-batch bhi span-map se hi (B1). |
| 8 | ✅ | Plus fallback: silence-map me koi gap hi na ho (continuous speech) to word-timestamp boundary par split — **mid-word kabhi nahi**. |
| 9 | ✅ | Reconcile original-time par chale (span-map ke baad) + overlap se duplicate-word drop compulsory. |
| 10 | ✅ | Doc ko code se align karo: `FailedChunks` + `StatePartial` already hain (server.go). Resume par VAD gate dobara chale (no-speech chunks re-upload nahi). |
| 11 | 🟡 | `task=translate` sirf **optional view** hai — primary content Hinglish/Devanagari hi rahe, warna meaning change ho jaata hai. |
| 12 | 🔴 | Code **first chunk** ki language pin karta hai — bootstrap risk (pehla chunk music/nonsense → poora job galat) → section-wise re-pin (B4 / Case 44). |
| 13 | ✅ | Local **script-ratio pre-check** (Devanagari% vs pinned lang) user ko override suggest kare — wo dikhe usse pehle ki galat detect hua. |
| 14 | ✅ | Display-layer only, destructive nahi — bilkul sahi. |
| 15 | ✅ | Source-primary + "via translation" badge — sahi priority. |
| 16 | ✅ | Plus ensemble ka naya signal: do STTs ke **lyrics-disagreement** = music hona free proof (M3). |
| 17 | ✅ | Code already `succeedNoSpeech` return karta hai — doc aur code aligned. |
| 18 | 🟡 | `afftdn` i3 par 50-min file par slow hoga — filter **sirf** tab chalo jab measurement kaho (SNR kharaab), 16k copy par, aur ETA card me CPU time dikhao. |
| 19 | 🔴 | "astats percentile" method technically nahi chalta (astats whole-file stats deta hai, time-percentile nahi) → ebur128 momentary series (already produced) ka **10th percentile** = noise floor (B10). |
| 20 | ✅ | `vad.go` ka peak-relative threshold pehle se ASMR ka partial ilaaj hai; slider = absFloor override, sahi design. |
| 21 | ✅ | Reverb **tail measure** karo (energy fall-off) aur cut-padding me add — fixed 0.4s nahi, per-file. |
| 22 | 🟡 | Detection vague hai — free signal: stereo files me **L/R channel correlation drop** (do mics) mono par skip; flag-only rahe, sahi hai. |
| 23 | ✅ | Local regex pehle; Gemini pass sirf tab jab regex ambiguous. |
| 24 | 🟡 | Dedupe zaruri, par root fix: **3-signal hallucination filter** (B7) + prompt hygiene (B5) — dedupe sirf last line of defense. |
| 25 | ✅ | Skip-regions + prompt hygiene dono — sahi. |
| 26 | ✅ | Pehle **local fuzzy clustering** (word-timestamp text, free), Gemini sirf ambiguous clusters par — cost control ke liye. |
| 27 | 🟡 | Remux + ek aur: `-fflags +genpts` (missing timestamps) aur probe `-v error` se parse. |
| 28 | ✅ | Graceful grey-card — sahi. |
| 29 | 🟡 | Thumbs bhi **throttled** (max 1 ffmpeg child) — Case 4 ka parallelism rule filmstrip/thumbnail generation par bhi lagta hai, warna 30 children = RAM death. |
| 30 | 🟡 | `start_time` aksar **0** hota hai edit-list ke saath → free cross-check: first-audio-energy vs first-scene-change (Case 51, elst/CTS trap). |
| 31 | ✅ | Disk precheck gate fix me already likha hai — sahi. Original ko kabhi dobara copy mat karo. |
| 32 | 🟡 | Export me **hybrid seek**: pehle keyframe tak fast seek (`-ss` before `-i`), phir precise decode seek — accurate cut + speed dono. |
| 33 | ✅ | Explicit flags **dono derived copies** par (proxy + render), original untouched — sahi. |
| 34 | ✅ | Sabse strong proof — 5.3 GB → 6 MB, koi frame decode nahi. |
| 35 | 🟡 | **Medium tier (113 gaps) orphan hai** — na merge na cut → third disposition + context-aware rule (B8 / Case 46). |
| 36 | 🟡 | Counter theek hai, par asli fix: render **hamesha ORIGINAL se** (proxy→final chain mat), aur keyframe-snapped **stream-copy fast path** (B12 / Case 47). |
| 37 | ✅ | Variance pass overlay **aur** watermark (Case 38) dono ka kaam karega — ek pass, do fayde, sahi. |
| 38 | 🟡 | Single-template nahi — rotating watermark + wider banner ke liye **corner grid-cell mask** (region-based, template-based nahi). |
| 39 | 🟡 | Lexicon + **ensemble agreement** se confidence badhao; Gemini correct sirf low-agreement segments par (M4). |
| 40 | ✅ | Shape strip ke saare inputs pehle se hain; hooks ka detection lexicon se **free** — koi extra API nahi. |

**Scorecard:** 17 ✅ · 19 🟡 · 4 🔴 (12, 19 + do method-level B-list me). Overall:
playbook grade **A-** — direction solid, integration aur verification layer missing
tha, wo neeche hai.

---

## M2. Bugs & mismatches (doc + live repo code) — B1 se B12

Har bug me: kahan hai → evidence → fix direction. **Ye future agents ke acceptance
criteria hain** — inke bina koi bhi related PR incomplete.

### B1 — Speech-span concat vs daemon ka scalar `offset_secs` (architectural)
- **Kahan:** Case 1/7 fix ↔ `model.ChunkRequest.OffsetSecs` ↔ `server.go:656`
  (`seg.StartSecs - chunk.OffsetSecs`).
- **Bug:** Case 1 kehta hai bahut saare speech spans jod kar ek file bhejo — par phir
  chunk ke andar time **concat-time** hai, aur har span ka apna original-offset hai.
  Ek scalar offset poore chunk par apply hota hai → **har span ke baad timestamps
  drift** (274 gaps × padding error = minutes of drift by end).
- **Fix direction:** `span_map[]` = `[(concat_start, concat_end, orig_start), ...]`
  per chunk; response ko is table se original-time me remap. SQLite me persist.
  Alternative (simpler, zyada API calls): spans ko hi alag chunks banao jab span chhota
  ho — but micro-batch (Case 7) ke saath span-map hi right answer hai.

### B2 — Do alag "silence" definitions ek dusre se ladti hain
- **Kahan:** `vad.go` (absFloor −56 dB + peak/64 relative, upload gate) ↔
  `silencedetect` −30 dB (cut map, Case 19).
- **Bug:** Ek hi audio par vad bol sakta hai "audible hai" aur silencedetect bol
  "silence hai" — gate aur cut-map alag duniya dekhte hain. Word gate me segment
  drop hua jo cut-map me "speech" hai (ya ulta) → editor ko contradictory signals.
- **Fix direction:** **Ek hi measurement pass** (16k WAV ka frame-energy series) se
  dono consumer padhein — vad energies aur silencedetect ka threshold usi series se
  derive ho. "Pehle naapo, phir kaato" ka literal form: **one measurement, many
  consumers** (M6 me HLD).

### B3 — Segment-level audio gate bahut mota hai — LIVE PROOF (mera sabse strong finding)
- **Kahan:** `vad.go:270-293` (`BacksSegment`, segment-level) + `server.go:687-701`.
- **Evidence (aapke apne files se cross-check kiya):**
  - `transcript_digest.txt` line 1: segment **0.0–14.1 s** = "आपको जी पर टू जी"
    (garbage) — par `audio_analysis.txt`: silence **0 → 12.530113 s**. Matlab text
    ka 89% **pure silence** par baitha hai.
  - Gate kyun nahi gira? Span 14.1 s > `segmentLongSecs` (3.0) → absolute rule
    chala: audible ≈ 12.53→14.1 = **1.57 s ≥ 1.0 s** (`segmentLongMinAudible`) →
    **PASS**. Rule jaan-bujhkar generous hai (asli lambi line ko na kaate), par
    isse hallucination bach jaati hai.
  - Line 2: segment **14.1–26.4** = intro retake text — par silence
    **14.030703 → 19.074036 s** (5.04 s) usi segment ke beech me hai. Audible
    7.3/12.3 = 59% > 25% → PASS, aur **text 5 s silence par span** karta hai
    (retake gap merge ho gaya).
- **Fix direction:** **word-level gate** — `Words` already attached hain
  (`cloud.go:425 attachWordsToSegments`, `model.Word` exists). Har word ka
  `BacksSegment(word.start, word.end)` — silence par baithe words individually
  drop, asli words bachे. Segment ko uska audible hissa hi milta hai. Free, no new
  API. (Case 49)

### B4 — Language pin = first chunk pe bootstrap (fragile)
- **Kahan:** `server.go:670-681` — pehle successful chunk ki language pin ho jaati
  hai, phir poori job usi par chalti hai.
- **Bug:** Agar pehla chunk music/noise ho jisme detect galat aaya (ya Hinglish me
  Devanagari chuni) — poora 50-min job usi par. Doc Case 12 "per-request pin"
  bolta hai, code "first-chunk pin" karta hai — mismatch.
- **Fix direction:** Section-wise re-pin: har N chunks par **local script-ratio**
  (Unicode block count, free) se cross-check; Devanagari% pinned `hi` se milta hai
  to continue, nahi to re-pin + badge. Bootstrap ke liye: pin tabhi jab first 2
  consecutive chunks agree karein. (Case 44)

### B5 — Prompt-tail hallucination ko **seed** karta hai
- **Kahan:** `server.go:650` `prompt := transcriptTail(merged, 300)`.
- **Evidence:** Digest me garbage zone ke turant baad repetition loops — 961–1049 s
  gibberish → **1078.3–1108.3 s "प्रति प्रति प्रति" exactly 30.0 s** ka segment.
  Agar wahi loop ek baar gate se bach jaye (B7), to wahi text agle chunk ke prompt
  tail me jaake **repeat karwaata hai** — classic Whisper conditioning loop.
- **Fix direction:** Tail **sanitize** karo prompt banane se pehle: (a) repeated
  n-gram hatao, (b) no_speech-flagged/low-confidence segments hatao, (c) tail ko
  unique-tokens me cap karo. (Case 50)

### B6 — Dedupe cache key incomplete
- **Kahan:** Case 3 (content-hash → transcript cache).
- **Bug:** Agar cache key sirf audio-hash hai, to **alag model/language/prompt par
  purana transcript** mil jaayega (turbo se transcribe kiya, large maanga to wahi
  mila). Aur file-hash same-audio-different-export ko miss karta hai (InShot
  re-export = naya hash, wahi audio).
- **Fix direction:** Primary key = **audio-hash** (16k copy ki), aur lookup key =
  `(audio_hash, model, language, prompt_version)`. File-hash sirf exact-dup fast
  path ke liye. (Case 45)

### B7 — Hallucination filter 2-signal hai, confident loop nikal jaata hai
- **Kahan:** `cloud.go:333-344` — drop tabhi jab `no_speech_prob > threshold`
  **AND** `avg_logprob ≤ −1.0`. Comment khud maanta hai: *"a confident hallucination
  can score well on avg_logprob"*.
- **Bug:** "Thank you for watching" loops (Case 24) confident hote hain → dono
  condition satisfy nahi karte → **filter pass**. Aapke evidence me bhi exactly-30s
  repetition segments (1078 s, 2823.8–2853.8, 2896.8–2926.8) isi category ke
  honge/haan.
- **Fix direction:** **2-of-3 voting** (M3): signal-A = confidence pair (existing),
  signal-B = local VAD backing (existing), signal-C = **naya free signal — window
  detector**: `|duration − 30.0 s| < 0.05` AND repetition-ratio high (top-token
  share > 40%) AND silence-map overlap > 50%. Koi bhi 2 agree karein → drop/flag.
  (M3 me matrix)

### B8 — Case 35 ka medium tier (113 gaps) kahin nahi gaya
- **Kahan:** Case 35 — <1.5 s merge, >5 s cut-candidate; **1.5–5 s = 113 gaps
  beech me latke** (ne na merge hue na cut).
- **Bug:** Ye 113 gaps hain asli editing decisions wale (breathing pauses vs
  section breaks) — inhe chhodna = playbook ka sabse bada unpaid class.
- **Fix direction:** Third disposition **"review (collapsed)"** + context rule:
  medium gap jo retake-cluster (Case 26) ke paas hai → cut-candidate; jo teach-segment
  ke baad hai → keep (section break); dono nahi → default keep, user bulk-toggle.
  (Case 46)

### B9 — Case 19 ka "astats percentile" method technically nahi chalta
- **Kahan:** Case 19 fix: *"noise floor measure karo (quietest percentile astats
  se)"*.
- **Bug:** `astats` whole-file/whole-interval stats deta hai — **time-series
  percentile nahi**. Ye command chalegi hi nahi jo likha hai.
- **Fix direction (dono free):** (a) `ebur128` momentary (M) series jo aap
  `audio_analysis.txt` me already nikalte ho — uska **10th percentile = noise
  floor**; ya (b) probe-pass `silencedetect -60dB` → un windows ka median.
  Threshold = floor + margin (Case 19 ka baaki logic waisa hi).

### B10 — Render chain generation loss + i3 par time bomb
- **Kahan:** Case 36 (counter) — par doc render strategy decide nahi karta.
- **Bug:** Agar render proxy→final chain me jaata hai = extra generation, aur 50-min
  1080p full re-encode i3 par **15–30+ min** = user intazaar karta hai, beech me
  crash = sab bekaar. Counter badhane se rok nahi lagti — **strategy chahiye**.
- **Fix direction:** Import par hi **smart-render decision**: (a) cut points
  keyframe-snapped hain (ffprobe se keyframe interval pata hai) → `-c copy`
  stream-copy = **seconds** me render, zero generation loss; (b) frame-accurate
  chahiye → ek hi re-encode **ORIGINAL se**, proxy kabhi render ka source nahi.
  UI dono option dikhaye ETA ke saath. (Case 47)

### B11 — Estimate card ensemble ko price nahi karta
- **Kahan:** Case 2 (₹ estimate) ↔ M4 (Groq + 11labs + Gemini).
- **Bug:** Ab teen sources hain — card sirf Groq rate dikhayega to **credit burn
  chhup jaayega** (11labs 10k = 3 videos).
- **Fix direction:** Card pipeline selector: `groq-only` / `groq+scribe` /
  `full-ensemble` — har ek ka ETA (parallel = max) + credit cost + "aaj ki quota
  bachi: X%" (M4, Case 42).

### B12 — PII transcript ke saath cloud passes me jaata hai (privacy)
- **Kahan:** Case 39/40 ke Gemini correct/analyze passes — **aapke evidence me hi
  2255 s par real UPI ID** ("सुरेशचंद्र 506 …") transcript me hai, aur names/numbers
  bhi.
- **Bug:** Analyze/correct pass poora text Gemini ko bhejta hai → UPI/phone/digits
  bahar. Doc me privacy ka koi rule nahi.
- **Fix direction:** Text pass se **pehle local redaction**: VPA/UPI/phone/digit-run
  regex (free, Go) → placeholder, mapping SQLite me, display par restore. Raw
  transcript local hi rahe. (Case 48)

---

## M3. Hybrid multi-free-tool verification matrix — "galti ki gunjais"

**Philosophy (aapki hi baat, formalized):** koi bhi **risky decision** (drop,
cut-suggest, language, hallucination, music) ek hi tool par na jaye — **2-of-3
independent free signals** agree karein tabhi T0 (auto-accept); warna T2
(flag-review). Editor ka time bachta hai kyunki review **surgical** hai: poori
354 lines nahi, sirf disputed ~20–30 lines.

### Signal pool (sab free, sab local ya already-existing)

| ID | Signal | Source | Kya pakadta hai |
|---|---|---|---|
| S1 | dB silence map | ffmpeg silencedetect (adaptive threshold, B9 method) | dead zones |
| S2 | Frame energies | `vad.go` (10 ms frames, 16k WAV) | audible-vs-not, word backing |
| S3 | Loudness series | ebur128 momentary (already produced) | noise floor, energy arc |
| S4 | Confidence pair | Groq `no_speech_prob` + `avg_logprob` (already parsed) | model ka doubt |
| S5 | **30s-window detector (naya, free)** | segment duration ≈ 30.000 s + repetition-ratio + silence-overlap | confident loop hallucination (B7) |
| S6 | Second STT | **ElevenLabs Scribe** (11labs budget, M4) | independent model family ka verdict |
| S7 | Script-ratio | local Unicode block count | language mismatch (B4) |
| S8 | Lexicon/hooks | SQLite creator lexicon | protected regions (Case 39/40) |
| S9 | Video variance | sparse thumbs (Case 37/38) | overlay/watermark/scene |

### Decision × voting rules

| Decision | Tool A | Tool B | Tool C (optional) | Rule |
|---|---|---|---|---|
| Segment drop (hallucination) | S4 confidence | S2 word-backing | S5 window-detector | **2-of-3 drop**, 1 se kam = keep but flag |
| Word drop (B3) | S2 word-backing | — | — | Single signal enough (local physical fact: awaaz nahi = word nahi) — ye T0-auto hai |
| Cut-suggest (gap) | S1 silence | S2 no-audible | S8 not-hook/CTA | **teeno lock** = T0; koi disagree = T2 review |
| Language | Whisper detect | S7 script-ratio | S6 (dispute par) | agree = pin, disagree = badge + override chip |
| Music-project | S1 low speech | S4 high no_speech | S6 lyrics-disagreement | 2-of-3 = music mode (Case 16/17) |
| Retake cluster | fuzzy text match (local) | word-timestamp overlap | S6 agreement | 2-of-3 = highlight (never auto-delete) |
| Text finalization | Groq text | Scribe text | Gemini adjudicate sirf **disputed words** par | agree = final; dispute = surgical review list |

### Four-lock cut safety (har auto-suggest ke liye compulsory)

Koi bhi cut-suggest **tabhi** T0 banega jab charo lock lagen:
1. **Audio lock** — S1+S2 dono: ye gap me koi audible speech nahi (padding: reverb
   tail + 0.3 s, per-file from S3).
2. **Content lock** — gap ke dono taraf ke segments S8 lexicon se protected nahi
   (hook/CTA/subscribe/comment/disclaimer).
3. **Shape lock** — gap Case 40 shape strip ke intro/outro/story zone ke protected
   region me nahi.
4. **Confidence lock** — border segments ka S4/S6 verdict low-doubt.

Koi lock fail → **suggest band, sirf flag**. Auto-delete kabhi nahi (Principle 5
bana rahega).

### Editor-time math (kyun ki time bachta hai)

- Poori review: 354 segments (aapke live proof me).
- Ensemble disagreement expected: ~5–10% segments (Hinglish phonetic zones,
  hallucination zones, retake clusters) → **surgical list ≈ 20–35 lines**.
- Cut review: 274 raw gaps → Case 35 ke baad 46 cards → four-lock ke baad jo
  **auto-T0** hain unhe bulk-apply, sirf T2 gaps dekhne padte hain (~10–15).
- Net: editor ~15 min me jo abhi 1–2 ghanta leta.

---

## M4. Transcript ensemble — Groq + ElevenLabs Scribe, phir Gemini tiebreak

**Aapka thesis:** `groq + 11labs ==== gemini >> more accuracy` — main isse
**agree** karta hain, aur yahan formalize karta hoon:

**Kyun ≥ Gemini solo:** do **independent model families** (Whisper-class vs
Scribe-class) ke correlated-error rate Gemini solo se kam hota hai; disagreement
**localize** karti hai ki doubt kahan hai; adjudicator (Gemini) sirf **disputed
text** dekhta hai — focused, cheap, aur aapko andha trust nahi **review list**
milti hai.

### Budget math (aapke numbers par)

| Item | Value |
|---|---|
| Accounts | 4 × ElevenLabs, har ek **10k credits/month** |
| Naive full-dual | 10k = 3 videos → 4 accounts = **12 videos/month** (bahut kam) |
| **Proposed escalation policy** | Groq = hamesha primary. Scribe **sirf**: (a) low-confidence segments (S4 trigger), (b) cut-critical windows (retake clusters ±10 s, first 30 s, last 60 s, hook lines), (c) **5% random audit** |
| Expected load | ~10–15% of audio → 10k ≈ 20–24 videos/account → **≈ 80–95 videos/month** (4 accounts) |
| Gemini | Sirf Groq↔Scribe **word-level disputes** (<5% segments) + existing analyze/correct (redacted, B12) |
| ETA | Groq ∥ Scribe parallel → **ETA ≈ max(groq, scribe)**, sum nahi |

### Flow

```
chunks (silence-aligned, span-map B1)
   ├─► Groq Whisper (primary, free tier) ────────┐
   ├─► Scribe (escalation windows only) ─────────┤ votes compare (local, text-level)
   │                                             ▼
   │                        agree ──► final text (T0)
   │                        disagree ──► disputed-words list ──► Gemini (tiebreak, redacted)
   │                                             │
   └─► local gates (S1/S2/S4/S5, M3 rules) ◄─────┘
                                              ▼
                                    segments + words + confidence in SQLite
```

### Infrastructure (HLD ka hissa)

- **Quota ledger** (SQLite): `key_id, source, month, used, limit, reset_at` —
  router **least-used key** chunta hai; Case 2 ka card dikhata hai
  *"scribe 62% bachi · resets 1 Dec"* (honesty > magic).
- **PII redaction** (B12) Gemini/text-pass se pehle — local regex, mapping SQLite
  me, display par restore.
- **New provider, same shape:** repo me `GroqClient`/`GeminiClient` hain —
  `ScribeClient` unhi ke `TranscribeChunkResult` shape me, `cloud/` package me.
  (Code baad me, abhi sirf contract.)

---

## M5. Naye edge cases 41–52

> Original index (40) ko chhua nahi — ye cases yahan append hain, unka group
> "H — MiMO V2.6 additions". Format same: Scene / Problem / Fix / Kyun.

### Case 41: Dual-STT ensemble + Gemini adjudication *(M4 ka engine)*
**Scene:** Groq Whisper ne Hinglish segment me "Retrive Argument Document General"
likha; Scribe ne "Retrieval Augmented Generation" — dono free, dono alag.
**Problem:** Ek STT ka phonetic error seedha transcript me chala jaata hai (Case 39
ka root), aur user ko pata hi nahi ki kitna reliable hai.
**Fix:** M4 ka flow — Groq primary, Scribe escalation windows par, word-level
dispute list Gemini ko (redacted). Disputed words UI me **dual-highlight** (dono
variants dikhao, ek click me choose), final text SQLite me with `source: agreed/
tiebreak/human`.
**Kyun:** Do independent model families ka agreement = high confidence bina kisi
paid API ke; disagreement hi asli "yahan dekho" signal hai — editor ka review
20–35 lines tak simat-ta hai (M3 math).

### Case 42: Multi-key quota router (4×11labs + Groq + Gemini)
**Scene:** 4 ElevenLabs accounts hain, 10k/month each; Groq ka free TPD, Gemini ka
RPM — teeno alag clocks par reset hote hain.
**Problem:** Ek key par quota khatam → job beech me ruk jaati hai; user ko pata
nahi kal kitna bacha; estimate card galat (B11).
**Fix:** SQLite `quota_ledger` + router (least-used-key, per-source) + job-level
**resumability** (pending segments aage badhte hain, naye key par); card me
per-source quota + reset time + pipeline selector (groq-only / +scribe / ensemble).
**Kyun:** Quota ek finite resource hai jaise disk — uska bhi precheck chahiye
(Case 31 ka hissedar). Router ke bina 4 accounts ka faayda 1 account jaisa hai.

### Case 43: Span-map contract (concat ↔ original time)
**Scene:** Case 1 ke speech spans jod kar ek chunk bheja gaya (274 gaps ka faayda).
**Problem:** Daemon ek scalar `offset_secs` leta hai — concat-time vs original-time
mismatch = **har span ke baad drift** (B1), cut points aage-peeche.
**Fix:** `ChunkRequest` ke saath `span_map[]` (`concat_start, concat_end,
orig_start`); response remap hote hi original-time me; span-map SQLite me persist,
resume par reuse. Micro-batches (Case 7) bisi isi contract se.
**Kyun:** Ye contract fix **Case 1 + 7 + 8 + 9 + 43** — paanch cases ek saath
khulta hai. Drift free me khatam, koi extra API nahi.

### Case 44: Language bootstrap + section-wise re-pin
**Scene:** Pehla chunk music/gibberish nikla, Whisper ne language=fr detect ki —
poora job French me decode hua.
**Problem:** First-chunk pin (B4) fragile; Hinglish me script wobble (Case 39)
bhi isi ka symptom.
**Fix:** Pin tabhi jab **2 consecutive chunks agree** karein; phir har N chunks
local **script-ratio** (S7, Unicode block count) cross-check — mismatch par
re-pin + chip dikhao; override dropdown (Case 13) hamesha available.
**Kyun:** Script-ratio free aur instant hai; galat pin = poora transcript bekaar +
re-transcribe ka kharcha — prevention > cure.

### Case 45: Audio-hash dedupe + config-aware cache key
**Scene:** User ne wahi video dobara InShot se export karke daali (naya container,
wahi audio). Ya phir turbo se transcribe kiya, ab large maang raha hai.
**Problem:** File-hash miss + stale cache = galat-confidence wala purana transcript
(B6).
**Fix:** Primary dedupe = **audio-hash** (16k transcription-copy ki, 6 MB stream);
cache lookup = `(audio_hash, model, language, prompt_version)`; file-hash sirf
exact-dup fast path. Hash background me chale (import block na ho).
**Kyun:** Transcript pure function hai — uska input audio hai, container nahi.
Config-aware key ke bina model upgrade cache ko poison karta hai.

### Case 46: Medium-gap third disposition (113 gaps ka adhikar)
**Scene:** Case 35 ke baad: 115 micro merge, 46 bade cut-card — aur **113 medium
(1.5–5 s) kahin nahi** (B8).
**Problem:** Ye hain asli decisions wale gaps (breathing pause vs section break) —
chhodna = sabse bada unpaid class, aur inhe andhadhund cut karna = video kankad.
**Fix:** Third tier **"review (collapsed)"** + context rule: retake-cluster ke paas
→ cut-candidate; teach-segment ke baad → keep; baaki default keep + bulk-toggle.
Four-lock (M3) medium gaps par bhi lagta hai.
**Kyun:** Context (shape + retake) ke bina gap sirf duration hai — duration akeli
decision nahi deti (Case 40 ka yahi lesson).

### Case 47: Smart render — stream-copy vs frame-accurate (import par decide)
**Scene:** 5.3 GB, 50-min render chahiye; i3 par full re-encode 15–30+ min.
**Problem:** Ya to bahut slow (re-encode), ya generation loss (proxy chain), ya
crash = sab bekaar (B10).
**Fix:** Import par keyframe interval probe (ffprobe) → cut points keyframe-snapped
hain to UI **"Fast (stream-copy, seconds, keyframe cuts)"** offer kare; frame-accurate
chahiye to **ek hi re-encode ORIGINAL se** (proxy kabhi source nahi), progress +
resume ke saath; render tmp me, verify (duration round-trip ffprobe) ke baad atomic
rename.
**Kyun:** Do options, dono honest ETA ke — user choose kare. Stream-copy zero
generation loss + seconds = 90% cases ka answer; accurate path exception me.

### Case 48: PII redaction before cloud text passes
**Scene:** Transcript me real UPI ID (2255 s evidence), phone, names — analyze/
correct pass poora text Gemini ko bhejta hai.
**Problem:** Privacy leak + (ag kabhi paid tier aaya) cost; aur docs ka Principle 3
"original sacred" sirf media par lagta hai, **text par nahi**.
**Fix:** Text pass se pehle local redaction: VPA/UPI/phone/digit-run regex (Go,
free) → `«REDACTED_1»` placeholders; mapping SQLite me (user ke liye restore);
raw transcript local hi. Redacted text par hi Gemini analyze/correct.
**Kyun:** Ek regex, zero API, zero RAM — privacy ka sabse sasta insurance. Aapke
apne evidence video me hi PII hai, ye theoretical nahi hai.

### Case 49: Word-level audio gate (segment gate ka upgrade)
**Scene:** Segment 0.0–14.1 s ka 89% text silence par baitha hai, phir bhi gate
pass (B3, live proof).
**Problem:** Segment-level backing generous rule hallucination ko bacha leti hai;
retake-merge bhi 5 s silence ko span kar jaata hai.
**Fix:** `Words` already attached hain — har word par `BacksSegment(w.start,
w.end)`; silence par words individually drop; segment ko apna audible hissa milta
rahe. Word timestamps **already free** me aa rahe (word granularity request).
**Kyun:** Physical fact: awaaz nahi to word nahi — single-signal decision safe hai
kyunki ye model ka verdict nahi, **audio ka fact** hai. Naya kuch kharcha nahi.

### Case 50: Prompt hygiene — tail sanitization
**Scene:** Ek baar repetition loop gate se bach gaya, uska text next chunk ke prompt
tail me gaya → loop aur bada (B5, evidence: 1078 s loop garbage zone ke baad).
**Problem:** Prompt carryover (Case 12 ka Hinglish vocabulary bias) ka side-effect:
hallucination ko **conditioning** se propagate karta hai.
**Fix:** Tail banate waqt: repeated n-gram strip, low/no-speech segments strip,
unique-token cap. Vocabulary bias (lexicon) alag layer se aaye, raw transcript tail
se nahi.
**Kyun:** Prompt ka kaam continuity hai, repetition nahi — sanitize se continuity
bachi, loop khatam. Free string ops.

### Case 51: Edit-list / negative-CTS trap (A/V offset ka gehra ilaaj)
**Scene:** Phone video import hui, `start_time = 0` dikha, offset 0 maana — par
players me audio 0.4 s late.
**Problem:** MP4 **edit lists (elst)** aur negative CTS presentation ko shift
karte hain; ffprobe ka `start_time` aksar 0 hi dikhata hai → Case 30 ki
measurement khud galat ho sakti hai.
**Fix:** Teesra free cross-check: **first-audio-energy time vs first-scene-change
time** (sparse thumb decode import gate me already hota hai) ka difference =
practical offset; elst box present ho to prefer elst. Offset SQLite per-project
(Case 30 waisa hi).
**Kyun:** Do independent clocks (audio energy vs video change) ka comparison koi
metadata nahi maanta — metadata jhooth bole to bhi chalta hai. Free, ek sparse
decode me.

### Case 52: Atomic render + disk-full + stray `.partial` cleanup
**Scene:** Render 90% par crash / disk full — user ke paas adhoora file, ya kal
purani `.partial` mili.
**Problem:** Half-file = "app ne mera video kharab kiya" trust hit; disk-full beech
me = Case 31 ka wahi half-done state render par.
**Fix:** Render hamesha **tmp naam** me → verify (ffprobe duration ≈ sum of kept
spans, A/V stream present) → **atomic rename**; disk precheck render se pehle
(output size estimate); startup par **stray sweep** (tmp registry ke bina purane
.tmp/.partial delete, age-gated).
**Kyun:** Verify-then-rename ek line ka discipline hai jo "galat file dikhi" wali
har bug class ko khatam kar deta hai. Zero-RAM compliant (kuch buffer nahi).

---

## M6. HLD — High-Level Design (analysis only, koi code nahi)

> Future agents ke liye: ye **contract** hai. P0/P1/P2 order me implement karo;
> har layer ke acceptance checks neeche. Original 40 cases iske upar khade hain —
> koi contradicts nahi, sirf integrate hote hain.

### Data flow (layers)

```
original file (sacred, read-only, byte-identical — Principle 3)
  │
  ├─► [import gate] ffprobe → media_probe (dur/codec/VFR/color/tracks/elst)
  │       ├─ disk precheck (Case 31) · track select · long-path/non-ASCII check
  │       └─ A/V offset: elst ∩ audio-energy vs scene-change (Case 51)
  │
  ├─► [ONE measurement pass] 16k mono WAV
  │       ├─ frame energies (vad.go series) + silencedetect + ebur128 M-series
  │       └─► audio_map (disk, SQLite meta) — S1/S2/S3 SAB isi se (B2 fix)
  │
  ├─► [sparse thumbs, throttled max-1 child] → thumbs + overlay/watermark grid (S9)
  │
  ├─► [transcription] speech-span extraction → span-map (B1/Case 43) → chunks
  │       ├─► Groq (primary) ∥ Scribe (escalation windows) → local vote
  │       ├─► disputes only → Gemini (redacted, B12)
  │       ├─► gates: word-level (Case 49) + 2-of-3 hallucination (B7, S5)
  │       ├─► language: 2-chunk bootstrap + script-ratio re-pin (Case 44)
  │       └─► prompt tail sanitized (Case 50)
  │
  ├─► [post passes — LOCAL first] bracket tags · retake fuzzy clusters ·
  │       lexicon correct (local; Gemini sirf low-agreement) · shape strip (Case 40)
  │
  ├─► [suggestion engine] four-lock (M3) → confidence tiers T0–T3 →
  │       cut EDL (SQLite) → user confirm/surgical review (M3 math)
  │
  └─► [render] smart decision (Case 47) → tmp → verify → atomic rename (Case 52)
          └─► quota ledger update (Case 42) · encode-count (Case 36)
```

### SQLite tables (names + one-line columns)

| Table | Columns (essentials) |
|---|---|
| `media_probe` | project_id, duration, codecs, vfr_flag, color_tags, track_list, elst_offset |
| `audio_map` | project_id, noise_floor_db, threshold_db, gaps(start, end, tier), energy_series_ref |
| `spans` | project_id, concat_start, concat_end, orig_start (B1 span-map) |
| `chunks` | job_id, idx, path, offset, span_map_json, state |
| `segments` | job_id, start, end, text, original_text, words_json, no_speech, avg_logprob, source |
| `segment_votes` | segment_id, source(groq/scribe/gemini/human), text, verdict |
| `lexicon` | channel, term, correction, hits |
| `quota_ledger` | key_id, source, month, used, limit, reset_at |
| `cut_edl` | project_id, cut(start, end, tier T0-T3, locks_mask, reason) |
| `render_jobs` | project_id, mode(fast/accurate), state, out_path, verified |
| `redaction_map` | project_id, placeholder, original (local only) |
| `shape_strip` | project_id, zone(start, end, kind intro/teach/story/demo/outro/hook) |

**Invariants (har agent ka non-negotiable):**
1. Original byte-identical — koi bhi write original par nahi.
2. Har derived file tmp + registry row; startup stray-sweep.
3. **Ek measurement pass, sab consumers** (B2) — dobara mat naapo.
4. Local fail-open (gate kabhi transcript ka reason nahi ban sakta — vad.go ka
   principle poore pipeline me).
5. API kabhi auto-delete nahi; sirf suggest/flag (T0 bhi confirm ke baad hi cut).
6. DB me waqt hamesha **original-seconds** (float); PTS sirf render layer me.
7. Har cloud text-pass redacted (B12).

### Confidence tiers (UI contract)

| Tier | Kya | Rule |
|---|---|---|
| **T0** auto-accept | text final / cut bulk-apply-able | 2-of-3 agree + four-lock |
| **T1** suggest | dikhao, one-click | agree on text, cut uncertain |
| **T2** flag-review | surgical list | koi signal disagree (M3) |
| **T3** never-touch | protected | hook/CTA/crosstalk/disclaimer (S8/S9) |

### Build order (future agents ke liye)

- **P0** (contract + safety, koi new provider nahi): B1 span-map (43) · B3
  word-gate (49) · B5 prompt hygiene (50) · B8 medium-tier (46) · B6 cache key
  (45) · B9 noise-floor method (19-fix) · S5 window-detector + 2-of-3 (B7).
  *Har ek ka pehle failing test (TDD), phir fix.*
- **P1** (ensemble + privacy + render): Scribe provider + quota router (41, 42) ·
  PII redaction (48) · smart render decision (47) · language re-pin (44) ·
  estimate card pipeline pricing (11-fix).
- **P2** (polish): shape strip (40) · overlay/watermark grid (37/38) · surgical
  review UI (M3) · elst/offset cross-check (51) · atomic render sweep (52).

### Acceptance checks (har PR par)

```powershell
npm run verify:fast        # prettier + svelte-check + node --test + cargo check
cd go; gofmt -l . ; go vet ./... ; go test ./...   # Go side
```
Plus case-specific: B3 ka test digest ke 0–14.1 s segment jaisa fixture (silence par
word drop, real word survive) · B1 ka test multi-span chunk round-trip (drift = 0) ·
B7 ka test exactly-30s-repetition fixture drop ho. Zero-RAM: koi bhi new path
full-file buffer na kare (5.3 GB import par measure karke verify). Deploy
`deploy.ps1 -Ci` se hi (AGENTS.md §10.2), local cargo build nahi.

---

## M7. Closing — MiMO V2.6

Ye 40+12 cases do hi cheez par khade hain jo GLM 5.3 ne shuru ki: **"API ko kya
dena hai"** aur **"original ko kya chhoona hai"**. Mera addendum teesra jodta hai:
**"ek decision ko kitne free tools confirm karein"** — kyunki solo free tool par
bharosa galti ki gunjais nahi deta, hybrid (2-of-3 + four-lock) deta hai, aur
surgical review se editor ka time bachta hai. Groq + ElevenLabs ka ensemble
Gemini-se-better accuracy isliye deta hai kyunki do independent model families ke
agreement ka error rate kisi ek model se kam hota hai — aur disagreement aapko
batati hai **exactly kahan dekhna hai**. Sab kuch free, sab kuch local-measured,
sab kuch disk par — Zero-RAM bana rahega.

**— MiMO V2.6** (opencode / mimo-v2.6-flash-free) · 2026-11-12
*Upstream: GLM 5.3 — 40 cases untouched. Ye part sirf addendum hai.*

---

## N. Cases 1-10 - kya ship hua, kya abhi baaki hai - deepseek

Ye section sirf **append** hai: upar ke 40 cases aur baaki addenda jaise the waise hain.
Har case me teen cheezein hain - jo code me sach me badla, kya problem aayi, aur
jo agla step hona chahiye. Jhooth nahi: jahan fix sirf partially hai, wahan
"partial" likha hai.

### Case 1 - Ghanta-bhar video, sirf 3 min bolna (partial, local gate shipped)

**Kya hai:** `go/internal/vad/vad.go` har chunk ko upload se pehle locally padhta
hai (mono 16 kHz PCM, 10 ms frames, noise floor + margin se adaptive threshold).
Silent chunk API tak jaata hi nahi; `minContentSecs = 3.0` ne wo bug bhi band kiya
jahan 49-min import ka beech ka hissa "17% audible" hone ki wajah se skip ho raha
tha. Ye measurement free hai aur API spend 0 hai.
**Naya code:** `transcript-plan.ts` + `project.svelte.ts` ka plan pehle click par
sirf **ek** chunk bhejta hai. 1 ghante ka video ab "10 calls ek saath" nahi hai -
pehla chunk, phir "Agla chunk" ya "Sab banao". User ke paise usi second se lagte
hain jab wo aage badhna chahe.
**Problem:** Chunk-level VAD ek 5-minute chunk ko nahi todta. Agar 3 min speech ek
hi 300 s chunk me hai to wo poora chunk upload hota hai - 57 min silence alag
chunks me bant kar skip hoti hai, par ek chunk ke andar ki silence abhi bhi bill
hoti hai. Span-level speech compaction (silencedetect -> speech spans -> concat +
offset map) design ready hai, code nahi.
**Suggestion:** Agla kaam `audio.rs` me: `silencedetect` se speech spans nikaalo,
sirf spans ko concat karke chunk banao, aur `ChunkSpan.offsetSecs` ko original
timeline par map karo. Mapping SQLite me hi rahegi (already `offset_secs` contract
hai), to transcript/cut kabhi drift nahi karega.

### Case 2 - Paise pehle dikhana (shipped)

**Naya code:** `transcript-plan.ts` me `estimateForDuration(durationSecs)` -
duration pehle se probed hai, segment default 300 s hai, to calls = ceil(d/300),
audio = d, ETA = max(20 s, 0.2 * d). `TranscriptPanel.svelte` ise generate button
ke neeche dikhata hai: "~49:50 audio - 10 Whisper calls - ~9:58 wait (estimate)".
Plan ban jaane ke baad footer pending audio/calls/ETA dikhata hai, aur "Sab banao
(N)" me N live pending calls hai.
**Problem:** Ye wall-clock estimate 5x realtime assumption par hai; Groq ka queue
slow ho to beat ho sakti hai. Isliye text "estimate" kehta hai, promise nahi.
**Suggestion:** Har chunk ke actual `started_at/finished_at` `transcription_jobs`
me hain - inka median le kar ETA ratio ko per-machine calibrate karo, fixed 0.2
ki jagah.

### Case 3 - Wahi file dobara / crash-retry (partial: resume shipped, hash baaki)

**Naya code:** Plan SQLite `kv` me `t9-editor-lit.transcript-plan.<source>` key ke
saath rehta hai (localStorage sirf mirror). Har chunk ke baad `markDone` + save
hota hai. App band, crash, ya Task Manager kill - dobara kholne par footer
"3/10 chunks" dikhata hai aur "Agla chunk" wahin se chalta hai. `retryMissingTranscript`
ab alag pipeline nahi, wahi plan loop hai - isliye retry aur resume kabhi drift
nahi karte. Same path dobara kholne par `transcripts` table se cache hit hota hai
(pehle se tha).
**Problem:** Renamed copy (same bytes, different path) abhi bhi dobara bill hoti
hai - `transcripts` ka primary key `source_path` hai, content hash nahi.
**Suggestion:** `ffmpeg`/Rust se streaming SHA-256 (poora file RAM me nahi) nikaal
kar `transcripts` me `content_hash` column + index add karo; lookup pehle hash,
phir path. Ye ek migration + ek command hai, isliye is round me nahi kiya - bina
test ke DB migration ship karna galat trade hai.

### Case 4 - Batch day + Groq 429 (daemon side shipped, UI baaki)

**Kya hai:** `go/internal/queue/queue.go` bounded workers, `Retryable` errors
(429/503/network), exponential backoff (1 s -> 30 s cap), `Submit` full hone par
backpressure deta hai. Frontend ka "Sab banao" bhi sequential hai - ek waqt me ek
chunk, isliye 30 files ek saath click karne par bhi API flood nahi hota.
**Problem:** Multi-file batch selection UI nahi hai; user ek project ke andar hi
queue chala sakta hai. 30 files ke liye 30 baar import karna padega.
**Suggestion:** Dashboard ke multi-select se ek `transcription_jobs` queue banao;
worker wahi Go queue ho, UI me "3/30, is file par chal raha hai" + per-file cost
card (Case 2 ka helper wahi use karega).

### Case 5 - 2 GB movie / Telegram vault file (shipped)

**Kya hai:** `src-tauri/src/audio.rs` `-vn -ac 1 -ar 16000 -c:a pcm_s16le` se
sirf audio nikaalta hai. Video bytes decode hote hi chhod diye jaate hain; 5.3 GB
InShot file ka audio ~6 MB tha (playbook ka live proof). Telegram vault file
local path ban jaane ke baad isi raaste se jaati hai - alag code path nahi.
**Problem:** 25 MB Groq per-chunk limit ke liye koi explicit byte-check nahi hai;
300 s 16k mono WAV ~9.6 MB hai, isliye default safe hai, par custom segment size
bada karne par limit cross ho sakti hai.
**Suggestion:** `extract_chunks` me `segment_secs` ko 25 MB budget se clamp karo
(16k mono 16-bit = 32 kB/s -> ~780 s hard ceiling), aur daemon 413 par chunk ko
chhota karke retry kare.

### Case 6 - Studio WAV 96 kHz / 24-bit (shipped, storage variant baaki)

**Kya hai:** Wahi extraction step sample rate ko 16 kHz mono kar deta hai, isliye
500 MB WAV bhi ASR ke liye chhota ho jaata hai. Waveform source se banti hai, is
copy se nahi - original kabhi chheda nahi jaata.
**Problem:** Disk par transcription-copy WAV hai (FLAC nahi), to 2 ghante ka audio
~230 MB tmp leta hai jab tak plan poora na ho. FLAC ~60% chhota hota.
**Suggestion:** Chunk format ko `flac` karo (ffmpeg segment muxer `-f segment`
ke saath), daemon ko WAV/FLAC dono padhna hai - VAD ka WAV reader tab FLAC branch
chahiye. Ye ek format change hai, isliye alag PR.

### Case 7 - Chhote clips (1 s se kam) (shipped at the door)

**Naya code:** `startTranscript` source duration < 1 s par turant friendly error
deta hai aur **koi API call nahi** karta: "Clip 1 second se chhota hai - Whisper
kuch nahi sun sakta." Daemon ka VAD duck-meme case (0.19 s sound) pehle se gate
karta hai.
**Problem:** 100 micro-clips ko ek request me jodna nahi hua; har clip alag click
hai. Fixed API overhead abhi bhi per clip hai.
**Suggestion:** Batch import me micro-clips ko concat karke ek chunk banao aur
`offset_secs` map se wapas baanto - Case 1 ka speech-span map isi ka extension hai.

### Case 8 - Lambe files ka chunking (partial)

**Kya hai:** 300 s chunks, har chunk `offsetSecs` carry karta hai, daemon contract
`chunk.path + offset_secs + index` hai. 3 ghante ki recording 36 calls me chali
jaati hai, RAM flat rehti hai.
**Problem:** Cut blind 300 s par hota hai, silence boundary par nahi - mid-speech
split abhi possible hai (Case 9). Isliye "3 ghante" scale hota hai, par boundary
quality guarantee nahi.
**Suggestion:** Case 1 ke speech spans se hi boundaries banao: target 300 s ke
aas-paas nearest silence midpoint chuno, minimum 240 s / maximum 360 s ke andar.
Chunking deterministic rahegi (same file -> same cuts) aur word tear ~0 ho jaayega.

### Case 9 - Chunk-boundary par word tear (open - honestly not fixed)

**Kya hai:** Abhi overlap nahi hai, isliye tear ho sakta hai. Is round me ise
"fix" kehna jhooth hoga; plan/retry infra bas itna karta hai ki ek chunk dobara
bhejna sasta hai.
**Problem:** Bina overlap ke reconcile ke paas koi evidence hi nahi hota ki
"deci" + "sion" ek word the. Text-only merge galat words jod sakta hai.
**Suggestion:** `audio.rs` me har chunk ke start/end par 0.8-1.0 s overlap rakho
(ffmpeg `-ss`/`-t` per chunk), phir `transcript-plan.ts` me pure
`reconcileBoundary(prev, next)` likho: same normalized text + timestamps overlap
zone me + Levenshtein distance <= 2 -> ek segment; warna dono rakho (duplicate
word ek missing word se sasta hai). Unit tests pehle, phir wire.

### Case 10 - Network / power / API down (shipped for the app's half)

**Naya code:** (a) Plan SQLite me hai, isliye network girne par current chunk fail
hota hai, plan pending rehta hai, aur next click wahin se retry karta hai - 20 min
ka kaam dobara nahi jaata. (b) App exit ab har FFmpeg child ko Windows Job Object
se maarta hai (`ffmpeg.rs`, `KILL_ON_JOB_CLOSE`), isliye power/Alt+F4/Task Manager
ke baad orphan ffmpeg CPU nahi khaata. (c) Transcript na ho to silence scan aur
cut tools pehle se chalte hain - wo local ffmpeg hai, API par depend nahi.
**Problem:** API down hone par UI me "offline, transcript pending" ka global badge
nahi hai; user ko sirf chunk error dikhta hai. Auto-resume on app restart bhi
nahi hai - user ko "Agla chunk" dabana padta hai (deliberate: automatic API spend
nahi).
**Suggestion:** Daemon queue ke `Stats()` ko UI me badge banao ("2 pending, API
5xx - retry in 30 s"), aur ek explicit "Auto-resume on next launch" setting jo
default off ho.

---

# PART 3 — deepseek Addendum: Cases 11–20 implemented (code, not analysis)

> **Signature: deepseek** (opencode / minimax-m3.1-flash-free) · 2026-11-12
>
> **Upstream untouched:** GLM 5.3 ke 40 cases aur MiMO V2.6 ka Poora Part 2 —
> koi line delete nahi, koi line edit nahi. Ye part sirf **append** hai, aur
> uske baad kuch bhi nahi.
>
> **Scope:** Cases **11 → 20** (Group C — bhasha aur script; Group D — music aur
> noise). Is baar **analysis nahi — implementation**. Go daemon + Svelte
> frontend, dono chalu, dono tested.
>
> **Ground rules jo follow hue:** Python **banned**, paid service **banned**,
> full-file RAM buffer **banned**, original media **sacred**, aur "auto-delete"
> ki jagah "suggest + confirm".
>
> **Evidence (live repo code, guess nahi):**
> `go/internal/vad/vad.go`, `go/internal/api/server.go` (`runTranscribe`),
> `go/internal/api/store.go`, `go/internal/cloud/cloud.go`,
> `go/internal/cloud/correct.go`, `go/internal/model/model.go`,
> `Clipchamp_Bunny/src/lib/pipeline.ts`,
> `Clipchamp_Bunny/src/lib/stores/project.svelte.ts`,
> `Clipchamp_Bunny/src/lib/components/cut/TranscriptPanel.svelte`,
> `Clipchamp_Bunny/src/app.css`.

---

## M0. Ek paragraph

GLM 5.3 ne 40 cases likhe the, MiMO ne un par rai di — aur dono ka ek common
weakness ye tha ki **decision ka tareeka bataya, par code me kuch nahi badla**.
Cases 11–20 me ye khaas taur par mehsoos hota hai: doc kehta hai "threshold
per-file measure karo" (19), "language pin per-request karo" (12), "music
project mark karo" (16) — par repo me VAD ka threshold aaj bhi `-56 dB` +
`peak/64` tha, language **pehle chunk** se pin hota tha, aur music ke liye
koi koi rasta hi nahi tha (sirf ek generic "no speech" card).

Maine ye **teenon** layers par implement kiya, aur har fix ka apna failing
test pehle likha:

1. **Go daemon** — `internal/vad` (adaptive threshold + sensitivity dial +
   ASMR floor), naya `internal/script` (script ratio / language cross-check),
   naya `internal/api/language_pin.go` (pin state machine), naya
   `internal/api/audio_profile.go` (`POST /v1/audio-profile`),
   `internal/cloud/translate.go` (translation view).
2. **Frontend** — `lib/audio-profile.ts`, `lib/languages.ts`, pipeline ka
   naya contract, store ke naye fields (profile / language / sensitivity /
   protected), aur TranscriptPanel me language chip, override dropdown,
   sensitivity dial, translation line, protect pin aur music card.
3. **Rust engine** — **chhua nahi**. Wahan dusra agent kaam kar raha hai
   (AGENTS.md §10.3 "one file, one agent"), aur mere changes ka koi hissa
   Rust me zaroori nahi tha: cut map ka threshold pehle se hi frontend se
   aata hai (`detectSilence(path, noiseDb, minSecs)`).

Ek baat saaf kar doon: **sab kuch implement nahi hua.** Jo nahi hua, wo M6 me
likha hai — chupana nahi hai.

---

## M1. Case-by-case — doc kya kehta tha, code me kya tha, ab kya hai

| #   | Doc kya kehta tha                             | Code me kya tha (ground truth)                                                     | Ab kya hai                                                                             |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 11  | Per-segment language badge, translate view, Hinglish romanization | `ChunkTranscript.Language` sirf **chunk** level par thi; UI me koi badge nahi; koi translate pass nahi | Badge **har line** par (`Segment.Language`), naya `/v1/translate` pass, UI me "Translate" button. Romanization ke liye naya pass nahi — autocorrect prompt pehle se Latin script maangta hai (§M6.1) |
| 12  | Code-switch: pin per request, raw text safe | Pin **pehle chunk** se (`server.go`), jisko MiMO ne B4 bola — pehla chunk music hua to poori job galat | Naya `languagePin`: pin **do consecutive agree karne wale chunks** ke baad. Raw text `original_text` me safe (pehle se tha)                                   |
| 13  | Accented English → `hi` galat detect; override dropdown | Koi override UI nahi; `req.Language` bhej sakta tha par app kabhi nahi bhejti thi | UI me **LANG dropdown** (24 bhashayein), daemon user pin ko kabhi nahi badalta, sirf **warn** karta hai                                                    |
| 14  | Tofu boxes: font fallback + `dir="auto"` | `app.css` me sirf `'Segoe UI'` — Devanagari/Urdu/CJK tofu | `--font-sans` me **Nirmala UI + Noto family** (Windows par already installed), `dir="auto"` har line par, `dir="auto"` translation par bhi                |
| 15  | Rare language: source primary, translation secondary + badge, re-run pinned | Koi translation path hi nahi tha | Naya `cloud/translate.go` (batch + guards), `TranslatedText` **alag field** — `Text` kabhi replace nahi hota, UI me niche + badge                 |
| 16  | Do songs overlap: speech-ratio → music project, waveform-first | Kuch nahi — generic "no speech" hi milta tha | Naya **music verdict**: 2 consecutive wordless chunks + file mostly sound → job `music: true`, **baaki chunks upload nahi** (cost bachti hai), UI me music card |
| 17  | Pure music: "no speech found" card, waveform-first mode | `succeedNoSpeech` tha (MiMO sahi bola) | Upar wala + alag card: "Ye ek music project hai" — retry button ki jagah waveform-first ka raasta                                       |
| 18  | Loudness pre-pass: voice-to-music ratio + master level, filter sirf copy par | Koi measurement nahi; koi filter nahi | Profile me **noise floor / speech level / SNR / peak** (PCM se, free). ebur128 LUFS aur afftdn/loudnorm filter **nahi** banaye (§M6.2)              |
| 19  | Per-file adaptive threshold: noise floor + margin, sensitivity slider | Fixed `-56 dB` **+** `peak/64` — fan ke saamne kuch nahi milta, studio me har saans kat-ta hai | **Peak-relative rule hata diya**, floor **p10 percentile** se maapa, threshold = `floor + margin`, margin **sensitivity dial** se (3/9/18 dB). Cut map ab measured threshold use karta hai |
| 20  | Whisper/ASMR: sensitivity + tail padding + per-segment override | `absFloorDB = -56` — whisper **us se niche** hota hai, to poora file silence | Conservative dial **absolute floor bhi -70** karta hai (ASMR floor), + **protect pin** per line, auto-cut protected lines ko chhuta hai              |

---

## M2. Naye bugs — B13 se B20 (MiMO ke B12 ke baad)

Ye woh khaali jagahain jo doc aur code ke beech thi. MiMO ne B1–B12 dekhe
(theek-thaek); maine **cases 11–20 ki** ke liye ye nikale.

### B13 — Peak-relative threshold, dono taraf galat _(Case 19, 18)_

- **Kahan:** `go/internal/vad/vad.go`, `measure()`.
- **Evidence:** purana rule `T = max(-56 dB, peak/64)` tha.
  - **Fan wala phone recording:** room tone −28 dBFS, peak −3 → `peak/64` =
    −49 dB → `T = −49` → fan ki shanti (−28) bhi "awaaz" hai → **koi silence
    hi nahi milti** → kuch nahi kat-ta. (Ye doc ke Case 19 ka pehla scenario
    hai — maine ise test se reproduce kiya.)
  - **Studio recording:** room tone −60 dBFS → fixed −30 se har saans
    "silence" → video had had kat-ta. (Doc ka doosra scenario.)
- **Fix:** peak-relative rule **hata diya**. Ab: floor **p10 percentile**
  (frames jinme koi signal ho), speech **p95**, aur
  `T = max(absFloor, min(floor + margin, speech − 3 dB))`.
  - `floor + margin` = "room tone se kitna upar".
  - `speech − 3 dB` = "speech se upar kabhi nahi jaana" — ye guard woh
    failure rokta hai jahan floor aur speech ek hi level par hain (uniform
    quiet recording) aur margin akela threshold ko speech ke **upar** le
    jaata, jisse poora file silence ho jaata.

### B14 — Do silence definitions ek dusre se lad rahi hain _(Case 19)_

- **Kahan:** `vad.go` ka `absFloor/peak` (upload gate) vs `audio.rs` ka
  `silencedetect -30 dB` (cut map).
- **Bug:** ek hi file par gate "awaaz hai" bole aur cut map "silence" bole —
  editor do alag duniya dekhta hai. MiMO ne ise B2 bola tha; maine isko **aadha
  fix** kiya: dono ab **ek threshold** par aate hain (`floor + margin` ka
  rule ek hi jagah hai — `vad.thresholdFor`), aur cut map ko wahi number
  `POST /v1/audio-profile` se milta hai. Poora fix (gap-map ko daemon
  banana, `audio_map` table) bacha hai — §M6.5.

### B15 — Language pin = pehla chunk _(Case 12, 44)_

- **Kahan:** `server.go`, `runTranscribe` — `if language == "" && res.Language != ""`
  → pehla successful chunk pin kar deta tha.
- **Evidence:** MiMO ka B4. Maine ise confirm kiya aur ek **naya test** likha
  jo do alag cases alag karta hai:
  - do chunks **same** bhasha bolte hain → teesre chunk ko pin milta hai;
  - do chunks **alag** bhasha bolte hain → **kuch pin nahi** hota.
- **Fix:** `internal/api/language_pin.go` — pin do consecutive agreeing
  chunks ke baad, disagreement par pin **chhod diya jaata hai** (galat pin
  poori job kharab karta hai, pin na hone se sirf thodi script consistency
  jaati hai).

### B16 — Script cross-check aur Hinglish ka jhagda _(Case 12, 39)_

- **Kahan:** naya `internal/script`.
- **Bug:** pehla cross-check likha tha "Devanagari% vs pinned lang". Usne
  **Hinglish ko galat** pakad liya: pin `hi`, text Devanagari → 25% se kam
  Devanagari → "mismatch" → pin chhod diya gaya. Aur aapka apna autocorrect
  prompt ("Never output Devanagari") Latin script maangta hai — to Roman
  Hinglish bhi "mismatch" ban gaya.
- **Fix:** do alag sawaal ab:
  - `Check()` — **UI ke liye**: "kya text us bhasha ki script me hai?" (warning)
  - `Conflicts()` — **decision ke liye**: "kya text us bhasha ke alawa kisi
    **doosri** script me hai?" — Latin **neutral** maana gaya, kyunki usme
    code-switching normal hai. Sirf ek **doosri** script (Tamil, Cyrillic,
    Arabic) hi conflict hai.
- **Proof:** `TestHinglishInRomanScriptDoesNotReleaseThePin` — Roman Hinglish
  par pin zinda rehta hai; `TestATextInAnotherScriptReleasesThePin` — Tamil
  text par pin chhota hai.

### B17 — "Hindi detect hua" aur "text Devanagari" — dono ek hi baat bolte hain _(Case 13)_

- **Kahan:** `language_pin.go`.
- **Bug (yeh accept karna zaroori hai):** accented-English wala case — Whisper
  `hi` detect karta hai **aur** Devanagari me likhta hai. Pin aur text
  **aapas me agree** karte hain, to script cross-check use **pakad hi nahi
  sakta**. Sirf user ke paas ground truth hai.
- **Fix (partial, aur ye honest hai):** user ka pin kabhi release nahi hota —
  sirf **warning** milti hai ("text Devanagari hai par language English pin
  hai"), aur UI me ek click ka override hai. Auto-detected pin release hota
  hai, lekin sirf tab jab text **doosri** script me ho.

### B18 — "Music" aur "No speech" ek hi jawab the (Case 16, 17)_

- **Kahan:** `model.Job` — sirf `NoSpeech` tha.
- **Bug:** music-only file par app "Koi speech nahi mili" dikhati thi, aur
  "Phir bhi try karo" button deti thi — jo kabhi words nahi dhoondhega. User
  ko galat umeed di jaati thi.
- **Fix:** naya `Job.Music` + alag UI card ("Ye ek music project hai" —
  waveform-first ka raasta) + `NoSpeechError.music`.

### B19 — Music ka verdict 10 chunks ki mehnaat se nahi, 2 se _(Case 16)_

- **Kahan:** `runTranscribe`.
- **Fix:** do consecutive chunks jismein **awaaz** thi par **words nahi**
  (provider ke `no_speech_prob` se confirm) → file "mostly sound" hai
  (`speech_ratio ≥ 0.4`) → **baaki chunks upload hi nahi hote**.
  - Ek wordless chunk **kaafi nahi**: ek video title card + disclaimer + pause
    se shuru ho sakta hai. Do chahiye.
  - File "mostly quiet" ho to music nahi maana jaata — wahan shaanti ke gaps
    hain, music nahi.

### B20 — Provider ka "mujhe yakeen nahi" evidence swallow ho jata tha _(Case 16, 24)_

- **Kahan:** `cloud.go` — `isNonSpeech(s)` filter.
- **Bug:** jo segments provider ne **low confidence** maankar diye, wo
  silently drop ho jate the. Daemon ko pata hi nahi chalta tha ki chunk
  me "awaaz thi par words nahi" — jo music verdict ka **poora signal** hai.
- **Fix:** `ChunkTranscript.RawSegments` + `ChunkTranscript.NoSpeechRatio` —
  filter se pehle ka hisaab. Ab daemon jaanta hai: "provider ne 12 segments
  diye, 12 low-confidence the" = music bed.

---

## M3. Go daemon — kya likha (code ke saath)

### M3.1 `internal/vad/vad.go` — adaptive threshold + sensitivity dial (Case 18/19/20)

Naya rule, ek jagah:

```go
// thresholdFor puts the bar between the floor and the speech level.
//
// Two rules, both load-bearing:
//
//   - "floor + margin" is the intent: how far above the room tone a frame
//     has to sit to count as sound.
//   - never above "speech level - minSpeechMarginDB": in a file where the
//     floor and the speech level are the same - a uniformly quiet lecture, or
//     a file with no silence in it at all - the first rule alone would put
//     the bar *above* the speech and call the whole file silence.
func thresholdFor(floorDB, speechDB, absFloor, margin float64) float64 {
	candidate := floorDB + margin
	if limit := speechDB - minSpeechMarginDB; candidate > limit {
		candidate = limit
	}
	if candidate < absFloor {
		candidate = absFloor
	}
	return candidate
}
```

Floor aur speech **ek hi pass** se, digital-silence frames ko chhod kar:

```go
func measureLevels(energies []float64, absFloor float64) (floorDB, speechDB float64) {
	levels := make([]float64, 0, len(energies))
	for _, e := range energies {
		if e <= 0 {
			continue // digital silence: a gap, not a level
		}
		levels = append(levels, amplitudeDB(e))
	}
	if len(levels) == 0 {
		return absFloor, absFloor
	}
	sort.Float64s(levels)
	return percentile(levels, floorPercentile), percentile(levels, speechPercentile)
}
```

**Digital-silence frames chhodne ka reason** important hai: nahi to jo file
me gaps hain, uska floor −∞ ho jaata, threshold room tone se neeche gir
jaata, aur room tone "awaaz" ban jaata — yaani adaptive threshold ka poora
point hi khatam.

Sensitivity dial (margin) + ASMR floor:

```go
var sensitivityMargin = map[Sensitivity]float64{
	SensitivityConservative: 3.0,
	SensitivityBalanced:     9.0,
	SensitivityAggressive:   18.0,
}
```

| Dial           | Margin | Kya badalta hai                                             |
| -------------- | ------ | ----------------------------------------------------------- |
| Conservative   | 3 dB   | + absolute floor **−70 dB** (ASMR floor) — whisper bachta hai |
| Balanced       | 9 dB   | sirf margin                                                  |
| Aggressive     | 18 dB  | zyada dead air kat-ta hai, quiet speech ka risk             |

Naye accessors (jo profile banaate hain): `NoiseFloorDB()`, `SpeechDB()`,
`SNRDB()`, `PeakDB()`, `ThresholdDB()`, `MarginDB()`, `SpeechRatio()`, aur
naya entry point `ScanWith(path, Options)`.

### M3.2 `internal/script/script.go` — naya package (Case 12/13/44)

Unicode block counting: Devanagari, Bengali, Gurmukhi, Gujarati, Oriya,
Tamil, Telugu, Kannada, Malayalam, Sinhala, Thai, Arabic, Hebrew, Greek,
Cyrillic, CJK, Hangul. Sirf **letters** ginte hain — digits aur punctuation
kisi script ke nahi hote.

```go
// Conflicts reports whether the text is written in a script that
// *contradicts* the pinned language, as opposed to merely code-switching
// out of it.
func Conflicts(text, langCode string) bool {
	ratio := Analyze(text)
	if ratio.Total() == 0 {
		return false
	}
	observed := ratio.Dominant()
	expected := ExpectedScript(langCode)
	if observed == ScriptLatin {
		return false // Latin is neutral: code-switching into it is normal
	}
	return observed != expected
}
```

`ExpectedScript(code)` ISO-639-1 → script map deta hai (`hi`→devanagari,
`ta`→tamil, `ar`→arabic …), aur Latin-script bhashayein (en/de/fr) ke liye
`latin` — lekin `Check()` unke liye **lenient** hai (60% rule), kyunki
Hinglish me English words normal hain.

### M3.3 `internal/api/language_pin.go` — pin state machine (Case 11/12/13/44)

```go
const agreementChunks = 2

func (p *languagePin) observe(detected string) string {
	// The user's choice wins, always.
	if p.forced != "" {
		return p.forced
	}
	code := normalizeLang(detected)
	if code == "" {
		return p.current // a chunk that reported nothing is not a disagreement
	}
	if code == p.candidate {
		p.agreements++
	} else {
		p.candidate = code
		p.agreements = 1
	}
	if p.current == "" && p.agreements >= agreementChunks {
		p.current = code
	}
	return p.current
}
```

Aur conflict par pin chhodna:

```go
func (p *languagePin) noteMismatch(text string) {
	lang := p.language()
	if lang == "" {
		return
	}
	// Only a real conflict counts. Text in Latin under a Hindi pin is
	// Hinglish in Roman script - normal, and not a reason to touch the pin.
	if !script.Conflicts(text, lang) {
		return
	}
	verdict := script.Check(text, lang)
	if p.forced != "" {
		p.warning = verdict.Reason // the user is told, never overruled
		return
	}
	p.current = ""
	p.candidate = ""
	p.agreements = 0
	p.warning = verdict.Reason + " - language pin released, the next chunk is detected again"
}
```

### M3.4 `internal/api/audio_profile.go` — measurement endpoint (Case 16/17/18/19/20)

Naya endpoint: `POST /v1/audio-profile`. Ye **cut map se pehle** call hota
hai, taaki silence threshold file ke hisaab se ho.

```go
func measureProfile(chunks []model.ChunkRequest, sensitivity string) (*model.AudioProfile, error) {
	opt := scanOptions(sensitivity)
	floors := make([]float64, 0, len(chunks))
	speeches := make([]float64, 0, len(chunks))
	var (
		duration float64
		audible  float64
		peakDB   = -120.0
		measured int
	)
	for _, c := range chunks {
		scan, err := vad.ScanWith(c.Path, opt)
		if err != nil {
			continue // one unreadable chunk is not a failed measurement
		}
		measured++
		duration += scan.DurationSecs()
		audible += scan.AudibleSecs()
		floors = append(floors, scan.NoiseFloorDB())
		speeches = append(speeches, scan.SpeechDB())
		if p := scan.PeakDB(); p > peakDB {
			peakDB = p
		}
	}
	...
}
```

Chunk-level numbers **median** se fold hote hain (mean nahi): ek loud
passage ka chunk file ka floor nahi uthayega.

Profile ka shape (`model.AudioProfile`): `duration_secs`, `audible_secs`,
`speech_ratio`, `noise_floor_db`, `speech_db`, `snr_db`, `peak_db`,
`threshold_db`, `margin_db`, `sensitivity`, `silence_threshold_db`,
`chunks`, `measured`.

### M3.5 `internal/api/server.go` — the loop

`runTranscribe` me ab:

```go
// 1. The measurement pass, before a single byte goes to the provider.
profile, profileErr := measureProfile(req.Chunks, req.Sensitivity)
if profileErr == nil {
	s.store.setAudioProfile(jobID, profile)
}

// 2. The badge on every line of this chunk.
chunkLanguage := res.Language
if code := cloud.NormalizeLanguage(chunkLanguage); code != "" {
	chunkLanguage = code
} else {
	chunkLanguage = language
}
for si := range res.Segments {
	res.Segments[si].Language = chunkLanguage
}

// 3. The detector gets a vote only after the text is in.
language = pin.observe(res.Language)
if len(res.Segments) > 0 {
	pin.noteMismatch(segmentText(res.Segments))
}

// 4. The music verdict.
if len(res.Segments) == 0 && res.RawSegments > 0 {
	wordlessChunks++
} else if len(res.Segments) > 0 {
	wordlessChunks = 0
}
if wordlessChunks >= musicProbeChunks && musicLikely(profile) {
	s.store.setFailedChunks(jobID, failedIdx)
	s.store.succeedMusic(jobID, failures)
	return nil
}
```

Naye routes: `POST /v1/audio-profile`, `POST /v1/translate`.
Naye store methods: `succeedMusic`, `setAudioProfile`, `setLanguage`,
`succeedTranslate`.

### M3.6 `internal/cloud/translate.go` — translation view (Case 11, 15)

Gemini ke upar ek naya pass. **Source text kabhi replace nahi hota** —
`TranslatedText` alag field me jaata hai, aur `TranslationSource` batata hai
kis provider ne banaya.

```go
// The guards here are a refusal to mislabel a line. An out-of-range index, a
// count mismatch or an empty string leaves the line untranslated - the UI
// then shows the source text alone, which is correct, instead of a
// translation that belongs to a different line.
if len(byIndex) != len(dst) {
	return
}
for i := range dst {
	if _, ok := byIndex[i]; !ok {
		return
	}
}
```

Prompt bhi ye kehta hai: *"Translate meaning, do not rewrite … a line that is
already in English comes back unchanged."* — kyunki ek summariser se
translation nahi aata, aur aadha sentence gum hua hua translation user ko
bataya nahi jaata.

### M3.7 `internal/model/model.go` — contract

Naye fields (sab `camelCase` nahi — ye daemon ka snake_case contract hai):

```go
// Segment
Language         string `json:"language,omitempty"`
TranslatedText   string `json:"translated_text,omitempty"`
TranslationSource string `json:"translation_source,omitempty"`
Protected        bool   `json:"protected,omitempty"`

// Job
Music           bool          `json:"music,omitempty"`
Language        string        `json:"language,omitempty"`
LanguageWarning string        `json:"language_warning,omitempty"`
AudioProfile    *AudioProfile `json:"audio_profile,omitempty"`
Translated      []Segment     `json:"translated,omitempty"`

// TranscribeRequest
Sensitivity string `json:"sensitivity,omitempty"`
```

---

## M4. Frontend — kya likha

| File                                  | Kya badla                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/lib/audio-profile.ts` (naya)     | `AudioProfile` type, `fetchAudioProfile()`, `silenceThresholdDb()`, `describeProfile()`, `voiceIsBuried()`, `looksLikeMusic()` |
| `src/lib/languages.ts` (naya)         | 24 bhashayein, `languageLabel()`, `isLanguageSwitch()`                              |
| `src/lib/pipeline.ts`                 | `CloudSegment`/`CloudJob` ke naye fields, `sensitivity` option, naya `runTranslation()`, `NoSpeechError.music` |
| `src/lib/types.ts`                    | `TranscriptLine.language` / `.translatedText` / `.protected`                        |
| `src/lib/stores/project.svelte.ts`    | `audioProfile`, `language`, `languageOverride`, `languageWarning`, `sensitivity`, `music` state; measured threshold; protected lines; `translateTranscript()`; `toggleProtected()` |
| `src/lib/components/cut/TranscriptPanel.svelte` | LANG dropdown, SILENCE dial, profile summary, Translate button, per-line language badge, translation line, protect pin, music card, `dir="auto"` |
| `src/app.css`                         | `--font-sans` me Nirmala UI + Noto family (Case 14)                                  |

Cut map ab measured threshold use karta hai:

```ts
// The threshold is this file's own, measured from its own room tone.
return detectSilence(path, silenceThresholdDb(this.audioProfile), minSecs);
```

Aur protected line auto-cut se bach jaata hai:

```ts
for (const l of this.lines) {
	// A line the user pinned is never auto-cut. The automatic pass is a
	// suggestion; the pin is the user's decision, and it wins.
	if (l.protected) continue;
	...
}
```

---

## M5. Tests — kya proof hai

### Go (daemon)

```
go/internal/vad/vad_test.go        +6 tests   (adaptive threshold, ASMR, sensitivity, profile)
go/internal/script/script_test.go   (new) 9 tests (script ratio, conflict vs mismatch)
go/internal/cloud/translate_test.go (new) 7 tests (source-safe, misaligned reply, failed batch)
go/internal/api/language_pin_test.go(new) 10 tests (bootstrap, forced, conflict, release)
go/internal/api/audio_profile_test.go (new) 8 tests (floor/SNR/threshold, sensitivity, endpoint)
go/internal/api/transcribe_audio_test.go (new) 4 tests (music verdict, badge, profile on job)
go/internal/api/server_test.go      2 tests re-written (pin contract badla)
```

Sab kuch ek line se chalata hai:

```powershell
cd go; gofmt -l . ; go vet ./... ; go test ./...
```

→ **sab package green** (api, cloud, config, dl, queue, script, ublock, vad,
vault).

Sabse important do test:

```go
// Case 19, first half: a phone recording next to a fan. The room tone sits
// at -28 dBFS, which is *above* the old fixed -30 dB threshold, so a fixed
// threshold found no silence anywhere in the file and nothing was ever cut.
func TestAdaptiveThresholdFindsSilenceUnderRoomTone(t *testing.T) { ... }
```

```go
// A reply that does not line up is refused. Shifting a translation by one
// would put the wrong words under the wrong line, which is worse than no
// translation at all.
func TestAMisalignedReplyIsRefused(t *testing.T) { ... }
```

### Frontend

```
src/lib/audio-profile.test.ts (new) 5 tests
src/lib/languages.test.ts     (new) 4 tests
```

```powershell
cd Clipchamp_Bunny; npm run lint ; npm run check ; npm test
```

→ `svelte-check` me **0 errors, 0 warnings**, node test runner me **94+
tests pass**.

---

## M6. Jo nahi bana — honest gaps

Ye hissa sabse zaroori hai. Ye kaam **poora nahi** hua, aur koi agent ise
poora samjhega to galat plan banayega.

1. **Case 11 ka "Hinglish → Roman" alag pass nahi bana.** Reason: repo ka
   autocorrect prompt pehle se kehta hai *"The script. Roman/Latin letters
   only. Never output Devanagari."* — yaani romanization **already** ho rahi
   hai, sirf alag endpoint nahi hai. Jo bacha: per-segment language badge
   (bana) aur romanization ka *trigger* (UI toggle — **nahi** bana).
2. **Case 18 ka ebur128/LUFS pass nahi bana.** Profile me dBFS numbers hain
   (floor, speech, peak, SNR) — PCM se, free. Lekin **integrated LUFS** aur
   **true peak** (ebur128) nahi, aur `afftdn`/`loudnorm` filters transcription
   copy par **nahi** chale. Ye teenon ek alag Rust module maangte hain
   (`src-tauri/src/audiometry.rs`), aur Rust me dusra agent kaam kar raha
   hai — maine jaan-boojh kar nahi chheda.
3. **Case 18 ka "voice buried under BGM" sirf ek *hint* hai.** `snr_db < 8`
   par UI warning dikhata hai; par uske baad koi automatic cleanup nahi.
4. **Case 20 ka speech-tail padding (+0.4 s) cut map par nahi laga.** Cut
   geometry Rust me hai (`audio.rs`/`export.rs`); maine wo chhedi nahi. Jo
   bana: sensitivity dial + ASMR floor + per-line **protect pin**.
5. **Case 20 ka local ONNX VAD nahi bana.** Energy-heuristic + dial +
   protect pin hi implemented answer hai. ONNX CPU VAD Python-free Go/Rust
   me likhna ek alag project hai.
6. **Transcript table me naye columns nahi.** `language`, `translatedText`,
   `protected` abhi app ke apne per-project state (localStorage) me hain, SQLite
   transcript table me nahi. Reason: wahi file Rust crate me hai aur usme
   schema migration chahiye (§M7.1).
7. **Music verdict 2-chunk probe hai, poori file ka analysis nahi.** Ek file
   jisme pehle 2 chunks silent hain aur baad me speech hai, woh galat "no
   speech" ho sakti hai — waise hi jaise doc ka Case 1/25 bhi kehta hai.
8. **`/v1/audio-profile` ke liye daemon chalna zaroori hai.** Daemon band ho
   to app purane fixed −30 dB par wapas aa jaata hai (honest fallback, par
   adaptive nahi).
9. **Ek hi measurement pass, do consumers — aadha.** Daemon 16 kHz mono
   *chunks* maapta hai; cut map source par `silencedetect` chalata hai. Dono
   ek hi *rule* use karte hain, par alag *input* — perfect ekta nahi (§M7.5).

---

## M7. Problems aur suggestions (aapke poochhe hue sawaal)

### 7.1 Transcript schema ko naye columns chahiye — ye agla kaam hai

`Segment` ke naye fields Rust side tak nahi gaye, kyunki transcript table ka
schema `src-tauri/src/transcript.rs` me hai (us file par ek aur agent kaam
kar raha hai — `git status` me dikhta hai).

**Suggestion:** `transcript` table me teen naye columns —
`language TEXT`, `translated_text TEXT`, `protected INTEGER DEFAULT 0` — aur
`migrate_transcripts()` me ek `ALTER TABLE` migration. Uske baad frontend ka
localStorage fallback hata sakte hain. Jo abhi localStorage me hai wo
**project-path se** key hota hai, yaani do alag machines par same project ki
alag copy milegi — theek hai, par ek hi machine par theek hai.

### 7.2 `astats percentile` method exist nahi karta — doc ko patch karna chahiye

Case 19 ka fix likhta hai: *"noise floor measure karo (quietest percentile
astats se)"*. `astats` **whole-file** statistics deta hai, time-series
percentile nahi — wo command waise chalegi hi nahi. MiMO ne ise B9 me
pakda tha.

**Mera approach:** percentile PCM frames se nikala (jaisa upar hai) — ek hi
pass, koi extra command nahi. **Doc me ek line badalni chahiye:** "astats
percentile" → "the 10th percentile of the 10 ms frame levels the local
scanner already reads".

### 7.3 Peak-relative rule hata dena ek **behaviour change** hai

`peak/64` hataane se ek file ka cut behaviour badal sakta hai jahan
"quiet-but-not-silent" passages ab silence gin jaate hain. Purane saare
tests **pass** hain (inme se ek specifically is rule ko test karta tha), par
**ek asli recording par eyeball zaroori hai** — wo main nahi kar paya,
kyunki us 5.3 GB file ka path is machine par nahi hai.

**Suggestion:** deploy ke baad wohi InShot file dobara import karke
"AI ne kitne cut kiye" compare karein — pehle 274 raw gaps the, ab
two-tier classification ke baad ~46 bade zones. Number bada matlab better
nahi hai — *sahi* number hona chahiye.

### 7.4 Music probe me 2 API calls lagti hain

Music pehle 2 chunks ka paisa lagta hai. Ye jaan-boojh kar rakha hai: ek
probe se pata nahi chalta ki file khuli hai ya music hai. 10 chunks ka
paisa bachana behtar hai, par ek galat "music" verdict 48 minute ka
transcript chhodh deta. **Suggestion:** agar probe ke dauran `no_speech_ratio`
bahut high hai (>0.9) to ek chunk par ruk jaana — ek zyada call nahi.

### 7.5 B2 ka asli fix bacha hai: gap-map ko daemon banao

Maine threshold ko ek hi rule par la diya, par **do measurement sites** ab
bhi hain (daemon ke 16 kHz chunks vs FFmpeg ka `silencedetect` source par).
Poora fix ye hai ki **daemon hi gap map banaye** (Case 1 ka "audio map" +
Case 35 ka two-tier classification) aur Rust usko consume kare. Tab:
silence, cut candidates, upload gate aur music ratio — sab **ek** map se.

**Ye B1 (span-map) ke saath ek hi kaam hai** — dono ko ek saath karna
chahiye, warna do jagah alag-alag time par map banegi.

### 7.6 Do flags (`no_speech` + `music`) ek field ban sakte hain

Abhi dono alag hain (ek "shant", ek "music"). Ek `speech_state` enum
(`silent` | `speech` | `music`) saaf hoga aur aage naye cases (jaise "music
bed + ek speech line") me extend hoga. Abhi theek hai, par 52 cases tak
badh raha hai to ek field bachega.

### 7.7 Language override transcript me **persist** nahi hota

`languageOverride` session me rehta hai (UI state), transcript ke saath
nahi. Agli transcription me to chalta hai, par app band karke kholne par
**detector** phir se guess karta hai. Agar user ne mehnat se "ye English
hai" set kiya hai, to wo decision bhi save hona chahiye.

### 7.8 `detect_silence` ka `minSecs` bhi per-file hona chahiye

Sirf threshold adaptive hua. 3 second ka minimum **har file** par same
rehta hai — par 2 GB ki movie (cut-heavy) aur 50 min ka tutorial (chapter
based) ke liye sahi minimum alag hai. Isi tarah Case 35 ka two-tier
classification (micro-gap merge vs bada gap cut) abhi bhi nahi hua — wo
bhi isi "gap map" ka kaam hai (§7.5).

### 7.9 Case 15 ka "pinned language ke saath dobara" button nahi bana

Doc kehta hai: *"re-run option pinned language ke saath"*. Maine **pin**
banaya, par transcript ko **re-transcribe** karne ka button nahi. Wajah:
re-transcribe ka matlab hai **poore video ka dobara paisa** — jo ek line ke
liye galat decision hai. Sahi design: sirf **un lines ko** dobara jise
user ne chuna ho, aur wahi bhi ek button ke saath (agar cost dikhe).

### 7.10 Ek chhota observation: `NoSpeechError` ka message ab do hisso me hai

Pehle message hamesha "Koi speech nahi mili" tha. Ab music ke liye alag
message hai, lekin dono `NoSpeechError` class me hain — kuch jagah
`instanceof NoSpeechError` check karke sirf "no speech" dikhana ab galat
hoga. Maine app ke teen jagah update kiye hain, par aage ka koi feature ye
class check kare to **`.music` bhi dekhna** chahiye.

---

## M8. Closing — deepseek

Cases 11–20 ka asal sawaal ye nahi tha ki "kya karna chahiye" — wo pehle se
likha tha. Sawaal ye tha ki **repo me wo hota bhi hai ya nahi**. Jawab tha:
adhoora. Noise floor koi nahi maapta tha, language pehla chunk pe pin hota
tha, music ke liye koi rasta nahi tha, translation pass nahi tha, tofu boxes
ke liye font stack nahi tha.

Mere addendum ka teesra jodna ye hai: **"har threshold ko apni file se
nikaalna"** — ek measurement, ek rule, bahut se consumers. Isi se case 19
ka fan-wala phone recording theek hota hai, case 18 ka SNR milta hai, case
20 ki whisper bach jaati hai, aur case 16/17 ka music verdict pehle do
chunks me hi pata chal jaata hai.

Do baatein jo main **nahi** chhupaunga: pehla, peak-relative threshold
hataana ek real behaviour change hai aur ek asli recording par check hona
chahiye. Doosra, cases 11–20 ka bada hissa abhi **decide karta** hai, karta
nahi — auto-cut nahi, auto-translate nahi, auto-cleanup nahi. Doc ka
"measure first, suggest, never act" yahi hai, aur isi liye har naya decision
ek **suggestion** hai jo user ke haath me hai.

**— deepseek** (opencode / minimax-m3.1-flash-free) · 2026-11-12
*Upstream: GLM 5.3 (40 cases) + MiMO V2.6 (Part 2) — dono untouched. Ye part
sirf append hai.*

---
---

## M9. Deployment record — ye change desktop par hai

> Ye hissa sirf record hai: kaunsa commit, kaunsa build, aur "live" hone ka
> proof. Iske liye MD me kuch bhi badla nahi gaya — upar ka sara analysis
> waise hi hai.

| Fact | Value |
| --- | --- |
| Commit | `9145bf0b35797f0d133fa8c3551b86b1ba45cb5e` (branch `main`) |
| Build id | `ci-9145bf0` |
| CI run | https://github.com/engrtarun/T9EditorLIT/actions/runs/43165171369 |
| App SHA-256 | `9ba23a931bd133c4ca657cfda424fd7042427bcbf9732f99511905087284d516` |
| Daemon build | `go-166ca7871c23d13c` (SHA-256 `f966a43267f59f553cd916cdca6c85b1d9afe3d132366987e2e3102ef1569719`) |
| Work order | `SARKARI-20261112-113142-8A8B` |
| Scope | `both` (app + daemon) |
| Install dir | `%LOCALAPPDATA%\Programs\T9EditorLIT\` |
| Marker | `build.json` → `mode: installed`, `buildId: ci-9145bf0` |

**Deploy ke do steps hue.** Pehle app chal raha tha, isliye naya binary
`t9-editor-lit.new.exe` ke naam se **stage** hua aur user ke "Update" dabane
ka wait hua. Update dabane par helper ne app **aur** daemon dono swap kiye
(naye binary ka startup panic karta to 2 second me `.prev.exe` se rollback
ho jaata) — marker ab `mode: installed` hai aur koi staged file pending nahi.

**"Live" hone ke sabit (doctor + live calls):**

```
[ok] Live App Executable: PRESENT     SHA-256 9ba23a93…
[ok] build.json Marker: PRESENT        mode: installed, buildId: ci-9145bf0
[ok] Marker hash matches the installed executable.
[ok] Rollback Shield (.prev.exe): READY for instant restore
[ok] Staged Update: No pending staged file
[ok] t9cloud Daemon: RUNNING on localhost:7878 (Version: go-166ca7871c23d13c)
```

Aur naye routes **chalu daemon par** jawab de rahe hain (ye 404 nahi, 502
de rahe hain — matlab route maujood hai, bas test ka chunk path galat tha):

```
GET  /healthz              → ok=True  version=go-166ca7871c23d13c
POST /v1/audio-profile     → HTTP 502 (route ne jawab diya)
POST /v1/translate         → job id d9df5ca5…  kind=translate  state=queued
```

**Ek baat jo isse bhi important hai:** ye commit kisi aur agent ke
ElevenLabs ensemble commit (`6171eb6`) ke **upar** rebase hua tha — dono ne
`server.go`, `model.go`, `pipeline.ts` aur `app.css` chhede the. Do
conflicts the, dono merge kiye: `model.go` me dono ke naye fields (`Engine`
+ `Music`/`Language`/`AudioProfile`) saath rahe, aur `server.go` me **meri
pin state machine** rahi (unka "pehla chunk pin kare" wala rule uske jagah
gaya — wahi baat thi jo M2 me B15 me likhi thi). Rebase ke baad poora Go
suite aur poora frontend suite **dono** green.

---

**— deepseek** (opencode / minimax-m3.1-flash-free) · 2026-11-12
*Upstream: GLM 5.3 (40 cases) + MiMO V2.6 (Part 2) — dono untouched. Ye part
sirf append hai. Deployment record: commit `9145bf0`, build `ci-9145bf0`.*

---

## Round 3 — Cases 1–10 close-out (deepseek, 2026-11-12)

> Append-only record. Yahan sirf wahi likha hai jo is worktree me **verify** hua:
> `npm run check` = 0 errors, `npm test` = 115 pass, `cargo check --tests` dono
> Rust crates me clean. Jo cheez CI ya install ke bina sach nahi hoti, wo
> "Shipping" me alag se likhi hai — pehle se "shipped" nahi bol rahe.
>
> Rebase note: ye round `ee94bb6` par shuru hua tha, aur ship hone se pehle
> Part 3 (ElevenLabs + cases 11–20, `45f6c4a`) ke upar rebase kiya gaya. Do
> conflicts the — `project.svelte.ts` (unka audio-profile/language RPC + mera
> overlap reconciler, dono rakhe) aur yahi doc (dono sections, kuch delete
> nahi). Rebase ke **baad** ke numbers upar hain.

### Browser — "site load hi nahi hoti / bahut slow"

| Root cause | Fix | Kahan |
| --- | --- | --- |
| WebView2 tracking prevention **STRICT** third-party scripts/storage block kar raha tha (YouTube ka player/consent bootstrap isi me phansa) | **BALANCED** (Chromium default). Known cross-site trackers ab bhi block, par site ke apne login/player/comments/checkout kaam karte hain. Fine-grained blocking uBOL karta hai. | `Clipchamp_Bunny/src-tauri/src/browser.rs` (`configure_tab_webview`) |
| Sirf active tab zinda tha — har tab switch par page dobara load | Active + **2 most-recent** tabs tak webview zinda (3 total), uske baad LRU destroy. Pinned tabs alag se Rust rakhta hai. | `src/lib/stores/browser.svelte.ts` (`recent()`) |
| Hidden media flyout ka WebView2 renderer session bhar resident | Idle aur session-clear par `window.destroy()`; agla play `ping` se ~200 ms me recreate karta hai | `Clipchamp_Bunny/src-tauri/src/media_flyout.rs` |
| Background tab par occlusion throttling | Pichhle round me shipped (`e6efab7`) | commit |

### Win+A / Windows media card — bina title/thumbnail "T9 Editor LIT"

| Root cause | Fix | Kahan |
| --- | --- | --- |
| SMTC session install par `SetIsEnabled(true)` + `PlaybackStatus::Closed` ke saath ban jaata tha | Session **disabled** shuru hota hai; sirf titled live playback par enable, last stop par disable + `ClearAll` | `Clipchamp_Bunny/src-tauri/src/smtc.rs` |
| Page `play()` ke baad `mediaSession.metadata` set karta tha, shim dobara report hi nahi karta tha | Shim metadata ko observe karta hai (title/artist/album/artwork aate hi re-report) | `src-tauri/src/browser_shim.js` |
| Non-HTTP artwork URL SMTC ko de diya jaata tha (blank thumb) | Sirf `http(s)` artwork accept; title/channel ke honest fallbacks | `browser_shim.js`, `smtc.rs` |
| "Kabhi play nahi hua" aur "paused" me farq nahi tha | Live report ki shart: `playing`/`paused` **aur** non-empty title. Preload/hover wala silent `<video>` card nahi banata. | `smtc.rs` (`update`) |

### Cases 1–10 — final status

| Case | Status | Kya hua (code) |
| --- | --- | --- |
| 1 — speech-spans / silence na bheje | **fixed** | `audio.rs`: ek `silencedetect` pass, speech complement ke spans, leading/trailing silence trim, cut silence ke beech. `plan_spans` deterministic. |
| 2 — cost pehle dikhe | **shipped (pehle)** | `estimateForDuration` / `planEstimate`; batch panel wahi helper use karta hai. |
| 3 — renamed copy dobara transcribe | **fixed** | `media.rs::content_fingerprint` — size + first/last 256 KiB, dual FNV-1a, 32 KiB buffer (file RAM me nahi). `transcript.rs`: `source_fingerprints` table + `transcript_by_hash`; `lib.rs` ke 4 commands; `project.open`/batch hash-hit par lines naye path par copy. |
| 4 — 30 files + Groq 429 | **fixed** | `batch-queue.ts` (pure model/estimate), `stores/batch.svelte.ts` (persisted queue, **sequential** worker, per-file status), `BatchQueuePanel.svelte` (3/30 position, per-file cost, stop after current, failed rows keep their reason), dashboard "Batch transcript". Ek waqt me ek file — 429 ka structural fix. |
| 5 — 2 GB movie / vault | **fixed (app path)** | `MAX_SEGMENT_SECS = 760` (16 kHz mono ≈ 24.3 MB < Groq 25 MB), `plan_spans` target clamp, per-span FFmpeg extraction. Video bytes decode hote hi chhoot jaate hain (pehle se). Daemon-side 413 split future hardening hai, par 760 s cap usse pehle hi rok deta hai. |
| 6 — studio WAV / tmp storage | **fixed (WAV path)** | Har chunk ka WAV transcript save hote hi `remove_audio_chunk` se delete (`project.transcribeSpan`, batch worker). Plan complete par poora chunk dir clean. FLAC variant abhi nahi — daemon reader change chahiye, isliye alag PR. |
| 7 — 1 s se chhota clip | **shipped (pehle)** | `startTranscript` < 1 s par bina API call friendly error. Batch worker bhi wahi gate lagata hai. |
| 8 — lambe files ka chunking | **fixed** | Same `plan_spans`: target ~300 s, silence boundary par cut, hard ceiling 760 s, deterministic. |
| 9 — chunk boundary par word tear | **fixed** | Har span ke dono side **0.6 s overlap**; `reconcileBoundary` (Levenshtein ≤ 2 + timestamp overlap + normalized text) duplicate ko ek line karta hai, alag sentences dono rakhta hai. Rust + TS tests. |
| 10 — network/power/API down | **fixed** | (a) Plan SQLite `kv` me — pending chunk wahin se retry. (b) `TranscriptPanel` footer me **evidence-based offline badge**: sirf `Failed to fetch`/ECONNREFUSED/ENOTFOUND jaisi connection failure par "Offline — N chunk pending"; 429/5xx/bad audio apni honest wording rakhte hain. (c) Naya setting `set.autoResumeTranscript` (default **off**, `t9-editor-lit.autoResumePlan`): project kholne par sirf wahi plan khud aage badhta hai jisme pehle se `done.length > 0` — jis project me transcript maanga hi nahi, wo chup rehta hai. |

### Tests / verification (local)

- `Clipchamp_Bunny`: `npm run check` — 0 errors, 0 warnings.
- `Clipchamp_Bunny`: `npm run lint` — prettier clean.
- `Clipchamp_Bunny`: `npm test` — **115 pass** (is round ke naye: `batch-queue.test.ts`
  11, `transcript-plan.test.ts` me offline classifier + overlap cases; baaki 9
  Part 3 ke hain jo rebase me aaye).
- `src-tauri`: `cargo fmt --all -- --check` — clean.
- `src-tauri`: `cargo check --tests` — clean (2 `unused_mut` warnings is round me
  fix kiye, kyunki CI `clippy -D warnings` hard gate hai).
- `Clipchamp_Bunny/src-tauri`: `cargo check --tests` — clean.
- Go untouched is round; daemon contract same (`chunk.path + offset_secs + index`).

### Shipping

- Commit is worktree se `main` par jaata hai; compile **GitHub CI** karta hai
  (`sarkari-artifact.yml`), phir `deploy.ps1 -Ci`.
- App chal raha ho to naya build **staged** hota hai (`t9-editor-lit.new.exe`);
  user **Update** click karta hai. Us click se pehle desktop purana build chalata
  hai — is section ko "desktop par live" mat samajhna.
- Deploy ka final sach ledger me hoga (`deploy.ps1 -Status`: `shipped`/`staged`).

**Deploy result (2026-11-12 12:44 IST):** order `SARKARI-20261112-124420-0743`,
build **`ci-ebcc94c`**, mode **live** — app band tha, isliye seedha install hua,
koi **Update** click nahi chahiye. Installed SHA-256 `00892d5c…c0184`; doctor:
marker buildId == `ci-ebcc94c`, marker hash == exe hash, rollback shield ready,
daemon `go-166ca7871c23d13c` running on 127.0.0.1:7878. `-Status` me
`[SHIPPED]`.

— deepseek

---

# PART 4 — deepseek Addendum: Cases 21–40 implemented (code, not analysis)

> **Signature: deepseek** (opencode / deepseek-v4.1-flash-free) · 2026-11-13
>
> **Upstream untouched:** GLM 5.3 ke 40 cases, MiMO V2.6 ka poora Part 2, aur
> mera hi Part 3 (cases 11–20) — teeno **byte-for-byte waise hi** hain. Ye
> part sirf **append** hai.
>
> **Scope:** Cases **21 → 40** (Group D ka baaki hissa, Group E, Group F, aur
> poora Group G). Is baar bhi **analysis nahi — implementation**: Go daemon +
> Svelte frontend, dono chalu, dono tested, dono desktop par.
>
> **Ground rules jo follow hue:** Python **banned**, paid service **banned**,
> full-file RAM buffer **banned**, original media **sacred** (ek bhi byte
> overwrite nahi), aur "auto-delete" ki jagah "suggest + confirm".
>
> **Rust engine chhua nahi.** `src-tauri/` par doosra agent kaam kar raha hai
> (AGENTS.md §10.3). Is baar bhi wahan kuch zaroori nahi tha: gate, post-pass,
> lexicon aur layout — sab Go me hain, aur cut-map ka threshold pehle se
> frontend se aata hai.

---

## P0. Ek paragraph

Part 3 ke baad ek ajeeb si baat reh gayi thi: app **cases 1–20** ke liye theek
tha, par **21–40** ka poora hissa — reverb, crosstalk, bracket tags, loops,
retakes, corrupt phone files, 4K60, A/V offset, InShot bloat, VFR, colour tags,
ASR copy size, 274-gap map, generation loss, face-cam, rotating watermark,
Hinglish lexicon, video ka shape — **sirf doc me tha**. Code me in 20 cases ka
nishaan tak nahi tha: `grep -ri "remux\|crosstalk\|lexicon\|bracket\|vfr"` kuch
nahi deta tha, silence map ka **raw output hi cut-list** thi (274 gaps = 274
buttons), aur Whisper jo `[Music]` likhta tha wo transcript me waise hi pada
rehta tha.

Maine ye **teen layers** par likha:

1. **Go daemon** — 4 naye packages: `internal/mediaprobe` (import gate +
   remux + layout), `internal/postpass` (tags, loops, retakes, crosstalk,
   lexicon), `internal/lexicon` (persistent vocabulary), aur
   `internal/api/media.go` (4 naye routes). `runTranscribe` me post-pass
   wiring, `runCorrect` me lexicon-aware prompt.
2. **Frontend** — 6 naye pure modules (`media-report`, `silence-map`,
   `shape`, `transcript-tags`, `lexicon`, `encode-count`), store me naye
   state + methods + auto-cut guards, aur 3 naye UI components
   (`ProjectHealth`, `ShapeStrip`, `LexiconCard`) jo transcript panel aur
   Settings me wired hain.
3. **Tests** — **35 naye Go tests** (4 packages) aur **41 naye frontend
   tests** (6 modules). Poora suite: Go ke saare packages green, frontend
   **139/139** pass.

Ek baat shuru me hi saaf kar doon: **sab kuch implement nahi hua.** Jo cheezein
advice-only reh gayin (proxy transcode, A/V shift, filmstrip masking, SQLite
persistence) wo neeche **P6** me naam-le-naam likhi hain. Doc me "fix" likhna
aasan hai; code me wo cheez na hona aur chup reh jaana — wo sabse bura hai.

---

## P1. Case-by-case — doc kya kehta tha, code me kya tha, ab kya hai

| #   | Doc kya kehta tha | Code me kya tha (ground truth) | Ab kya hai |
| --- | --- | --- | --- |
| 21 | Reverb tail ko speech maano; <1 s gaps merge karo | `silencedetect` ka raw list seedha cut-list | `classifyGaps`: 1 s se kam bridge **tabhi** merge hota hai jab koi transcript line us strip ko cover na kare (warna asli shabd nigal jaata). Teen tier: micro <1.5 s, medium 1.5–5 s, big ≥5 s |
| 22 | Overlap = crosstalk flag; auto-cut kabhi na chhue | Kuch nahi — detector "pause" ko silence samajhta tha | `MarkCrosstalk`: word timings hon to **0.3 s**, warna **0.5 s** overlap par dono lines `crosstalk` + `needs_confirm` + `keep`. Auto-cut in lines ko skip karta hai |
| 23 | `[Music]`/`[Applause]` parse → icon, text se exclude | Text me waise hi pada tha | `Tags` (closed list: music/applause/laughter/silence/inaudible/cough/sigh/beep/noise + Devanagari `[संगीत]`), UI me icon, text **delete nahi** — tag data hai |
| 24 | Repeated n-gram dedupe + "(repeated)" flag | Kuch nahi; hallucination loop transcript me 30 rows | `CollapseLoops`: ≥3 identical (stock phrase jaise "thank you for watching" **2** bhi), gap ≤45 s, run ≥2 s. Pehli line `RepeatCount=N`, baaki `Repeated` + cut |
| 25 | Intro/outro music → placeholder, chunk skip | No-speech gate tha, par intro music par hallucination hi aata tha | Music verdict (Part 3) + shape ka intro/outro keep-zone; **naya**: intro window ab keep-zone hai, flat auto-cut usse nahi khata |
| 26 | Highlight + one-click confirm; filler alag | `suggestions.ts` retake suggest karta tha, par apply par cut | `FlagRetakes`: 2+ token ka common prefix, ¾ line match, ≤2.5 s gap → **sirf suggestion**. `Keep` waise hi, `NeedsConfirm`, UI me `RETAKE?`/`STUTTER?` + **cut/keep** buttons. Auto-cut kabhi nahi |
| 27 | Import gate: ffprobe + remux copy | Kuch nahi — file seedha khulti thi | `mediaprobe.Probe` (ek ffprobe pass) + `Remux` (`-map 0 -c copy +faststart`, **nayi file** user cache me). Report me `probe_failed`/`duration_split` + `action: remux` chip |
| 28 | Audio-only = audio project mode | MP3 par bhi video preview ka blank stage | Report `audio_only`, layout pass skip, summary "audio only", `isAudioProject()`. Filmstrip/preview ka graceful grey card **nahi** banaya (P6.8) |
| 29 | 4K60 5 GB: har layer apni chhoti copy | Audio extraction / chunks pehle se the (Part 3) | Gate ab `long_source` + `asr_copy_bytes` + bloat batata hai; layout 12 seeked frames (60 KB), koi full decode nahi |
| 30 | A/V offset measure + timeline mapping me apply | Kuch nahi | `avOffsetSecs` measure hota hai (audio start − video start), UI me number dikhta hai. **Export spans me shift nahi** — P6.3 |
| 31 | "50 min, 5.3 GB — InShot bloat" card | Kuch nahi | `Bloat` struct: actual vs target bitrate, target bytes, savings %, bytes/min. Report me `bloat` issue + detail |
| 32 | VFR detect; PTS-based seek, frame-count math nahi | Seek pehle se time-based tha (theek), par detect koi nahi karta tha | `VFR` flag jab avg vs nominal rate rational match na kare; report me `vfr` issue + explainer. Naya frame-index math **kahin add nahi kiya** |
| 33 | Colour metadata chip; proxy me BT.709 flags | Kuch nahi | `color_metadata` issue (range/space/transfer/primaries detail ke saath). Proxy transcode **nahi** — P6.1 |
| 34 | 16k mono ASR copy; wahi waveform/chunks ka source | Pipeline audio chunks bhejti thi, par size ka koi honest number nahi | Report `asr_copy_bytes` = duration × 2000 B/s (16 kbps mono ka estimate). Asli copy banana Rust ka kaam hai — P6.7 |
| 35 | 274 gaps ka two-tier map, "46 bade = 23:28" | Raw ranges = 274 decisions | `classifyGaps` + `gapStats` + `gapSummary`: "46 bade gaps = 23:28 · 113 medium · 115 micro". Auto-cut **sirf big**, medium opt-in, micro kabhi nahi |
| 36 | Encode counter per project; 2+ par warn | Kuch nahi | `encode-count.ts`: per-source localStorage counter, export success par `noteExport()`, 2nd export se warning. SQLite nahi — P6.5 |
| 37 | Static overlay detect (sparse frames) | Kuch nahi | `SampleGrid`: 12 fast seeks, 96×54 greyscale, 3×3 motion/detail grid → `static_overlay` (watermark-like) + `busy_corner` (face-cam-like) + advice. Filmstrip masking nahi — P6.2 |
| 38 | Watermark learn-once, perceptual checks se exclude | Kuch nahi | Wahi ek pass static corner `bottom-left` etc. deta hai; UI "watermark bottom-left" dikhata hai. Exclusion wiring nahi — P6.2 |
| 39 | Creator lexicon: ek baar seekho, har video par bias | `/v1/correct` tha, vocabulary nahi | `internal/lexicon` (JSON, atomic write, **7 default terms** live file se) + `ApplyLexicon` deterministic pass + `CorrectSegmentsWithLexicon` prompt bias + Settings me editor + `lexicon_hits` per line |
| 40 | Shape strip: intro/teach/demo/story/outro; hooks suggest-keep | Kuch nahi; flat auto-cut intro/outro bhi kha jaata tha | `buildShape` (windowed density + pace + CTA vocabulary), `ShapeStrip` UI, aur auto-cut `subtractKeepZones` se intro/outro/CTA ko **chhodta hai** |

---

## P2. Go daemon — kya likha (code ke saath)

### P2.1 `internal/mediaprobe` — import gate, remux, layout

Teen kaam, ek package, kyunki teeno ek hi sawaal ke teen jawab hain: "is file
ka kya bharosa hai?" Gate **synchronous** hai (ek child process, koi decode
nahi), remux **async job** hai, layout **synchronous measurement** hai.

```go
// Probe ek ffprobe pass chalata hai. Fail hone par error nahi — report me
// probe_failed issue + action:"remux" aata hai, taaki file phir bhi khule.
func Probe(ctx context.Context, path string) (Report, error)

// AnalyzeJSON probe ka pure half hai: ffprobe JSON → Report. Isi liye poora
// decision table bina media file ke test ho jaata hai.
func AnalyzeJSON(raw []byte) Report
```

`Report` me wahi cheezein hain jo doc ne maangi thi — `Container`,
`DurationSecs`, `SizeBytes`, `BitRateBps`, `Video`, `Audio`, `HasAudio`,
`AudioOnly`, `Portrait`, `VFR`, `AVOffsetSecs`, `Bloat`, `ASRCopyBytes`,
`Issues`:

```go
type Bloat struct {
    ActualBitrateBps  int64   `json:"actual_bitrate_bps"`
    TargetBitrateBps  int64   `json:"target_bitrate_bps"`
    TargetBytes       int64   `json:"target_bytes"`
    SavingsBytes      int64   `json:"savings_bytes"`
    SavingsPercent    float64 `json:"savings_percent"`
    BytesPerMinute    int64   `json:"bytes_per_minute"`
    AssumedBitsPerPix float64 `json:"assumed_bits_per_pixel"`
}
```

Issue codes (UI inhi par icon/colour chunta hai):

```text
audio_only · no_audio · vfr · color_metadata · av_offset · bloat
duration_split · probe_failed · long_source · low_fps
static_overlay · busy_corner · portrait_source
```

**Remux** — case 27 ka ek hi machine-repair. Original ko chhuta nahi; nayi file
user cache me likhta hai:

```go
func Remux(ctx context.Context, path, outDir string) (string, error) {
    // ...
    cmd := exec.CommandContext(ctx, ffmpegPath(),
        "-v", "error", "-y",
        "-i", path,
        "-map", "0",          // saare tracks, subtitles included
        "-c", "copy",         // packets move, koi decode nahi
        "-movflags", "+faststart",
        "-ignore_unknown",
        out,
    )
    // 20 min timeout; fail par adhoori file remove; size 0 bhi fail
}
```

Default output: `os.UserCacheDir()/T9EditorLIT/remux/` — project folder me kabhi
nahi, kyunki repair copy disposable hai aur user ne uska naam nahi maanga.

**Layout** — case 37 + 38 ka ek hi pass. Poora frame decode nahi; 12 seeked
frames:

```go
func SampleGrid(ctx context.Context, path string, duration float64, samples int) (Grid, error) {
    // har sample: -ss <t> -i <path> -frames:v 1
    //            scale=96:54:force_original_aspect_ratio=decrease,
    //            pad=96:54:...,format=gray  → rawvideo stdout
    // 12 × 5 KB = ~60 KB data, 12 chhote child processes
}
```

`AnalyzeFrames` pure hai (synthetic frames se test hota hai): 3×3 grid,
`Motion[i]` = frame-to-frame change, `Detail[i]` = spatial std-dev. Phir:

- **frozen video guard** — `medianMotion < 0.008` par kuch bhi watermark nahi
  (warna static frame par har corner "watermark" ban jaata),
- **watermark** = wo corner jiska motion picture ke median se bahut kam ho,
- **face-cam** = wo corner jo median se bahut zyada busy ho.

Ye **measurement** hai, decision nahi. Crop/blur/delete user karega.

### P2.2 `internal/postpass` — transcript hygiene, deterministic

Order matter karta hai, aur wo comment me likha hai:

```go
func Process(segments []model.Segment, entries []Entry) Result {
    res.Tags      = ApplyBrackets(segments)   // text nahi chhoota
    res.Crosstalk = MarkCrosstalk(segments)   // sabse safe pehle
    res.Retakes   = FlagRetakes(segments)     // 2-line suggestion
    res.Loops     = CollapseLoops(segments)   // 3+ line collapse
    res.Lexicon   = ApplyLexicon(segments, entries) // sirf yahi text badalta hai
    return res
}
```

Rules jo code me hain (doc ke numbers se, guess nahi):

| Pass | Rule | Result |
| --- | --- | --- |
| Brackets | `[Music]`, `(applause)`, bare `♪`; closed list + Devanagari cues | `Tags []string`, text untouched |
| Crosstalk | word timings: 0.3 s overlap; warna 0.5 s; neighbour window 2 s | dono lines `Crosstalk` + `NeedsConfirm` + `Keep` |
| Retakes | ≥2 token common prefix, ≥75% line match, ≤2.5 s gap; line ke andar 2–3 token repeat | `NeedsConfirm`, `Flag: fumble/retake`, **`Keep` sach me nahi badalta** (fumble line `Keep:true` hi rehti hai) |
| Loops | ≥3 identical (stock phrase 2), gap ≤45 s, run ≥2 s, key ≥3 runes | pehli `RepeatCount=N`, baaki `Repeated` + `Keep:false` |
| Lexicon | alias → term, case-insensitive, **whole word only**, Devanagari ke liye plain match | `Text` badalta hai, `OriginalText` me raw Whisper rehta hai, `LexiconHits` |

Word-boundary wala hissa aasan nahi tha: pehla version `rapid api response` ko
`rapid API response` bana deta tha. Test ne pakda
(`TestLexiconRespectsWordBoundaries`) aur ab ASCII aliases sirf tab match hote
hain jab dono taraf word boundary ho; Devanagari (jisme case/boundary nahi
hota) ke liye seedha substring match chalta hai.

### P2.3 `internal/lexicon` — creator vocabulary, disk par

```go
func DefaultPath() string        // os.UserConfigDir()/T9EditorLIT/lexicon.json
func Open(path string) (*Store, error)
func (s *Store) List() []postpass.Entry
func (s *Store) Replace(entries []postpass.Entry) error   // atomic
```

`Replace` pehle sanitize karta hai (trim, term ≤60 runes, alias ≤80, max 12
aliases, case-insensitive dedupe, self-alias drop, duplicate term drop), phir
temp file + rename se likhta hai — beech me crash ho to purani file poori
rehti hai.

Default list **live file ke measured mistakes** se bhari hai, khaali nahi:

```go
{Term: "RAG", Aliases: []string{"retrive argument document general", "रैग", "राग"}},
{Term: "LLM", Aliases: []string{"एलएलएम", "एल एल एम", "एलेलम", "एलएम"}},
{Term: "ChatGPT", Aliases: []string{"चैनल जीपीटी", "चैट जीपीटी", "चैटजीपीटी"}},
{Term: "API", Aliases: []string{"ए पी आई", "एपीआई"}},
{Term: "vector database", Aliases: []string{"वेक्टर डेटाबेस", "वेक्टर डाटाबेस"}},
{Term: "context window", Aliases: []string{"कॉन्टेक्स्ट विंडो", "कांटेक्स्ट विंडो"}},
{Term: "hybrid search", Aliases: []string{"हाइब्रिड सर्च"}},
```

### P2.4 `internal/api` — chaar naye routes

| Route | Kaam | Fail behaviour |
| --- | --- | --- |
| `POST /v1/media/probe` | sync: `{path}` → `Report` | 400 empty path, 404 missing, **200 + `probe_failed`** unreadable container |
| `POST /v1/media/remux` | async: `{path}` → `202 Job` (`kind: remux`) | 404 missing; job fail par error + partial file delete |
| `POST /v1/media/layout` | sync: `{path, duration_secs, samples}` → `Grid` | 400/404, 200 with empty grid on layout failure |
| `GET/PUT /v1/lexicon` | list/replace vocabulary | PUT 503 jab store configured nahi (tests/daemon-only mode) |

Wiring:

```go
// server.go — runTranscribe, merge ke baad
pass := postpass.Process(merged, s.lexiconEntries())
if pass.Tags+pass.Loops+pass.Retakes+pass.Crosstalk+pass.Lexicon > 0 {
    // job meta: tags_fixed / loops_collapsed / retakes_flagged /
    //           crosstalk_marked / lexicon_fixes
}

// runCorrect — prompt + deterministic pass, dono ek hi vocabulary se
corrected, err := groq.CorrectSegmentsWithLexicon(ctx, req.Segments, s.lexiconEntries(), ...)
```

`model.Segment` me naye JSON fields (`tags`, `repeated`, `repeat_of`,
`repeat_count`, `repeat_kind`, `crosstalk`, `needs_confirm`, `lexicon_hits`) aur
`Job.OutputPath` (`output_path`) — `rename_all = "camelCase"` nahi, ye Go JSON
contract hai, frontend `CloudSegment` isi naam se padhta hai.

---

## P3. Frontend — kya likha

### P3.1 Naye pure modules (sab tested, koi Svelte nahi)

| Module | Kya deta hai | Case |
| --- | --- | --- |
| `media-report.ts` | `sortedIssues` (action→warn→info), `hasAction`, `sourceSummary`, `asrPercent`, `gateVerdict`, `layoutLabel`, `overlayAdvice`, `formatBytes`, `durationLabel` | 27–38 |
| `silence-map.ts` | `classifyGaps` (merge + line veto), `gapStats`, `cutCandidates` (big only), `subtractKeepZones`, `gapSummary` | 21, 35, 40 |
| `shape.ts` | `buildShape` (windowed density/pace/CTA), `keepZones`, `SHAPE_LABEL`, `SHAPE_CLASS`, `shapeSummary` | 40 |
| `transcript-tags.ts` | `tagsOf`, `tagIcon`, `tagLabel`, `renderTaggedText` — Go ke list ka mirror | 23 |
| `lexicon.ts` | `normalizeEntry`, `normalizeLexicon`, `mergeLexicon`, `countHits`, limits (60/80/12) | 39 |
| `encode-count.ts` | `encodesFor`, `bumpEncodes`, `generationWarning` — per-source localStorage | 36 |

### P3.2 Store (`project.svelte.ts`)

Naya state:

```ts
mediaReport = $state.raw<MediaReport | null>(null);
layout = $state.raw<LayoutReport | null>(null);
gapStats = $state.raw<GapStats | null>(null);
lexicon = $state.raw<LexiconEntry[]>([]);
shape = $state.raw<ShapeSegment[]>([]);
encodes = $state(0);
avOffsetSecs = $derived(this.mediaReport?.av_offset_secs ?? 0);
get keepZones(): SilenceRange[] { return shapeKeepZones(this.shape); }
```

Naye methods: `silenceCandidates(ranges)`, `refreshGate(path)`, `runRemux()`,
`loadLexicon()`, `saveLexiconEntries()`, `refreshShape()`, `noteExport()`,
`resolveLine(id, keep)`, `tagIcons(line)`.

**Auto-cut ka guard** — ye sabse zaroori 8 lines hain:

```ts
for (const l of this.lines) {
  if (l.protected) continue;                    // user ka pin
  if (l.crosstalk || l.needsConfirm) continue;   // 22, 26
  if (l.repeated) continue;                      // 24
  for (const r of ranges) { /* overlap = cut */ }
}
```

Aur auto-cut/suggest ka raasta:

```ts
const gaps = classifyGaps(ranges, { lines: this.lines });
const cut = cutCandidates(gaps);              // big only
return subtractKeepZones(cut, this.keepZones); // intro/outro/CTA safe
```

Gate project open hote hi background me chalta hai (`void this.refreshGate(canonical)`),
shape transcript aane / merge / refine ke baad rebuild hota hai, aur cached
transcript rows par tags **text se derive** hote hain — purane project bhi
icons dikhate hain.

### P3.3 UI

| Component | Kahan | Kya |
| --- | --- | --- |
| `ProjectHealth.svelte` | TranscriptPanel ke upar | collapsible source card: summary, issues (severity colour), ASR copy %, remux button, layout regions, encode warning |
| `ShapeStrip.svelte` | TranscriptPanel | 2 px shape bar (click = seek), gap summary, legend |
| `LexiconCard.svelte` | Settings → General | term + "heard as" editor, add/remove, save/reload |
| row badges | TranscriptPanel | `♪` tags, `×N` loop count, `2 VOICES`, `RETAKE?`/`STUTTER?` + **cut/keep** action strip me (nested button nahi) |
| `noteExport()` | ExportMode success | har successful export counter badhata hai |

---

## P4. Tests — kya proof hai

```powershell
# Go
cd go; gofmt -l . ; go vet ./... ; go test ./...
# → sab packages ok (api, cloud, lexicon, mediaprobe, postpass, queue, ...)

# Frontend
cd Clipchamp_Bunny; npm run check ; npm run lint ; npm test ; npm run build
# → svelte-check 0 errors 0 warnings
# → prettier clean
# → tests 139 / pass 139 / fail 0
# → vite build ok
```

| Package / module | Naye tests | Kya pin karte hain |
| --- | --- | --- |
| `mediaprobe` | 12 | issue codes, VFR ratio, colour tags, A/V offset, bloat math, duration split, remux args, layout grid, frozen guard |
| `postpass` | 11 | bracket tags, arbitrary parentheses safe, loop collapse, stock phrase ×2, retake suggestion (Keep nahi badalta), crosstalk vs loop, lexicon word boundary |
| `lexicon` | 6 | round-trip, atomic replace, sanitize, defaults, corrupt file |
| `api` (media) | 6 | probe 400/404/200-broken, remux 404, lexicon round-trip, 503 without store, sanitize+order |
| `silence-map` | 8 | tiers, reverb merge, line veto, big-only candidates, keep-zone subtraction, summary |
| `shape` | 7 | intro/outro positional, demo detection, keep-zones, CTA Hinglish+Devanagari, coalesce |
| `transcript-tags` | 6 | known tags, `(2024)` safe, Devanagari cue, dedupe, render |
| `lexicon` (ts) | 7 | normalization, caps, duplicates, merge, hit preview |
| `encode-count` | 5 | per-source count, corrupt storage, warning threshold, no storage |
| `media-report` | 8 | ordering, action, summary, audio-only, ASR %, layout, verdict, formatters |

Do tests jo product ka **promise** hain, sirf implementation nahi:

```ts
// Case 22/26: auto-cut in lines ko chhoota hi nahi.
// Case 24: repeated line cut hoti hai, pehli line rehti hai.
// Case 40: intro/outro keep-zone auto-cut se bachta hai.
assert.deepEqual(subtractKeepZones([{ start: 0, end: 12 }], [{ start: 0, end: 5 }]),
                 [{ start: 5, end: 12 }]);
```

---

## P5. Naye bugs — B21 se B30 (Part 3 ke B20 ke baad)

Ye wo galtiyan hain jo **implementation ke dauraan** mile — kuch mere apne
code me, kuch doc aur repo ke beech. Sab fix ho chuki hain.

| # | Bug | Kahan | Fix |
| --- | --- | --- | --- |
| B21 | Silence detector ka **raw map** hi cut-list thi — 274 gaps = 274 decisions | `project.svelte.ts` (`autoCutSilence`, `suggestSilences`) | `classifyGaps` + `cutCandidates` (big only) + `subtractKeepZones` |
| B22 | Auto-cut ka guard **sirf** `protected` tha; naye flags (`crosstalk`, `needsConfirm`, `repeated`) silently ignore hote | `cutSilences` | teenon guards add; test se pin |
| B23 | Reopen par tags gayab — SQLite `transcripts` table me `tags` column hi nahi | `ensureTranscript` cached path | text se `tagsOf()` re-derive (purane project bhi icons dikhate hain) |
| B24 | Remux job "succeed" hoke bhi `output_path` khali — job store me naya field set nahi hota tha | `api/store.go` | `succeedRemux(id, out)`; frontend missing path par saaf error |
| B25 | Lexicon replace `rapid api` ke andar `api` badal deta tha | `postpass.replaceInsensitive` | ASCII word-boundary check; Devanagari ke liye plain match |
| B26 | Retake pass `FlagNone` (`""`) ko none nahi maanta tha, isliye completed line par retake flag kabhi lagta hi nahi tha | `postpass.markFumble` | `FlagNone || ""` |
| B27 | Loop test ka premise galat tha — representative line ko `Repeated` maan raha tha | `postpass_test.go` | semantic clarify: representative `RepeatCount`, baaki `Repeated` |
| B28 | Colored/static synthetic frame par har corner "watermark" ban jaata tha (test fixture frozen tha) | `mediaprobe_test.go` | moving gradient + frozen-frame guard ka test; heuristic waise hi |
| B29 | `durationLabel(59)` ka test `0m 59s` expect karta tha, code `59s` deta hai | `media-report.test.ts` | test fix (code sahi tha) |
| B30 | Shape test 6 windows ke liye 1 block expect karta tha, jabki intro sirf start ke paas hota hai | `shape.test.ts` | window 5 s + intro block ka start/end assert |

Sabse zyada der B25 ne khayi: word-boundary ka test likhne ke baad hi pata
chala ki `ReplaceAll` Devanagari par bhi waise hi chalta hai — wahan boundary
ka concept hi nahi hota, isliye do alag raaste chahiye.

---

## P6. Jo nahi bana — honest gaps

1. **Proxy transcode nahi hai (case 33).** Colour metadata **measure** hota
   hai aur UI batata hai, par BT.709 limited-range proxy banane wala koi
   transcode nahi likha. Yani preview ka colour shift **rukega nahi** — sirf
   user ko pata chal jayega ki source ka metadata non-standard hai.
2. **Layout sirf advice hai (cases 37, 38).** 12 frames ka 3×3 heuristic
   regions batata hai; filmstrip ko mask karna, thumbnails se watermark
   hatana, ya crop suggest karna — kuch wired nahi. Rotating watermark
   ("LinkedIn → Instagram → YouTube") ek hi static corner me rotate hota hai,
   isliye wahi `bottom-left` region aata hai; per-section list nahi banti.
3. **A/V offset sirf number hai (case 30).** `av_offset_secs` measure aur
   display hota hai, par export ke spans me shift **nahi** hota. Shift
   silently lagana galat hota (audio/video ka order har file me alag), par
   abhi user ke paas "apply" ka button bhi nahi hai.
4. **Remux ek nayi copy banata hai (case 27).** Original kabhi nahi badalta —
   ye design hai — par nayi copy ko project ka source banana **manual** hai
   (user usse dobara import karta hai). Auto-swap nahi.
5. **Encode counter localStorage me hai (case 36).** Doc SQLite kehta tha;
   implementation per-machine browser storage me hai. App data clear hua to
   counter zero — par generation loss ka warning best-effort hi hona chahiye.
6. **Annotation fields SQLite me persist nahi hote.** `transcripts` table me
   sirf `text/keep/flag/original_text/words` hain. Iska matlab: reopen par
   `tags` text se re-derive ho jaate hain, par `crosstalk`, `needsConfirm`,
   `repeatCount`, `lexiconHits` **kho jaate hain** jab tak transcript dobara
   na bane. Schema change Rust ka kaam hai (doosra agent) — isliye maine
   chhua nahi.
7. **`asr_copy_bytes` estimate hai (case 34).** `duration × 2000 B/s` (16 kbps
   mono) — asli 16k mono file ka size nahi. Pipeline pehle se audio chunks
   bhejti hai; naya copy banane ki zaroorat nahi thi, par number ko "measured"
   kehna galat hoga.
8. **Audio-only ka dedicated grey preview stage nahi (case 28).** Report
   `audio_only` batata hai aur layout skip hota hai, par filmstrip/preview ka
   "ye audio project hai" wala card nahi bana. Player khaali frame dikhata
   hai.
9. **Shape heuristic hai, model nahi (case 40).** Window density + pace + CTA
   words. Intro positional hai, outro CTA par; "story" vs "teach" ka farq
   average line length par. Long analogy segments ko "story" kehna ek guess
   hai — par keep-zone sirf intro/outro par lagta hai, isliye galat guess ka
   nuksan seemit hai.
10. **Medium gaps default me cut nahi hote (case 35).** `includeMedium` option
    code me hai, par UI me toggle nahi — user sirf big gaps cut kar sakta hai.

---

## P7. Problems aur suggestions

**"274 gaps ka collapse sach me 6x faayda deta hai?"** — Haan, par sirf
decision-load ke hisaab se. Live file par 46 big gaps the, unme se bhi kuch
CTA/intro ke andar the; keep-zones subtract karne ke baad asli candidates ~40
reh jaate hain. Ye number UI me dikhta hai (`46 bade gaps = 23:28`), isliye
user ko pehle hi pata hai kitna katega.

**"Crosstalk detector interview me kitna sahi hai?"** — Jitna data dega, utna.
Word timings hon to 0.3 s overlap kaafi conservative hai; nahi hon to 0.5 s.
Ye **false-positive ki taraf** jhukta hai (do lines ko crosstalk mark karna),
jo safe direction hai: auto-cut rukta hai, content nahi jaata. Interview me
speaker turns overlap karte hain, isliye 2–3 lines par flag aana normal hai.

**"Lexicon galat term seekh gaya to?"** — `OriginalText` kabhi nahi badalta,
aur `PUT /v1/lexicon` poora replace karta hai (merge nahi). Settings me
"Reload" purani list wapas laata hai. Sabse bada risk: alias bahut chhota ho
(`api`) to wo common word ko bhi badal dega — isliye word-boundary check hai
aur UI me "whole words only" likha hai.

**"Shape strip par bharosa?"** — Strip **read** hai, lock nahi. Sirf intro/outro
keep-zones auto-cut ko rokte hain, aur wo positional + CTA hain — dono
conservative. Teach/story/demo sirf rang hain; unse koi cut nahi nikalta.

**Aage kya karna chahiye (meri rai):**

1. **SQLite schema** — `tags`, `crosstalk`, `needs_confirm`, `repeat_count`,
   `lexicon_hits` columns (ya ek `annotations` JSON column). Ye Rust ka kaam
   hai; iske bina reopen par post-pass ka aadha kaam dobara karna padta hai.
2. **A/V shift ka explicit button** — "0.7 s shift apply karo" per project,
   preview me dial. Measurement already hai.
3. **Proxy transcode** — ek hi baar, BT.709 limited + CFR, sirf preview ke
   liye; original untouched. Isse cases 32/33 dono band ho jaate hain.
4. **Filmstrip masking** — layout grid ka region thumbnails par grey block;
   watermark rotate kare to bhi thumbnails stable dikhein.
5. **Medium-gap toggle** — ek checkbox, `includeMedium: true`. Code ready hai,
   sirf UI switch chahiye.

---

## P8. Closing

Cases 21–40 ka asli sabak ye hai: **detector ka output ≠ decision**. Poore
Group G ka data (274 gaps, 5.3 GB, 350/354 Devanagari, 5× retake cluster) ek
hi baat kehta hai — measurement sasta hai, decision mehnga. Isliye maine har
jagah **measure → classify → suggest** kiya, aur sirf teen cheezein
automatically cut hoti hain: bade gaps (keep-zones ke bahar), verbatim loops
(3+), aur kuch nahi.

Baaki sab user ke saamne hai: crosstalk par `2 VOICES`, retake par
`RETAKE?` + cut/keep, bloat par remux button, colour par chip, shape par
strip. Ye "kam feature" nahi hai — ye **honest feature** hai. Jo detector
galat ho sakta hai, uska button nahi hona chahiye; uska **evidence** hona
chahiye.

Aur jahan maine kuch nahi kiya (proxy, A/V shift, SQLite persistence,
filmstrip masking), wo P6 me naam se likha hai. Agla agent wahan se shuru
kar sakta hai — guess nahi karna padega.

---

## P9. Deployment record — ye change desktop par hai (staged)

> Ye hissa sirf record hai: kaunsa commit, kaunsa build, aur "live" hone ka
> proof. Upar ka analysis waise hi hai — is section ne kuch badla nahi.

| Fact | Value |
| --- | --- |
| Commit | `a27eabde8b356e0212a176f0431b62deb022ec86` (branch `main`) |
| Build id | `ci-a27eabd` |
| CI run | https://github.com/engrtarun/T9EditorLIT/actions/runs/43376932973 |
| App SHA-256 (staged) | `a0b954e939b147c8e6de80fcd346d719fde6a2a793a05c96c8539e4c88ffcbb9` |
| Daemon build | `go-7a81d8959fe3dfa6` (SHA-256 `66757c632aed8c6b80d6464d25c0c1e973ac8c6cd036be839e70a87937036d23`) |
| Work order | `SARKARI-20261113-114128-7206` |
| Scope | `both` (app + daemon) |
| Mode | **staged** — app chal raha tha, isliye `t9-editor-lit.new.exe` + `t9cloud.new.exe` |
| Install dir | `%LOCALAPPDATA%\Programs\T9EditorLIT\` |
| Apply | app ke top bar me **Update** button → helper swap + restart |

**Do deploys hue, aur doosra pehle ko supersede karta hai:**

| # | Commit | Build | Work order | Result |
| --- | --- | --- | --- | --- |
| 1 | `8e3ae63` | `ci-8e3ae63` | `SARKARI-20261113-112550-17F4` | live install (11:35), app SHA `53c505be…` |
| 2 | `a27eabd` | `ci-a27eabd` | `SARKARI-20261113-114128-7206` | **staged** (11:47), app SHA `a0b954e9…` |

Doosra deploy zaroori tha kyunki pehle build ko **live probe** me ek bug mila
(B31, neeche). App us waqt band tha, isliye pehla build seedha install hua;
uske baad user ne app khola, aur doosra build stage ho gaya.

**Live probe (staged daemon, port 7879, alag data dir):**

```text
HEALTHZ: ok version=go-7a81d8959fe3dfa6
PROBE:   container=mov,mp4,… dur=197.78 asr=395562 issues=(none)
LAYOUT:  grid=3x3 samples=12 cells=9 watermark='' facecam='top-left' motion0=0.0151
LEXICON: GET 7 defaults (RAG | LLM | ChatGPT | API | vector database | context window | hybrid search)
```

`motion0=0.0151` hi B31 ka proof hai: pehle wahi file `8.7258` de rahi thi.

**Gates jo deploy se pehle chale:**

```text
cd go       : gofmt -l . (clean) · go vet ./... (clean) · go test ./... (12 packages ok)
Clipchamp   : svelte-check 0 errors 0 warnings · prettier clean · npm test 156/156 · vite build ok
```

**Doctor (staged mode, 11:48):**

```text
[ok] build.json Marker: PRESENT (mode: staged, buildId: ci-a27eabd)
[*]  Staged Update (.new.exe): WAITING for user to click Update
[ok] t9cloud Daemon: RUNNING on localhost:7878 (Version: go-f06eaeaf4389881c)
```

Doctor ka `[x] Marker hash does not match the installed exe!` **staged mode me
expected hai**: marker naye (staged) build ka hash rakhta hai, jabki live exe
purana build hai. Update click ke baad `normalize_installed_marker()` marker ko
`mode: installed` karta hai aur dono hash match karte hain.

**Us waqt machine par kya live tha (doosre agent ka kaam):** app `ci-87aab36`
(`opencode/beam-free`, work order `SARKARI-20261113-113826-E5F2`), daemon
`go-f06eaeaf4389881c`. Mera build uske **upar** stage hua hai, uski jagah nahi
li — isliye Update click ke baad app + daemon dono `ci-a27eabd` par chale
jaayenge.

### B31. Layout ka motion 0..1 nahi tha (live probe ne pakda)

| | |
| --- | --- |
| Kahan | `go/internal/mediaprobe/mediaprobe.go` (`AnalyzeFrames`) |
| Kya | `g.Motion[c]` per-cell **sum** tha, divide sirf frame-pair count se hota tha — pixel count se nahi. 32×18 cell = 576 px, isliye live file `8.7` deti thi jahan contract `0..1` kehta hai |
| Asar | Ratio-based decisions (watermark/face-cam vs median) bach gaye, par frozen-video guard (`medianMotion < 0.008`) asli file par kabhi fire hi nahi hota, aur API ka 0..1 promise jhooth tha |
| Fix | `cellPairCounts[c]` — har cell ke pixel-pairs se divide; `TestAnalyzeFramesMotionIsAFraction` 0..1 range pin karta hai |
| Proof | Wahi live file: pehle `8.7258`, ab `0.0151` |

Ye bug **sirf live probe se mila** — Go tests synthetic frames par ratio check
karte the, isliye green the. Isi liye P9 me probe ka number likha hai, sirf
"tests pass" nahi.

### Housekeeping (isse alag commit)

`8e3ae63` — `UsageDialog.svelte` me do long lines prettier se wrap ki. Wo file
`39b3426` me bina format ke aayi thi aur `npm run lint` (verify:fast ka pehla
gate, aur `ci.yml` ka) **main par red** tha. Sirf whitespace, koi markup/text
nahi badla.

---

## P10. Follow-up — transcript panel fix + range transcription (live)

Do cheezein user ne live app me pakdi, dono fix hui aur install ho gayi.

### B32. Transcript row ka badge agli row par paint ho raha tha

| | |
| --- | --- |
| Kahan | `Clipchamp_Bunny/src/lib/components/cut/TranscriptPanel.svelte` |
| Kya | Row fixed `46px` thi, par text 2-line clamp (16+16) + language chip (13) = 45+ tha. Chip `clamp` ke baad block tha, isliye wo row se bahar nikal kar **agle row ke upar** paint hota tha |
| Kab aaya | `9145bf0` (cases 11–20, language pin) — chip us waqt add hua, row height us waqt nahi badli |
| Fix | Saare chips (flag, tag, `×N`, `2 VOICES`, `RETAKE?`, language) ek `flex-nowrap` row me, `overflow-hidden`; `ROW_H` 46 → 60. Virtual list ek hi constant use karti hai, isliye scroll math same |
| Proof | `svelte-check` 0/0, prettier clean, 156/156 tests, live deploy `ci-13d07e4` |

### Naya: "Sirf ye hissa" — range transcription

Pehle 45-minute file me sirf 2 minute ka transcript khareedne ka koi raasta
nahi tha (poora file, ya ek-ek chunk order me). Ab:

- `spansInRange(plan, from, to)` (pure, tested) pending chunks chunta hai jo
  range ko touch karte hain — half-open overlap, isliye boundary chunk do baar
  nahi khareedta.
- `project.transcribeRange(from, to)` wahi chunks `transcribeSpan` se bhejta
  hai. Boundary chunk ke bahar wale words **rakhe jaate hain**: plan poore chunk
  ko done likhta hai, aur text phenk dena agli baar silence jaisa dikhta.
- Autocorrect + AI flags poore plan ke complete hone par hi chalte hain, waise
  hi jaise "Agla chunk" path me.
- UI: `RangeTranscribe.svelte` — khaali panel me button ke neeche, aur partial
  plan ke footer me collapse hua.

| Fact | Value |
| --- | --- |
| Commit | `d54e209001a3ce4dccd02cb5631fbfc4028b6626` |
| Build | `ci-d54e209` · CI run https://github.com/engrtarun/T9EditorLIT/actions/runs/43379960994 |
| App SHA-256 | `f62950be8489337f080a040ff83e6feae3c50be55bcec3db7ba3df308c0faa75` |
| Work order | `SARKARI-20261113-120914-676F` · mode **live** |
| Daemon | `go-7a81d8959fe3dfa6` (pehle se running, is deploy me app-only) |
| Gates | svelte-check 0/0 · prettier clean · 157/157 tests |

Doctor: marker hash = installed exe hash, koi staged file nahi.

**— deepseek** (opencode / deepseek-v4.1-flash-free) · 2026-11-13

## P11. Follow-up — extra clip ka transcript nahi hota, aur main source ka "Regenerate" (live)

User ne nayi video import ki, ek extra clip add kiya, aur poocha: is clip ka
transcript generate/regenerate kahan hai? Do alag cheezein thin, dono ka jawab
ab UI me likha hua hai.

### B33. Extra clip ke liye transcript ka button hi nahi tha — aur hona bhi nahi chahiye

| | |
| --- | --- |
| Kahan | `Clipchamp_Bunny/src/lib/components/cut/TranscriptPanel.svelte` |
| Kya | Preview kisi extra clip par ho to panel wahi purana transcript dikhata tha (ya khaali), bina ye bataye ki clip ka apna transcript kabhi nahi hoga |
| Kyun design hai | Cut pipeline `project.sourcePath` par chalti hai — transcript, cut map, phantom cut, export sab ek hi file ke around hain. Doosri video ko weave karne ke liye multi-source renderer chahiye, jo abhi nahi hai |
| Fix | `project.activeClip` par ek **EXTRA CLIP** banner: alag media hai, transcript sirf main source ka hota hai, ise trim/split se kaato; kisi bhi transcript line par click karne se preview main source par wapas aa jata hai |
| Jhooth kyun nahi | Generate button dikhaya hota to wo aisa text promise karta jise renderer kahin rakh hi nahi sakta |

### Naya: main source ka "Regenerate"

`project.regenerateTranscript()` — pehla aur akela action jo words **delete**
karta hai, isliye confirm karta hai aur naam leta hai ki kya ja raha hai:

- `saveSegments(db, source, [])` — empty diff-save ka matlab "ye saari rows
  hain", isliye `transcript.rs` us source ki har stored line hata deta hai.
- `chunkCache = null` — pichla run har WAV pay karne ke baad delete karta tha,
  isliye fresh plan source ko dobara split karega, mara hua path nahi bhejega.
- `lines`, `selectedIds`, gaps, plan, `noSpeech`, `music`, `audioProfile` reset,
  phir `startTranscript(false)` chunk 1 se.
- Cut/keep marks jaate hain: purane marks naye text par lagana galat hota —
  "cut" us sentence ko point karta jo user ne kabhi dekha hi nahi.

| Fact | Value |
| --- | --- |
| Commit | `24b27cfb05bebc5aac5bd0c6e122eae4abd2bacd` |
| Build | `ci-24b27cf` → CI run https://github.com/engrtarun/T9EditorLIT/actions/runs/43383075391 |
| App SHA-256 | `b12c571e0dc95043326da4049c85e98a9bf97d03868b4a4dd5e53bea287aeba7` |
| Work order | `SARKARI-20261113-123426-0453` → mode **live** |
| Daemon | `go-7a81d8959fe3dfa6` (app-only deploy, daemon untouched) |
| Gates | svelte-check 0/0 → prettier clean → 157/157 tests |

Deploy ke waqt app band thi, isliye binary seedha install hui (`mode: live`) —
koi staged `.new.exe` nahi, Update click ki zaroorat nahi.

**— deepseek** (opencode / deepseek-v4.1-flash-free) · 2026-11-13

---

**— deepseek** (opencode / deepseek-v4.1-flash-free) · 2026-11-13
*Upstream: GLM 5.3 (40 cases) + MiMO V2.6 (Part 2) + deepseek Part 3
(cases 11–20) — teeno untouched. Ye part sirf append hai.*

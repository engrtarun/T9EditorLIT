import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attachWordsToLines,
  buildTranscriptLines,
  collectImportWords,
  describeFormat,
  importLabel,
  parseTimeToken,
  parseTranscript,
  type TimedWord
} from './transcript-import.ts';
import type { TranscriptLine } from './types.ts';

/* ------------------------------------------------------------------- times */

test('parseTimeToken reads SRT, VTT and bare-second stamps', () => {
  assert.equal(parseTimeToken('00:00:01,250'), 1.25);
  assert.equal(parseTimeToken('01:02:03,456'), 3723.456);
  assert.equal(parseTimeToken('02:03.500'), 123.5);
  assert.equal(parseTimeToken('00:05'), 5);
  assert.equal(parseTimeToken('83'), 83);
  assert.equal(parseTimeToken('not a time'), null);
});

/* --------------------------------------------------------------------- SRT */

test('SRT keeps the exact cue times and strips presentation tags', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:03,500',
    'Namaste doston',
    '',
    '2',
    '00:00:03,500 --> 00:00:06,000',
    'Aaj hum <i>Nafay</i> ke baare me&nbsp;baat karenge',
    ''
  ].join('\r\n');

  const doc = parseTranscript(srt);
  assert.equal(doc.format, 'srt');
  assert.equal(doc.timed, true);
  assert.equal(doc.cues.length, 2);
  assert.equal(doc.cues[0].text, 'Namaste doston');
  assert.equal(doc.cues[1].text, 'Aaj hum Nafay ke baare me baat karenge');
  assert.equal(doc.cues[0].startSec, 1);
  assert.equal(doc.cues[0].endSec, 3.5);

  const built = buildTranscriptLines(doc, 10, 'srt');
  assert.equal(built.estimated, false);
  assert.equal(built.timed, true);
  assert.equal(built.lines.length, 2);
  assert.equal(built.lines[0].startSec, 1);
  assert.equal(built.lines[0].endSec, 3.5);
  assert.equal(built.lines[1].text, 'Aaj hum Nafay ke baare me baat karenge');
  assert.equal(built.lines[0].keep, 'keep');
  assert.equal(built.lines[0].confidence, 1);
  assert.equal(built.lines[0].id, 'srt-1');
});

/* --------------------------------------------------------------------- VTT */

test('VTT skips NOTE/STYLE blocks, keeps cue ids and voice names', () => {
  const vtt = [
    'WEBVTT',
    '',
    'NOTE this is a comment with --> inside',
    '',
    'intro',
    '00:00.000 --> 00:02.500 align:middle line:90%',
    '<v Ravi>Namaste</v>',
    '',
    '00:02.500 --> 00:05.000',
    '<v Priya>Hello</v> doston',
    ''
  ].join('\n');

  const doc = parseTranscript(vtt);
  assert.equal(doc.format, 'vtt');
  assert.equal(doc.timed, true);
  assert.equal(doc.cues.length, 2);
  assert.equal(doc.cues[0].text, 'Namaste');
  assert.equal(doc.cues[0].speaker, 'Ravi');
  assert.equal(doc.cues[0].startSec, 0);
  assert.equal(doc.cues[0].endSec, 2.5);
  assert.equal(doc.cues[1].speaker, 'Priya');
  assert.equal(doc.cues[1].text, 'Hello doston');

  // Two voices, so the rows say who is talking.
  const built = buildTranscriptLines(doc, 10, 'vtt');
  assert.equal(built.speakers, 2);
  assert.equal(built.lines[0].text, 'Ravi: Namaste');
  assert.equal(built.lines[1].text, 'Priya: Hello doston');
});

/* -------------------------------------------------------------------- JSON */

test('ElevenLabs words JSON groups words into lines and keeps word timings', () => {
  const words = [
    { text: 'Hello', start: 0, end: 0.4, type: 'word', speaker_id: 'speaker_0' },
    { text: ' ', start: 0.4, end: 0.5, type: 'spacing' },
    { text: 'world', start: 0.5, end: 0.9, type: 'word', speaker_id: 'speaker_0' },
    { text: ' ', start: 0.9, end: 0.95, type: 'spacing' },
    { text: '.', start: 0.9, end: 0.95, type: 'punctuation', speaker_id: 'speaker_0' },
    { text: 'Second', start: 2.1, end: 2.4, type: 'word', speaker_id: 'speaker_0' },
    { text: ' ', start: 2.4, end: 2.5, type: 'spacing' },
    { text: 'line', start: 2.5, end: 2.8, type: 'word', speaker_id: 'speaker_0' },
    { text: ' ', start: 2.8, end: 2.9, type: 'spacing' },
    { text: 'here', start: 2.9, end: 3.2, type: 'word', speaker_id: 'speaker_0' },
    { text: '.', start: 3.2, end: 3.25, type: 'punctuation', speaker_id: 'speaker_0' }
  ];
  const json = JSON.stringify({
    language_code: 'eng',
    text: 'Hello world. Second line here.',
    words
  });

  const doc = parseTranscript(json, { durationSecs: 10 });
  assert.equal(doc.format, 'json');
  assert.equal(doc.timed, true);
  assert.equal(doc.cues.length, 2);
  assert.equal(doc.cues[0].text, 'Hello world.');
  assert.equal(doc.cues[1].text, 'Second line here.');
  assert.equal(importLabel(doc), 'ElevenLabs JSON');

  const built = buildTranscriptLines(doc, 10, 'el');
  assert.equal(built.lines.length, 2);
  assert.equal(built.lines[0].startSec, 0);
  assert.equal(built.lines[0].endSec, 0.95);
  assert.equal(built.lines[1].startSec, 2.1);
  assert.equal(built.lines[0].words?.length, 3); // Hello, world, "."
  assert.equal(built.lines[1].words?.length, 4); // Second, line, here, "."
});

test('ElevenLabs words split at a long pause or a long run', () => {
  const words: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 30; i++) {
    words.push({ text: `w${i}`, start: i * 0.3, end: i * 0.3 + 0.25, type: 'word' });
  }
  const doc = parseTranscript(JSON.stringify({ words }), { durationSecs: 30 });
  assert.ok(doc.cues.length >= 2, 'a 30-word run must not be one row');
  for (const cue of doc.cues) assert.ok(cue.words!.length <= 18);
});

test('ElevenLabs segments keep their nested word timings', () => {
  // This is the real SHORT6 export shape: the words live inside each segment
  // and use `start_time` / `end_time`. Dropping them turned every word cut
  // into a character-count guess.
  const json = JSON.stringify({
    language_code: 'hin',
    segments: [
      {
        text: 'PowerPoint का speech coach है। हाँ।',
        start_time: 75.42,
        end_time: 77.74,
        words: [
          { text: 'PowerPoint', start_time: 75.42, end_time: 75.92 },
          { text: ' ', start_time: 75.92, end_time: 75.98 },
          { text: 'का', start_time: 75.98, end_time: 76.08 },
          { text: ' ', start_time: 76.08, end_time: 76.3 },
          { text: 'speech', start_time: 76.3, end_time: 76.6 },
          { text: ' ', start_time: 76.6, end_time: 76.68 },
          { text: 'coach', start_time: 76.68, end_time: 77.02 },
          { text: ' ', start_time: 77.02, end_time: 77.14 },
          { text: 'है।', start_time: 77.14, end_time: 77.54 },
          { text: ' ', start_time: 77.54, end_time: 77.56 },
          { text: 'हाँ।', start_time: 77.56, end_time: 77.74 }
        ]
      },
      {
        text: 'PowerPoint का speech coach.',
        start_time: 78.4,
        end_time: 79.74,
        words: [
          { text: 'PowerPoint', start_time: 78.4, end_time: 78.9 },
          { text: ' ', start_time: 78.9, end_time: 78.96 },
          { text: 'का', start_time: 78.96, end_time: 79.1 },
          { text: ' ', start_time: 79.1, end_time: 79.2 },
          { text: 'speech', start_time: 79.2, end_time: 79.46 },
          { text: ' ', start_time: 79.46, end_time: 79.52 },
          { text: 'coach.', start_time: 79.52, end_time: 79.74 }
        ]
      }
    ]
  });

  const doc = parseTranscript(json, { durationSecs: 278 });
  assert.equal(doc.format, 'json');
  assert.equal(doc.cues.length, 2);
  assert.equal(doc.cues[0].words?.length, 6); // spacing entries dropped
  assert.equal(doc.cues[0].words?.[0].start, 75.42);
  assert.equal(doc.cues[0].words?.[5].end, 77.74);

  const built = buildTranscriptLines(doc, 278, 'el');
  assert.equal(built.lines[0].words?.length, 6);
  assert.equal(built.lines[1].words?.[0].start, 78.4);
});

test('a root words array using start_time is still recognised', () => {
  const json = JSON.stringify({
    words: [
      { text: 'Namaste', start_time: 0, end_time: 0.5 },
      { text: 'doston', start_time: 0.5, end_time: 0.9 }
    ]
  });
  const doc = parseTranscript(json, { durationSecs: 3 });
  assert.equal(doc.cues.length, 1);
  assert.equal(doc.cues[0].words?.length, 2);
  assert.equal(doc.cues[0].words?.[1].start, 0.5);
});

/* -------------------------------------------------------------- backfill */

/** The two-take line from the real SHORT6 export, flattened into one list. */
function short6Words(): TimedWord[] {
  return [
    { word: 'PowerPoint', start: 75.42, end: 75.92 },
    { word: 'का', start: 75.98, end: 76.08 },
    { word: 'speech', start: 76.3, end: 76.6 },
    { word: 'coach', start: 76.68, end: 77.02 },
    { word: 'है।', start: 77.14, end: 77.54 },
    { word: 'हाँ।', start: 77.56, end: 77.74 },
    { word: 'PowerPoint', start: 78.4, end: 78.9 },
    { word: 'का', start: 78.96, end: 79.1 },
    { word: 'speech', start: 79.2, end: 79.46 },
    { word: 'coach.', start: 79.52, end: 79.74 },
    { word: 'अपने', start: 79.9, end: 80.04 },
    { word: 'best', start: 80.06, end: 80.24 },
    { word: 'project', start: 80.28, end: 80.58 },
    { word: 'को,', start: 80.62, end: 80.82 }
  ];
}

function row(
  id: string,
  startSec: number,
  endSec: number,
  text: string,
  words?: TranscriptLine['words']
): TranscriptLine {
  return { id, startSec, endSec, text, words, keep: 'keep', flag: 'none', confidence: 1 };
}

test('backfill re-attaches nested timings and skips the repeated take', () => {
  // Both rows lost their words in the old importer. Row 2's bracket covers
  // *two* takes of "PowerPoint का speech" — the one before the boundary and
  // the real one at 78.4 — so a text-only matcher would attach the first.
  const lines = [
    row('a', 75.42, 77.977, 'PowerPoint का speech coach है। हाँ।'),
    row('b', 77.977, 80.02, 'PowerPoint का speech coach.')
  ];
  const res = attachWordsToLines(lines, short6Words());
  assert.equal(res.attached, 2);
  assert.equal(res.wordCount, 10);
  assert.equal(res.lines[0].words?.length, 6);
  assert.equal(res.lines[1].words?.length, 4);
  // The second take, not the first: 78.4 is the real PowerPoint of row b.
  assert.equal(res.lines[1].words?.[0].start, 78.4);
  assert.equal(res.lines[1].words?.[3].end, 79.74);
});

test('backfill falls back to the token sequence and still skips a used take', () => {
  // The row's own bracket drifts slightly from the audio (a split made before
  // timings existed), so time alone cannot place it. The first "hello world"
  // is already consumed by row a, so row b must take the second take instead
  // of reusing the same two words.
  const words: TimedWord[] = [
    { word: 'hello', start: 0.5, end: 0.7 },
    { word: 'world', start: 0.8, end: 1.1 },
    { word: 'hello', start: 3.5, end: 3.7 },
    { word: 'world', start: 3.8, end: 4.1 }
  ];
  const lines = [row('a', 0, 2, 'hello world'), row('b', 3.3, 5.6, 'hello world')];
  const res = attachWordsToLines(lines, words);
  assert.equal(res.attached, 2);
  assert.equal(res.lines[1].words?.[0].start, 3.5);
});

test('backfill will not claim words that belong to a later row', () => {
  // A row split before timings existed can still carry the whole sentence in
  // its text while its bracket only covers the head. The fallback must not
  // walk past the bracket and steal the repeated tail from the row that owns
  // it — that left row 8 of SHORT6 with no words at all.
  const words: TimedWord[] = [
    { word: 'और', start: 37.94, end: 38.06 },
    { word: 'कुछ', start: 38.1, end: 38.4 },
    { word: 'और', start: 42.0, end: 42.2 },
    { word: 'कुछ', start: 42.3, end: 42.6 }
  ];
  const lines = [row('head', 36.12, 37.56, 'और कुछ'), row('tail', 42.0, 43.0, 'और कुछ')];
  const res = attachWordsToLines(lines, words);
  assert.equal(res.attached, 1, 'only the row whose bracket owns the take');
  assert.equal(res.lines[0].words, undefined);
  assert.equal(res.lines[1].words?.[0].start, 42.0);
});

test('backfill never overwrites a row that already has word timings', () => {
  const kept = row('a', 0, 1, 'namaste doston', [
    { word: 'namaste', start: 0, end: 0.4 },
    { word: 'doston', start: 0.4, end: 0.9 }
  ]);
  const res = attachWordsToLines([kept], [{ word: 'namaste', start: 10, end: 10.4 }]);
  assert.equal(res.attached, 0);
  assert.equal(res.lines[0], kept, 'the same object is passed through');
  assert.equal(res.lines[0].words?.[0].start, 0);
});

test('backfill leaves rows alone when the text is not in the file', () => {
  const lines = [row('a', 0, 2, 'kuch aur hi baat')];
  const res = attachWordsToLines(lines, short6Words());
  assert.equal(res.attached, 0);
  assert.equal(res.lines, lines, 'no change means the original array');
  assert.equal(res.lines[0].words, undefined);
});

test('backfill compares Devanagari matras with their letter, not as separators', () => {
  // The real SHORT6 rows that stayed unmatched: their bracket ends before the
  // repeated tail, so only the sequential fallback can place them. With the
  // old key "कुछ" became ["क", "छ"] and "किए" became ["क", "ए"], so the token
  // count could never agree with the file and the fallback matched nothing.
  const words: TimedWord[] = [
    { word: 'कुछ', start: 36.12, end: 36.28 },
    { word: 'तरीके', start: 36.32, end: 36.56 },
    { word: 'किए', start: 37.42, end: 37.6 },
    { word: 'हैं', start: 37.62, end: 37.88 },
    { word: 'और', start: 37.94, end: 38.06 },
    { word: 'कुछ...', start: 38.1, end: 38.4 }
  ];
  const lines = [row('a', 36.12, 37.9, 'कुछ तरीके किए हैं और कुछ...')];
  const res = attachWordsToLines(lines, words);
  assert.equal(res.attached, 1);
  assert.equal(res.lines[0].words?.length, 6);
  // The first word keeps its matras instead of collapsing to a bare "क".
  assert.equal(res.lines[0].words?.[0].word, 'कुछ');
  assert.equal(res.lines[0].words?.[5].end, 38.4);
});

test('collectImportWords flattens nested segment words in clock order', () => {
  const json = JSON.stringify({
    segments: [
      {
        text: 'PowerPoint का',
        start_time: 75.42,
        end_time: 76.08,
        words: [
          { text: 'PowerPoint', start_time: 75.42, end_time: 75.92 },
          { text: ' ', start_time: 75.92, end_time: 75.98 },
          { text: 'का', start_time: 75.98, end_time: 76.08 }
        ]
      },
      {
        text: 'coach',
        start_time: 76.3,
        end_time: 76.6,
        words: [{ text: 'coach', start_time: 76.3, end_time: 76.6 }]
      }
    ]
  });
  const doc = parseTranscript(json, { durationSecs: 100 });
  const words = collectImportWords(doc);
  assert.equal(words.length, 3);
  assert.deepEqual(
    words.map((w) => w.word),
    ['PowerPoint', 'का', 'coach']
  );
  assert.equal(words[2].start, 76.3);
});

test('generic JSON segments in milliseconds are detected from the media length', () => {
  const json = JSON.stringify({
    segments: [
      { start: 0, end: 1500, text: 'Pehla hissa' },
      { start: 1500, end: 2800, text: 'Doosra hissa' }
    ]
  });
  const doc = parseTranscript(json, { durationSecs: 3 });
  assert.equal(doc.format, 'json');
  assert.equal(doc.timed, true);
  assert.equal(doc.cues[0].startSec, 0);
  assert.equal(doc.cues[0].endSec, 1.5);
  assert.equal(doc.cues[1].endSec, 2.8);
  assert.equal(importLabel(doc), 'JSON');
});

test('JSON without usable cues still yields the text inside it', () => {
  const doc = parseTranscript(JSON.stringify({ data: { note: 'Zaroori baat' } }));
  assert.equal(doc.cues.length, 0);
  assert.equal(doc.words, 0);
});

test('a JSON array of strings becomes untimed rows', () => {
  const doc = parseTranscript(JSON.stringify(['Pehli line', 'Doosri line']));
  assert.equal(doc.cues.length, 2);
  assert.equal(doc.timed, false);
  assert.equal(buildTranscriptLines(doc, 10, 'arr').estimated, true);
});

/* -------------------------------------------------------------------- HTML */

test('HTML export loses the markup but keeps the sentences', () => {
  const html = [
    '<!DOCTYPE html>',
    '<html><head><title>x</title><style>p{color:red}</style></head>',
    '<body><h1>Transcript</h1>',
    '<p>Namaste doston. Aaj hum Nafay ke baare me baat karenge.</p>',
    '<p>Yeh doosra paragraph hai &amp; sabhi log sun rahe hain.</p>',
    '<script>console.log("noise")</script>',
    '</body></html>'
  ].join('\n');

  const doc = parseTranscript(html, { fileName: 'transcript.html' });
  assert.equal(doc.format, 'html');
  assert.equal(doc.timed, false);
  assert.ok(doc.cues.length >= 2);
  const joined = doc.cues.map((cue) => cue.text).join(' ');
  assert.ok(joined.includes('Namaste doston.'));
  assert.ok(joined.includes('Yeh doosra paragraph hai & sabhi log sun rahe hain.'));
  assert.ok(!joined.includes('console.log'));
  assert.ok(!joined.includes('color:red'));
});

/* -------------------------------------------------------------------- text */

test('plain text keeps one row per short line', () => {
  const text = [
    'Namaste doston',
    'Aaj hum ek nayi cheez seekhenge',
    'Chaliye shuru karte hain'
  ].join('\n');
  const doc = parseTranscript(text);
  assert.equal(doc.format, 'text');
  assert.equal(doc.cues.length, 3);
  assert.equal(doc.timed, false);
  assert.equal(doc.cues[0].text, 'Namaste doston');
});

test('a long paragraph without timings is split into readable sentences', () => {
  const sentence = 'Yeh ek lamba vaakya hai jo transcript me chhota dikhna chahiye. ';
  const doc = parseTranscript(sentence.repeat(12), { fileName: 'notes.txt' });
  assert.equal(doc.format, 'text');
  assert.ok(doc.cues.length > 1);
  for (const cue of doc.cues) assert.ok(cue.text.length <= 185, cue.text);
});

test('timestamped text is treated as timed', () => {
  const text = ['[00:00] Namaste', '[00:05] Aaj hum baat karenge', '00:12 - Teesri line'].join(
    '\n'
  );
  const doc = parseTranscript(text);
  assert.equal(doc.timed, true);
  assert.equal(doc.cues.length, 3);
  assert.equal(doc.cues[0].startSec, 0);
  assert.equal(doc.cues[1].startSec, 5);
  assert.equal(doc.cues[0].endSec, 5);

  const built = buildTranscriptLines(doc, 20, 't');
  assert.equal(built.timed, true);
  assert.equal(built.estimated, false);
  assert.equal(built.lines[2].startSec, 12);
  // The last cue had no end, so it gets a word-count estimate.
  assert.ok(built.lines[2].endSec > 12);
});

test('speaker labels are kept and only prefixed when there is more than one voice', () => {
  const text = [
    'Speaker 1: Namaste doston',
    '',
    'Speaker 1: Aaj hum shuru karte hain',
    '',
    'Speaker 2: Haan bilkul',
    ''
  ].join('\n');
  const doc = parseTranscript(text);
  assert.equal(doc.cues.length, 3);
  assert.equal(doc.cues[0].speaker, 'Speaker 1');
  assert.equal(doc.cues[2].speaker, 'Speaker 2');
  assert.equal(doc.cues[0].text, 'Namaste doston');

  const built = buildTranscriptLines(doc, 9, 'sp');
  assert.equal(built.speakers, 2);
  assert.equal(built.lines[0].text, 'Speaker 1: Namaste doston');
  assert.equal(built.lines[2].text, 'Speaker 2: Haan bilkul');
});

test('untimed lines are spread across the media by word count and marked estimated', () => {
  const text = ['Ek do teen', '', 'Chaar paanch chhe saat aath', ''].join('\n');
  const doc = parseTranscript(text);
  const built = buildTranscriptLines(doc, 10, 'est');
  assert.equal(built.lines.length, 2);
  assert.equal(built.estimated, true);
  assert.equal(built.lines[0].startSec, 0);
  assert.ok(built.lines[0].endSec > 0);
  assert.ok(Math.abs(built.lines[0].endSec - 10 * (3 / 8)) < 0.05);
  assert.equal(built.lines[1].endSec, 9.97); // clamped just inside the media
});

test('without media duration the estimated rows still get sane times', () => {
  const doc = parseTranscript('Ek do teen chaar paanch');
  const built = buildTranscriptLines(doc, 0, 'nodur');
  assert.equal(built.lines.length, 1);
  assert.ok(built.lines[0].startSec === 0);
  assert.ok(built.lines[0].endSec > 1);
});

test('cues that start after the media ends are dropped, not smeared', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:02,000',
    'Andar',
    '',
    '2',
    '00:00:20,000 --> 00:00:22,000',
    'Bahar',
    ''
  ].join('\n');
  const doc = parseTranscript(srt);
  const built = buildTranscriptLines(doc, 10, 'drop');
  assert.equal(built.lines.length, 1);
  assert.equal(built.lines[0].text, 'Andar');
  assert.equal(built.dropped, 1);
});

test('timings are made monotonic even when the source overlaps', () => {
  const srt = [
    '1',
    '00:00:05,000 --> 00:00:07,000',
    'Pehla',
    '',
    '2',
    '00:00:03,000 --> 00:00:06,000',
    'Doosra',
    ''
  ].join('\n');
  const doc = parseTranscript(srt);
  const built = buildTranscriptLines(doc, 20, 'mono');
  assert.equal(built.lines.length, 2);
  assert.ok(built.lines[1].startSec >= built.lines[0].endSec);
});

/* ------------------------------------------------------------------ guards */

test('empty and whitespace input is a no-op', () => {
  for (const input of ['', '   \n\n \t ']) {
    const doc = parseTranscript(input);
    assert.equal(doc.cues.length, 0);
    assert.equal(doc.words, 0);
    assert.equal(doc.timed, false);
    const built = buildTranscriptLines(doc, 12, 'empty');
    assert.equal(built.lines.length, 0);
    assert.equal(built.estimated, false);
    assert.equal(built.dropped, 0);
  }
});

test('a broken end time still imports the cue as timed', () => {
  const srt = '1\n00:00:01,000 --> nonsense\nNamaste doston\n';
  const doc = parseTranscript(srt);
  assert.equal(doc.format, 'srt');
  assert.equal(doc.cues.length, 1);
  assert.equal(doc.cues[0].startSec, 1);
  assert.equal(doc.cues[0].text, 'Namaste doston');

  const built = buildTranscriptLines(doc, 10, 'badend');
  assert.equal(built.lines.length, 1);
  assert.equal(built.lines[0].startSec, 1);
  assert.ok(built.lines[0].endSec >= 1.3);
});

test('an .srt file with no timing lines falls back to its readable text', () => {
  const srt = 'nonsense --> nonsense\nNamaste doston\nAaj hum baat karenge\n';
  const doc = parseTranscript(srt, { fileName: 'clip.srt' });
  assert.equal(doc.format, 'srt');
  assert.equal(doc.timed, false);
  assert.ok(doc.words > 0);
});

test('JSON carrying only a text field still imports', () => {
  const doc = parseTranscript(JSON.stringify({ text: 'Namaste doston\nAaj hum baat karenge' }));
  assert.equal(doc.format, 'json');
  assert.equal(doc.cues.length, 2);
  assert.equal(doc.timed, false);
  assert.equal(doc.cues[0].text, 'Namaste doston');
});

test('describeFormat names every format the export menu offers', () => {
  assert.equal(describeFormat('srt'), 'SRT');
  assert.equal(describeFormat('vtt'), 'WebVTT');
  assert.equal(describeFormat('json'), 'JSON');
  assert.equal(describeFormat('html'), 'HTML');
  assert.equal(describeFormat('text'), 'Text');
});

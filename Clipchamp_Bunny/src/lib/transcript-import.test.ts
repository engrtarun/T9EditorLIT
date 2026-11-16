import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTranscriptLines,
  describeFormat,
  importLabel,
  parseTimeToken,
  parseTranscript
} from './transcript-import.ts';

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

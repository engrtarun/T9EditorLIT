/**
 * The word under the playhead, split out of one transcript line.
 *
 * Used by BOTH the transcript row and the preview caption so the same word is
 * highlighted in the same way on both surfaces. The pieces always join back
 * to `line.text` byte-for-byte — word selection reads character offsets from
 * these DOM nodes, so a single changed space would break a cut gesture.
 */

import { tokenizeLine } from './word-cut';
import type { TranscriptLine } from './types';

export interface SpokenPart {
  text: string;
  spoken: boolean;
}

export function spokenPartsFor(
  line: TranscriptLine,
  currentTime: number,
  activeLineId: string | null
): SpokenPart[] {
  if (line.id !== activeLineId) return [{ text: line.text, spoken: false }];
  const tokens = tokenizeLine(line.text, line.words, line.startSec, line.endSec);
  if (!tokens.length) return [{ text: line.text, spoken: false }];

  const out: SpokenPart[] = [];
  let at = 0;
  for (const tok of tokens) {
    if (tok.from > at) out.push({ text: line.text.slice(at, tok.from), spoken: false });
    out.push({ text: tok.text, spoken: currentTime >= tok.startSec && currentTime < tok.endSec });
    at = tok.to;
  }
  if (at < line.text.length) out.push({ text: line.text.slice(at), spoken: false });
  return out;
}

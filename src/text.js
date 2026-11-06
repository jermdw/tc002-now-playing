import crypto from 'node:crypto';

const PUNCTUATION_MAP = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  ' ': ' ',
};

export function sanitizeMatrixText(input, { asciiTransliterate = true } = {}) {
  if (!input) return '';
  let text = String(input);
  for (const [src, dst] of Object.entries(PUNCTUATION_MAP)) {
    text = text.replaceAll(src, dst);
  }
  if (asciiTransliterate) {
    text = text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss')
      .replace(/Æ/g, 'AE')
      .replace(/æ/g, 'ae')
      .replace(/Ø/g, 'O')
      .replace(/ø/g, 'o');
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The Berry script appends the ID to its poll URL without encoding it, so IDs must be URL-safe.
 * The source prefix stops the art-delta check matching across a source switch.
 */
export function safeTrackId(sourceName, rawId) {
  if (!rawId) return '';
  const hash = crypto.createHash('sha1').update(String(rawId)).digest('hex').slice(0, 16);
  return `${sourceName}_${hash}`;
}

'use strict';

function splitWsJsonRecord(text) {
  let payload = text.trimStart();
  const legacy = /^([456]):(?:\d+\+?)?:(?:\/[^:\r\n]*)?:/.exec(payload);
  const kind = legacy?.[1];
  let envelope = legacy?.[0] || /^4[23](?:\/[^,\r\n]*,)?\d*(?=\[)/.exec(payload)?.[0] || '';
  if (kind === '6') {
    const ack = /^\d+\+/.exec(payload.slice(envelope.length));
    if (!ack) return null;
    envelope += ack[0];
  }
  if (envelope) payload = payload.slice(envelope.length).trimStart();
  if (!/^[[{]/.test(payload) || (kind === '5' && !payload.startsWith('{')) ||
      (kind === '6' && !payload.startsWith('['))) return null;
  return { payload, envelope };
}

function decodeWsJsonDisplayEscapes(text) {
  // Consume each escape as a unit so \\uXXXX stays a literal backslash followed by text.
  return text.replace(/\\u([dD][89aAbB][\da-fA-F]{2})\\u([dD][c-fC-F][\da-fA-F]{2})|\\u([\da-fA-F]{4})|\\[\s\S]/g,
    (escape, high, low, single) => {
      if (!high && !single) return escape;
      const character = high
        ? String.fromCharCode(parseInt(high, 16), parseInt(low, 16))
        : String.fromCharCode(parseInt(single, 16));
      // Keep the joiner and variation selectors used in emoji sequences.
      if (character === '\u200d' || character === '\ufe0e' || character === '\ufe0f') return character;
      return character.codePointAt(0) >= 0xa0 &&
        !/[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]/u.test(character) ? character : escape;
    });
}

function wsDisplayText(text) {
  if (!text.includes('\\u')) return text;
  const separator = '\u001e';
  const framed = text.includes(separator);
  const records = framed ? text.split(separator, 18) : [text];
  if (framed && (records.length > 17 || records.pop() !== '')) return text;
  const decoded = [];
  try {
    for (const record of records) {
      const json = splitWsJsonRecord(record);
      if (!json || (framed && !record.trimStart().startsWith('{'))) return text;
      JSON.parse(json.payload);
      const start = record.length - record.trimStart().length + json.envelope.length;
      decoded.push(record.slice(0, start) + decodeWsJsonDisplayEscapes(record.slice(start)));
    }
  } catch (_error) {
    return text;
  }
  return decoded.join(separator) + (framed ? separator : '');
}

function findPayloadHits(text, regex, after) {
  regex.lastIndex = 0;
  const hits = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (!match[0].length) {
      regex.lastIndex += 1;
      continue;
    }
    const end = regex.lastIndex;
    if (end <= after) continue;
    if (hits.length === 100) return { hits, more: true };
    const shownEnd = Math.min(end, match.index + 160);
    hits.push({
      offset: match.index,
      before: text.slice(Math.max(0, match.index - 80), match.index),
      match: text.slice(match.index, shownEnd),
      after: shownEnd === end ? text.slice(end, end + 80) : '',
    });
  }
  return { hits, more: false };
}

// Search the source text off the inspector thread. Only hit flags or
// bounded excerpts come back; never send the source back to the view.
function scanPayload({ data }) {
  const { text, rules, after, webSocketAliases } = data;
  let displayText;
  const results = rules.map(({ source, flags }) => {
    const regex = new RegExp(source, flags);
    if (after === null) return regex.test(text);
    const result = findPayloadHits(text, regex, after);
    if (webSocketAliases && !result.hits.length) {
      if (displayText === undefined) displayText = wsDisplayText(text);
      if (displayText !== text) return findPayloadHits(displayText, regex, 0);
    }
    return result;
  });
  self.postMessage(results);
}

const payloadSearch = Object.freeze({ splitWsJsonRecord, decodeWsJsonDisplayEscapes });
if (typeof module !== 'undefined' && module.exports) module.exports = payloadSearch;
else if (typeof document === 'undefined') self.onmessage = scanPayload;
else globalThis.NetworkPlusPayloadSearch = payloadSearch;

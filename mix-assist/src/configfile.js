// Edição do config.json preservando a formatação do resto do arquivo — módulo PURO.

// Valor JSON em uma linha, com espaços: { "ch": 1, "seen": { "name": "BB" } }
export function inlineJson(v) {
  if (Array.isArray(v)) return `[${v.map(inlineJson).join(', ')}]`;
  if (v && typeof v === 'object') {
    const parts = Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}: ${inlineJson(x)}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  return JSON.stringify(v);
}

// Lista de canais: um canal por linha, como o config.json distribuído.
export function formatChannels(channels, indent = '  ') {
  if (!channels.length) return '[]';
  return `[\n${channels.map((c) => `${indent}  ${inlineJson(c)}`).join(',\n')}\n${indent}]`;
}

// Fim do valor JSON que começa em `start` (objeto, lista, string ou literal),
// respeitando strings (um "]" dentro de um nome não fecha a lista).
function valueEnd(text, start) {
  const open = text[start];
  if (open === '"') {
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') return i + 1;
    }
    return -1;
  }
  if (open !== '[' && open !== '{') {
    const m = /^[^,}\]\s]+/.exec(text.slice(start));
    return m ? start + m[0].length : -1;
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      i = valueEnd(text, i) - 1;
      if (i < 0) return -1;
    } else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Troca o valor de uma chave de primeiro nível do objeto raiz por `valueText`.
// Se a chave não existir, ela é acrescentada no fim do objeto.
export function replaceTopLevel(text, key, valueText) {
  JSON.parse(text); // não mexe em arquivo quebrado
  const keyText = JSON.stringify(key);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const end = valueEnd(text, i);
      if (depth === 1 && text.slice(i, end) === keyText) {
        const colon = text.indexOf(':', end);
        let v = colon + 1;
        while (/\s/.test(text[v])) v++;
        const vEnd = valueEnd(text, v);
        return text.slice(0, v) + valueText + text.slice(vEnd);
      }
      i = end - 1;
    } else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  const close = text.lastIndexOf('}');
  const body = text.slice(0, close).replace(/\s*$/, '');
  const sep = body.endsWith('{') ? '' : ',';
  return `${body}${sep}\n  ${keyText}: ${valueText}\n${text.slice(close)}`;
}

const crypto = require('crypto');

/**
 * Build a system prompt that injects tool definitions into the CLI prompt.
 *
 * IMPORTANT: This prompt must ONLY provide format instructions — no role
 * definitions or personality statements. Adding "你是一个..." would cause
 * personality pollution for character-based agents like 紫苑 (CodeShion).
 *
 * The prompt tells the model what tools are available and what output format
 * to use if it decides to call one. It explicitly allows normal text replies
 * when no tool is needed, so the model's existing persona is preserved.
 */
function buildToolSystemPrompt(tools) {
  if (!tools || tools.length === 0) return '';

  const toolDescriptions = tools.map((tool) => {
    const func = tool.function || tool;
    const name = func.name || tool.name;
    const desc = func.description || tool.description || '';
    const params = func.parameters || func.input_schema || {};
    return {
      name,
      description: desc,
      parameters: params,
    };
  });

  return [
    '[Tool Protocol] 以下工具可供调用：',
    '',
    JSON.stringify(toolDescriptions),
    '',
    '如需调用工具，请仅输出以下格式的 JSON 代码块：',
    '```json',
    '{"tool_calls": [{"name": "工具名称", "arguments": {参数对象}}]}',
    '```',
    '',
    '如不需要调用工具，直接以正常文本回复，不要输出任何 JSON 代码块。',
    '不要在同一个回复中既输出普通文本又输出工具调用 JSON。',
  ].join('\n');
}

/**
 * Extract a balanced JSON object containing "tool_calls" from text.
 *
 * Uses brace-counting to find the outermost `{...}` that is properly
 * balanced and contains the key "tool_calls". This is more robust than
 * a regex approach because nested JSON objects contain inner braces
 * that a lazy regex would incorrectly close on.
 */
function extractBalancedJsonWithToolCalls(text) {
  // Find the first { that could start a JSON object with tool_calls
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;

    // Count braces to find the matching closing brace
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let end = start;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (depth !== 0) continue; // unbalanced braces, skip

    const candidate = text.slice(start, end + 1);

    // Quick check: does this candidate contain "tool_calls"?
    if (!candidate.includes('"tool_calls"')) continue;

    // Try to parse
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && 'tool_calls' in parsed) {
        return {
          json: candidate,
          prefixText: text.slice(0, start).trim(),
          start,
        };
      }
    } catch (_) {
      // Not valid JSON, continue searching
    }
  }

  return null;
}

const XML_TOOL_OPEN_RE =
  /<tool_call(?:\s|>|\/)|<(?:antml:)?function_calls(?:\s|>)|<function(?:\s*=\s*[^\s>]+|\s+[^>]*?\bname\s*=)|<(?:antml:)?invoke\s+[^>]*?\bname\s*=/gi;

const XML_FUNCTION_OPEN_RE =
  /<(?:antml:)?(?:function(?:\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s/>]+))|\s+[^>]*?\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s/>]+))[^>]*?)|invoke\s+[^>]*?\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s/>]+))[^>]*?)\s*(\/)?>/gi;

const XML_PARAM_OPEN_RE =
  /<(?:antml:)?parameter(?:\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))|\s+[^>]*?\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*?)\s*>/gi;

const XML_PARAM_CLOSE_RE = /<\/(?:antml:)?parameter\s*>/gi;

function isIndexInRanges(index, ranges) {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

/**
 * Scan closed non-tool code fences so XML tool-call detection ignores ordinary
 * code examples (e.g. ```js, ```html, ```markdown, or ```xml without tool tags).
 */
function findOrdinaryCodeFenceRanges(text) {
  const ranges = [];
  let cursor = 0;
  while (cursor < text.length) {
    const openIdx = text.indexOf('```', cursor);
    if (openIdx === -1) break;
    const lineEnd = text.indexOf('\n', openIdx + 3);
    if (lineEnd === -1) break;
    const lang = text.slice(openIdx + 3, lineEnd).trim().toLowerCase();
    const closeIdx = text.indexOf('```', lineEnd + 1);
    if (closeIdx === -1) break;

    const body = text.slice(lineEnd + 1, closeIdx);
    const isPossibleToolFence =
      lang === '' ||
      lang === 'json' ||
      (lang === 'xml' && hasXmlToolOpenMarker(body));

    if (!isPossibleToolFence) {
      ranges.push([openIdx, closeIdx + 3]);
    }
    cursor = closeIdx + 3;
  }
  return ranges;
}

function hasXmlToolOpenMarker(text) {
  XML_TOOL_OPEN_RE.lastIndex = 0;
  return XML_TOOL_OPEN_RE.test(text);
}

function buildToolSchemaMap(tools) {
  const map = new Map();
  if (!Array.isArray(tools)) return map;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const func = tool.function || tool;
    const name = func.name || tool.name;
    const parameters = func.parameters || func.input_schema || null;
    if (name && typeof name === 'string') {
      map.set(name, parameters);
    }
  }
  return map;
}

function unwrapXmlParamValue(raw) {
  let value = raw;
  if (value.startsWith('\r\n')) value = value.slice(2);
  else if (value.startsWith('\n')) value = value.slice(1);
  if (value.endsWith('\r\n')) value = value.slice(0, -2);
  else if (value.endsWith('\n')) value = value.slice(0, -1);
  return value;
}

function matchesSchemaType(value, types) {
  for (const t of types) {
    if (t === 'boolean' && typeof value === 'boolean') return true;
    if (t === 'integer' && typeof value === 'number' && Number.isInteger(value)) return true;
    if (t === 'number' && typeof value === 'number' && Number.isFinite(value)) return true;
    if (t === 'array' && Array.isArray(value)) return true;
    if (t === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) return true;
    if (t === 'null' && value === null) return true;
  }
  return false;
}

function coerceXmlParamValue(raw, paramSchema) {
  const value = unwrapXmlParamValue(raw);
  const trimmed = value.trim();

  if (paramSchema && typeof paramSchema === 'object') {
    const rawType = paramSchema.type;
    const types = Array.isArray(rawType) ? rawType : rawType ? [rawType] : [];
    if (types.length === 1 && types[0] === 'string') {
      return value;
    }
    if (types.length > 0 && trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (matchesSchemaType(parsed, types)) {
          return parsed;
        }
      } catch (_) {
        // Keep raw string when the value is not valid JSON for the expected type.
      }
      return value;
    }
  }

  if (!trimmed) return value;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    const isIntLike = !trimmed.includes('.') && !/[eE]/.test(trimmed);
    if (Number.isFinite(num) && (!isIntLike || Number.isSafeInteger(num))) {
      return num;
    }
  }
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      // Fall through to raw string.
    }
  }
  return value;
}

function parseXmlParameters(body, toolSchema) {
  const properties = toolSchema && typeof toolSchema.properties === 'object' ? toolSchema.properties : null;
  const openTags = [];
  XML_PARAM_OPEN_RE.lastIndex = 0;
  let match;
  while ((match = XML_PARAM_OPEN_RE.exec(body)) !== null) {
    const name = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!name) continue;
    openTags.push({
      name: name.trim(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  if (openTags.length === 0) {
    return { args: {}, hasUnclosedParam: false };
  }

  const args = {};
  let hasUnclosedParam = false;
  for (let i = 0; i < openTags.length; i++) {
    const current = openTags[i];
    const searchEnd = i + 1 < openTags.length ? openTags[i + 1].start : body.length;
    const segment = body.slice(current.end, searchEnd);

    // Use the last closing </parameter> before the next <parameter> so raw code
    // inside a parameter that mentions "</parameter>" does not truncate early.
    XML_PARAM_CLOSE_RE.lastIndex = 0;
    let lastClose = null;
    let closeMatch;
    while ((closeMatch = XML_PARAM_CLOSE_RE.exec(segment)) !== null) {
      lastClose = closeMatch;
    }
    if (!lastClose) {
      hasUnclosedParam = true;
      continue;
    }

    const rawValue = segment.slice(0, lastClose.index);
    const paramSchema = properties ? properties[current.name] : null;
    args[current.name] = coerceXmlParamValue(rawValue, paramSchema);
  }

  return { args, hasUnclosedParam };
}

function normalizeParsedJsonCall(call) {
  if (!call || typeof call !== 'object') return null;
  if (!call.name || typeof call.name !== 'string') return null;
  let args = call.arguments !== undefined ? call.arguments : call.parameters;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed;
      } else {
        return null;
      }
    } catch (_) {
      return null;
    }
  }
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
    return null;
  }
  return { name: call.name, arguments: args || {} };
}

function parseXmlFunctionTags(body, schemaMap, ignoredRanges = null, offset = 0) {
  const calls = [];
  let firstMatchStart = -1;
  const openRe = new RegExp(XML_FUNCTION_OPEN_RE.source, 'gi');
  let match;
  while ((match = openRe.exec(body)) !== null) {
    if (ignoredRanges && isIndexInRanges(offset + match.index, ignoredRanges)) {
      continue;
    }
    const tagText = match[0];
    const name = (
      match[1] ||
      match[2] ||
      match[3] ||
      match[4] ||
      match[5] ||
      match[6] ||
      match[7] ||
      match[8] ||
      match[9] ||
      ''
    ).trim();
    if (!name) continue;
    const isSelfClosing = Boolean(match[10]);
    const isInvoke = /^<(?:antml:)?invoke\b/i.test(tagText);
    const contentStart = match.index + tagText.length;

    if (isSelfClosing) {
      if (firstMatchStart === -1) firstMatchStart = offset + match.index;
      calls.push({ name, arguments: {} });
      continue;
    }

    const closeRe = isInvoke ? /<\/(?:antml:)?invoke\s*>/gi : /<\/(?:antml:)?function\s*>/gi;
    closeRe.lastIndex = contentStart;
    const closeMatch = closeRe.exec(body);
    if (!closeMatch) {
      // Do not execute truncated/unclosed function calls.
      continue;
    }

    const innerBody = body.slice(contentStart, closeMatch.index);
    const { args, hasUnclosedParam } = parseXmlParameters(innerBody, schemaMap.get(name));
    if (hasUnclosedParam) {
      continue;
    }

    if (firstMatchStart === -1) firstMatchStart = offset + match.index;
    calls.push({ name, arguments: args });
    openRe.lastIndex = closeMatch.index + closeMatch[0].length;
  }
  return { calls, firstMatchStart };
}

function parseXmlInnerPayload(inner, schemaMap) {
  const { calls: fnCalls } = parseXmlFunctionTags(inner, schemaMap);
  if (fnCalls.length > 0) return fnCalls;

  // Fallback for Hermes/Qwen JSON-inside-<tool_call> format:
  // <tool_call>{"name": "bash", "arguments": {"command": "ls"}}</tool_call>
  const trimmed = inner.trim();
  if (!trimmed.startsWith('{')) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return [];
    if (Array.isArray(parsed.tool_calls)) {
      return parsed.tool_calls.map(normalizeParsedJsonCall).filter(Boolean);
    }
    const single = normalizeParsedJsonCall(parsed);
    return single ? [single] : [];
  } catch (_) {
    return [];
  }
}

function expandMatchStartToEnclosingXmlFence(text, matchStart) {
  // If the first XML tool tag sits immediately inside a ```xml or untagged ```
  // fence, point matchStart at the opening fence so the fence itself is never
  // emitted as visible prefix text.
  const before = text.slice(0, matchStart);
  const fenceMatch = before.match(/(?:^|\n)(```(?:xml)?[ \t]*\r?\n[ \t]*)$/i);
  if (!fenceMatch) return matchStart;
  const fenceStart = before.length - fenceMatch[1].length;
  // Confirm a closing ``` exists after matchStart.
  if (text.indexOf('```', matchStart) !== -1) {
    return fenceStart;
  }
  return matchStart;
}

/**
 * Parse XML-formatted tool calls emitted when a model reverts to native XML
 * weights despite the JSON [Tool Protocol]:
 *   1. <tool_call><function=name><parameter=k>v</parameter></function></tool_call>
 *   2. <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 *   3. <function_calls><invoke name="..."><parameter name="k">v</parameter></invoke></function_calls>
 *   4. Bare <function=name>...</function> or <invoke name="...">...</invoke>
 */
function parseXmlToolCalls(text, tools) {
  if (!text || !hasXmlToolOpenMarker(text)) return null;

  const ignoredRanges = findOrdinaryCodeFenceRanges(text);
  const schemaMap = buildToolSchemaMap(tools);
  const toolCalls = [];
  let firstMatchStart = -1;

  // 1) Wrapper blocks: <tool_call>...</tool_call> and <function_calls>...</function_calls>
  const wrapperRe = /<(tool_call|(?:antml:)?function_calls)(?:\s[^>]*)?>/gi;
  let wrapperMatch;
  while ((wrapperMatch = wrapperRe.exec(text)) !== null) {
    if (isIndexInRanges(wrapperMatch.index, ignoredRanges)) continue;
    const tagName = wrapperMatch[1];
    const bodyStart = wrapperMatch.index + wrapperMatch[0].length;
    const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const closeRe = new RegExp(`<\\/${escapedTag}\\s*>`, 'gi');
    closeRe.lastIndex = bodyStart;
    let closeMatch = closeRe.exec(text);
    let parsed = [];

    // Try matching closing tags in order; if a parameter value itself contains
    // a literal closing tag (e.g. editing parser code), keep advancing to the
    // outer closing tag.
    while (closeMatch) {
      const inner = text.slice(bodyStart, closeMatch.index);
      parsed = parseXmlInnerPayload(inner, schemaMap);
      if (parsed.length > 0) break;
      closeMatch = closeRe.exec(text);
    }

    // If the outer </tool_call> was dropped at EOF, still allow parsing complete
    // inner </function> / </invoke> calls or valid JSON up to EOF.
    if (parsed.length === 0 && !closeMatch) {
      parsed = parseXmlInnerPayload(text.slice(bodyStart), schemaMap);
    }

    if (parsed.length > 0) {
      if (firstMatchStart === -1) firstMatchStart = wrapperMatch.index;
      toolCalls.push(...parsed);
      wrapperRe.lastIndex = closeMatch ? closeMatch.index + closeMatch[0].length : text.length;
    }
  }

  // 2) Bare <function=...> / <invoke name="..."> outside wrapper tags
  if (toolCalls.length === 0) {
    const bare = parseXmlFunctionTags(text, schemaMap, ignoredRanges, 0);
    if (bare.calls.length > 0) {
      toolCalls.push(...bare.calls);
      firstMatchStart = bare.firstMatchStart;
    }
  }

  if (toolCalls.length === 0 || firstMatchStart === -1) {
    return null;
  }

  const matchStart = expandMatchStartToEnclosingXmlFence(text, firstMatchStart);
  const prefixText = text.slice(0, matchStart).trim();
  return { type: 'tool_calls', toolCalls, prefixText, matchStart };
}

function parseJsonToolCalls(text) {
  // Try to find a ```json ... ``` block
  const jsonBlockRe = /```json\s*\r?\n([\s\S]*?)\r?\n```/;
  const blockMatch = text.match(jsonBlockRe);

  let jsonString = null;
  let prefixText = '';
  // Index where the tool-call JSON block starts in the original text. Used by
  // the streaming gate to know exactly which part of the text is tool payload.
  let matchStart = -1;

  if (blockMatch) {
    jsonString = blockMatch[1].trim();
    prefixText = text.slice(0, blockMatch.index).trim();
    matchStart = blockMatch.index;
  } else {
    // Fallback: extract the outermost balanced JSON object containing "tool_calls"
    // This handles cases where the model forgets the markdown fences.
    // We cannot use a simple regex because lazy quantifiers will close on the
    // first inner brace instead of the matching outer brace.
    const extracted = extractBalancedJsonWithToolCalls(text);
    if (extracted) {
      jsonString = extracted.json;
      prefixText = extracted.prefixText;
      matchStart = extracted.start;
    }
  }

  if (!jsonString) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (_) {
    // JSON parse failed — try to fix common issues
    // Sometimes the model outputs extra text inside the JSON block
    const firstBrace = jsonString.indexOf('{');
    const lastBrace = jsonString.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        parsed = JSON.parse(jsonString.slice(firstBrace, lastBrace + 1));
      } catch (_) {
        return null;
      }
    } else {
      return null;
    }
  }

  // Validate the parsed structure
  if (!parsed || !Array.isArray(parsed.tool_calls)) {
    return null;
  }

  // Validate each tool call has required fields
  const validCalls = parsed.tool_calls.filter((call) => {
    if (!call || typeof call !== 'object') return false;
    if (!call.name || typeof call.name !== 'string') return false;
    // arguments must be an object (or absent, which defaults to {})
    if (call.arguments !== undefined && typeof call.arguments !== 'object') return false;
    return true;
  });

  if (validCalls.length === 0) {
    return null;
  }

  // Normalize arguments: ensure each call has an arguments object
  const toolCalls = validCalls.map((call) => ({
    name: call.name,
    arguments: call.arguments || {},
  }));

  return { type: 'tool_calls', toolCalls, prefixText, matchStart };
}

/**
 * Parse CLI output to detect tool calls.
 *
 * Returns:
 *   { type: 'text', content: <original text> }  — when no valid tool_calls found
 *   { type: 'tool_calls', toolCalls: <array>, prefixText: <text before payload>, matchStart: <number> }
 *
 * Handles markdown ```json blocks, bare {"tool_calls": ...} JSON, and XML
 * tool-call formats (<tool_call><function=...><parameter=...>, Hermes JSON
 * inside <tool_call>, and Anthropic <function_calls>/<invoke>).
 */
function parseToolCallOutput(text, tools) {
  if (!text || typeof text !== 'string') {
    return { type: 'text', content: text || '' };
  }

  const jsonResult = parseJsonToolCalls(text);
  const xmlResult = parseXmlToolCalls(text, tools);

  if (jsonResult && xmlResult) {
    // Pick whichever tool-call representation starts earlier so a tool call
    // whose string argument mentions the other format still parses cleanly.
    return jsonResult.matchStart <= xmlResult.matchStart ? jsonResult : xmlResult;
  }
  if (jsonResult) return jsonResult;
  if (xmlResult) return xmlResult;

  return { type: 'text', content: text };
}

/**
 * Detect whether plain-text fallback output still contains tool-call-like
 * markup (outside ordinary code fences) for diagnostic logging.
 */
function hasUnparsedToolCallMarkup(text) {
  if (!text || typeof text !== 'string') return false;
  const ignoredRanges = findOrdinaryCodeFenceRanges(text);
  XML_TOOL_OPEN_RE.lastIndex = 0;
  let match;
  while ((match = XML_TOOL_OPEN_RE.exec(text)) !== null) {
    if (!isIndexInRanges(match.index, ignoredRanges)) return true;
  }
  return false;
}

function findTrailingPartialXmlToolTag(text, limit, ignoredRanges) {
  const slice = text.slice(0, limit);
  const lastLt = slice.lastIndexOf('<');
  if (lastLt === -1) return limit;
  if (isIndexInRanges(lastLt, ignoredRanges)) return limit;
  // Once '>' has closed the tag, it is either matched by XML_TOOL_OPEN_RE
  // or is an ordinary tag like <div> / <functional>.
  if (slice.indexOf('>', lastLt) !== -1) return limit;

  const tail = slice.slice(lastLt);
  const tailLower = tail.toLowerCase();
  const staticPrefixes = [
    '<tool_call',
    '<function=',
    '<function ',
    '<function_calls',
    '<invoke ',
    '<antml:function_calls',
    '<antml:invoke ',
  ];
  if (staticPrefixes.some((prefix) => prefix.startsWith(tailLower))) {
    return lastLt;
  }
  if (
    /^<tool_call(?:\s[^>]*|\/)?$/i.test(tail) ||
    /^<(?:antml:)?function_calls(?:\s[^>]*)?$/i.test(tail) ||
    /^<function(?:\s*=\s*[^>]*|\s+[^>]*)?$/i.test(tail) ||
    /^<(?:antml:)?invoke\s+[^>]*$/i.test(tail)
  ) {
    return lastLt;
  }
  return limit;
}

/**
 * Compute how much of a partially streamed text is safe to forward to the
 * client right now.
 *
 * Tool calls are simulated at the prompt level: the model emits a ```json
 * fence, a bare JSON object containing {"tool_calls": [...]}, or an XML
 * tool-call block (<tool_call>, <function=...>, <function_calls>, <invoke>)
 * that must be parsed as a whole and returned as structured tool_use /
 * tool_calls blocks — never as visible text. While streaming we therefore
 * hold back any tail that could still be or grow into such a block:
 *
 *   1. any unclosed ``` fence (its language tag may still be arriving), any
 *      CLOSED fence tagged json/untagged, and any closed xml fence containing
 *      an XML tool-call tag. Fences with another explicit language (```js,
 *      ```python …) or ordinary xml snippets pass through once closed.
 *   2. an unclosed outermost { ... } structure, and any closed outermost
 *      object containing "tool_calls" (string-aware brace counting).
 *   3. any XML tool-call opening tag (<tool_call, <function=, <function_calls,
 *      <invoke name=...) outside ordinary code fences, plus any trailing
 *      partial prefix of such a tag arriving across chunks.
 *   4. a trailing run of 1-2 backticks (a ``` marker arriving in pieces).
 *
 * Everything before the withheld region can never be part of the tool-call
 * payload and is streamed immediately. The withheld tail is resolved once
 * the stream completes: parsed as tool calls or flushed as plain text.
 */
function findStreamingSafePrefixLength(text) {
  if (!text) return 0;
  let safeEnd = text.length;
  const ordinaryFenceRanges = [];

  // 1) Fence scan. Closed non-tool fences are passed over; anything else
  // caps the safe region at the fence start.
  let cursor = 0;
  while (cursor < safeEnd) {
    const openIdx = text.indexOf('```', cursor);
    if (openIdx === -1 || openIdx >= safeEnd) break;
    const lineEnd = text.indexOf('\n', openIdx + 3);
    if (lineEnd === -1 || lineEnd >= safeEnd) {
      // Fence marker (and maybe language tag) still arriving, or the fence
      // has no closing line yet — withhold from the marker.
      safeEnd = Math.min(safeEnd, openIdx);
      break;
    }
    const lang = text.slice(openIdx + 3, lineEnd).trim().toLowerCase();
    const closeIdx = text.indexOf('```', lineEnd + 1);
    if (closeIdx === -1) {
      // Unclosed fence — its content is still growing.
      safeEnd = Math.min(safeEnd, openIdx);
      break;
    }
    if (lang === '' || lang === 'json') {
      // Closed fence that may carry the tool-call payload — withhold the
      // whole block (and anything after it) until the stream completes.
      safeEnd = Math.min(safeEnd, openIdx);
      break;
    }
    if (lang === 'xml' && hasXmlToolOpenMarker(text.slice(lineEnd + 1, closeIdx))) {
      // Closed ```xml fence carrying an XML tool call — withhold from the
      // fence start so neither the fence nor the XML leaks.
      safeEnd = Math.min(safeEnd, openIdx);
      break;
    }
    // Ordinary code sample in another language — skip past it.
    ordinaryFenceRanges.push([openIdx, closeIdx + 3]);
    cursor = closeIdx + 3;
  }

  // 2) String-aware brace counting over the remaining safe region: hold back
  // an unclosed outermost object, or a closed one containing "tool_calls".
  let depth = 0;
  let outerBraceStart = -1;
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < safeEnd; i++) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) outerBraceStart = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          if (text.slice(outerBraceStart, i + 1).includes('"tool_calls"')) {
            safeEnd = Math.min(safeEnd, outerBraceStart);
            break;
          }
          outerBraceStart = -1;
        }
      }
    }
  }
  if (depth > 0 && outerBraceStart !== -1) {
    safeEnd = Math.min(safeEnd, outerBraceStart);
  }

  // 3) XML tool-call scan outside ordinary code fences: withhold from the
  // first XML tool-call opening tag, or from a trailing partial tag prefix
  // (e.g. "<", "<tool_", "<function") split across chunks.
  const xmlOpenRe = new RegExp(XML_TOOL_OPEN_RE.source, 'gi');
  let xmlMatch;
  while ((xmlMatch = xmlOpenRe.exec(text)) !== null) {
    if (xmlMatch.index >= safeEnd) break;
    if (isIndexInRanges(xmlMatch.index, ordinaryFenceRanges)) continue;
    safeEnd = Math.min(safeEnd, xmlMatch.index);
    break;
  }
  if (safeEnd > 0) {
    safeEnd = Math.min(safeEnd, findTrailingPartialXmlToolTag(text, safeEnd, ordinaryFenceRanges));
  }

  // 4) A trailing run of 1-2 backticks could be the start of a ``` marker
  // split across chunks — hold them back until the next chunk disambiguates.
  if (safeEnd > 0) {
    const tailMatch = text.slice(0, safeEnd).match(/`{1,2}$/);
    if (tailMatch) safeEnd -= tailMatch[0].length;
  }

  return safeEnd;
}

/**
 * Generate a call ID with the appropriate prefix.
 *
 * OpenAI uses "call_" prefix, Anthropic uses "toolu_" prefix.
 * The ID body is 24 hex characters (12 bytes of randomness).
 */
function generateCallId(prefix = 'call_') {
  const id = crypto.randomBytes(12).toString('hex');
  return `${prefix}${id}`;
}

/**
 * Format tool results for inclusion in the CLI prompt.
 *
 * This handles both OpenAI format (role: 'tool' messages) and
 * Anthropic format (tool_result content blocks).
 *
 * OpenAI tool result messages:
 *   { role: 'tool', tool_call_id: 'call_xxx', content: 'result text' }
 *
 * Anthropic tool_result blocks:
 *   { type: 'tool_result', tool_use_id: 'toolu_xxx', content: '...' }
 *
 * Returns a formatted text block that clearly identifies each result
 * by its tool call/use ID so the model can understand what result
 * corresponds to which tool invocation.
 */
function formatToolResultForPrompt(toolResults) {
  if (!toolResults || toolResults.length === 0) return '';

  return toolResults
    .map((result) => {
      const id = result.tool_call_id || result.tool_use_id || 'unknown';
      const content = typeof result.content === 'string'
        ? result.content
        : Array.isArray(result.content)
          ? result.content
              .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object') return part.text || part.content || '';
                return '';
              })
              .filter(Boolean)
              .join('\n')
          : String(result.content || '');
      return `<tool_result id="${id}">\n${content}\n</tool_result>`;
    })
    .join('\n\n');
}

/**
 * Convert OpenAI tool definitions to a normalized format.
 *
 * OpenAI tools: [{ type: 'function', function: { name, description, parameters } }]
 * Returns: [{ name, description, parameters }]
 */
function normalizeOpenAiTools(tools) {
  if (!tools || !Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description || '',
    parameters: tool.function?.parameters || tool.parameters || {},
  }));
}

/**
 * Convert Anthropic tool definitions to a normalized format.
 *
 * Anthropic tools: [{ name, description, input_schema }]
 * Note: Anthropic uses `input_schema` where OpenAI uses `parameters`.
 * Returns: [{ name, description, parameters }]
 */
function normalizeAnthropicTools(tools) {
  if (!tools || !Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    parameters: tool.input_schema || tool.parameters || {},
  }));
}

module.exports = {
  buildToolSystemPrompt,
  findStreamingSafePrefixLength,
  formatToolResultForPrompt,
  generateCallId,
  hasUnparsedToolCallMarkup,
  normalizeAnthropicTools,
  normalizeOpenAiTools,
  parseToolCallOutput,
};
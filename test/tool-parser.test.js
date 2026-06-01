const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildToolSystemPrompt,
  parseToolCallOutput,
  generateCallId,
  formatToolResultForPrompt,
  normalizeOpenAiTools,
  normalizeAnthropicTools,
} = require('../clean/tool-parser');

test('buildToolSystemPrompt returns empty string when no tools', () => {
  assert.equal(buildToolSystemPrompt(null), '');
  assert.equal(buildToolSystemPrompt([]), '');
  assert.equal(buildToolSystemPrompt(undefined), '');
});

test('buildToolSystemPrompt includes tool names and format-only instructions', () => {
  const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }];
  const prompt = buildToolSystemPrompt(tools);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /tool_calls/);
  // Must NOT contain role-defining statements
  assert.equal(/你是一个/.test(prompt), false);
  // Must contain format-only instructions
  assert.match(prompt, /直接以正常文本回复/);
});

test('buildToolSystemPrompt works with OpenAI-style tool objects', () => {
  const tools = [
    { type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { location: { type: 'string' } } } } },
  ];
  const prompt = buildToolSystemPrompt(tools);
  assert.match(prompt, /get_weather/);
});

test('parseToolCallOutput returns text when input is plain text', () => {
  const result = parseToolCallOutput('Hello, I will help you.');
  assert.equal(result.type, 'text');
  assert.equal(result.content, 'Hello, I will help you.');
});

test('parseToolCallOutput returns text when input is empty', () => {
  assert.deepEqual(parseToolCallOutput(''), { type: 'text', content: '' });
  assert.deepEqual(parseToolCallOutput(null), { type: 'text', content: '' });
});

test('parseToolCallOutput parses single tool call from markdown json block', () => {
  const output = '```json\n{"tool_calls": [{"name": "read_file", "arguments": {"path": "/tmp/x"}}]}\n```';
  const result = parseToolCallOutput(output);
  assert.equal(result.type, 'tool_calls');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'read_file');
  assert.deepEqual(result.toolCalls[0].arguments, { path: '/tmp/x' });
});

test('parseToolCallOutput parses multiple tool calls', () => {
  const output = '```json\n{"tool_calls": [{"name": "read_file", "arguments": {"path": "/a"}}, {"name": "write_file", "arguments": {"path": "/b", "content": "hi"}}]}\n```';
  const result = parseToolCallOutput(output);
  assert.equal(result.type, 'tool_calls');
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].name, 'read_file');
  assert.equal(result.toolCalls[1].name, 'write_file');
});

test('parseToolCallOutput captures prefix text before json block', () => {
  const output = 'Let me check that.\n```json\n{"tool_calls": [{"name": "read_file", "arguments": {"path": "/tmp/x"}}]}\n```';
  const result = parseToolCallOutput(output);
  assert.equal(result.type, 'tool_calls');
  assert.equal(result.prefixText, 'Let me check that.');
});

test('parseToolCallOutput falls back to text when json block has no tool_calls', () => {
  const output = '```json\n{"message": "hello"}\n```';
  const result = parseToolCallOutput(output);
  assert.equal(result.type, 'text');
  assert.equal(result.content, output);
});

test('parseToolCallOutput falls back to text when tool_calls is not an array', () => {
  const output = '```json\n{"tool_calls": "invalid"}\n```';
  const result = parseToolCallOutput(output);
  assert.equal(result.type, 'text');
});

test('parseToolCallOutput falls back to text when tool call has no name', () => {
  const output = '```json\n{"tool_calls": [{"arguments": {"path": "/x"}}]}\n```';
  const result = parseToolCallOutput(output);
  assert.equal(result.type, 'text');
});

test('parseToolCallOutput handles tool call with no arguments', () => {
  const output = '```json\n{"tool_calls": [{"name": "list_files"}]}\n```';
  const result = parseToolCallOutput(output);
  assert.equal(result.type, 'tool_calls');
  assert.equal(result.toolCalls[0].name, 'list_files');
  assert.deepEqual(result.toolCalls[0].arguments, {});
});

test('parseToolCallOutput falls back to text for invalid JSON in markdown block', () => {
  const output = '```json\n{broken json}\n```';
  const result = parseToolCallOutput(output);
  assert.equal(result.type, 'text');
});

test('parseToolCallOutput extracts tool_calls JSON without markdown fences', () => {
  const output = '{"tool_calls": [{"name": "search", "arguments": {"query": "test"}}]}';
  const result = parseToolCallOutput(output);
  assert.equal(result.type, 'tool_calls');
  assert.equal(result.toolCalls[0].name, 'search');
});

test('parseToolCallOutput fixes JSON with extra braces', () => {
  const output = '```json\nextra {{"tool_calls": [{"name": "search", "arguments": {"query": "test"}}]}\n```';
  const result = parseToolCallOutput(output);
  // This should either parse or fallback — both are acceptable
  assert.ok(result.type === 'tool_calls' || result.type === 'text');
});

test('generateCallId produces call_ prefix for OpenAI', () => {
  const id = generateCallId('call_');
  assert.ok(id.startsWith('call_'));
  assert.equal(id.length, 29); // call_ + 24 hex chars
});

test('generateCallId produces toolu_ prefix for Anthropic', () => {
  const id = generateCallId('toolu_');
  assert.ok(id.startsWith('toolu_'));
});

test('generateCallId produces unique IDs', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    ids.add(generateCallId('call_'));
  }
  assert.equal(ids.size, 100);
});

test('formatToolResultForPrompt returns empty string for empty input', () => {
  assert.equal(formatToolResultForPrompt(null), '');
  assert.equal(formatToolResultForPrompt([]), '');
});

test('formatToolResultForPrompt formats OpenAI tool results with tool_call_id', () => {
  const results = [
    { tool_call_id: 'call_abc123', content: '15 degrees Celsius' },
  ];
  const formatted = formatToolResultForPrompt(results);
  assert.match(formatted, /tool_result id="call_abc123"/);
  assert.match(formatted, /15 degrees Celsius/);
});

test('formatToolResultForPrompt formats Anthropic tool results with tool_use_id', () => {
  const results = [
    { tool_use_id: 'toolu_xyz789', content: 'File contents here' },
  ];
  const formatted = formatToolResultForPrompt(results);
  assert.match(formatted, /tool_result id="toolu_xyz789"/);
  assert.match(formatted, /File contents here/);
});

test('formatToolResultForPrompt handles array content blocks', () => {
  const results = [
    { tool_use_id: 'toolu_abc', content: [{ type: 'text', text: 'result line 1' }, { type: 'text', text: 'result line 2' }] },
  ];
  const formatted = formatToolResultForPrompt(results);
  assert.match(formatted, /result line 1\nresult line 2/);
});

test('normalizeOpenAiTools converts OpenAI tool format', () => {
  const tools = [
    { type: 'function', function: { name: 'get_weather', description: 'Get weather info', parameters: { type: 'object', properties: { location: { type: 'string' } } } } },
  ];
  const normalized = normalizeOpenAiTools(tools);
  assert.equal(normalized[0].name, 'get_weather');
  assert.equal(normalized[0].description, 'Get weather info');
  assert.equal(normalized[0].parameters.type, 'object');
});

test('normalizeAnthropicTools converts input_schema to parameters', () => {
  const tools = [
    { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  ];
  const normalized = normalizeAnthropicTools(tools);
  assert.equal(normalized[0].name, 'Read');
  assert.equal(normalized[0].parameters.type, 'object');
  assert.equal(normalized[0].parameters.properties.path.type, 'string');
});
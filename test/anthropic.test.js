const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAnthropicText } = require('../clean/anthropic');

test('text blocks are extracted', () => {
  const result = normalizeAnthropicText([
    { type: 'text', text: 'hello' },
    { type: 'text', text: 'world' },
  ]);
  assert.equal(result, 'hello\nworld');
});

test('image blocks produce [image: <media_type>] placeholder', () => {
  const result = normalizeAnthropicText([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
  ]);
  assert.equal(result, '[image: image/png]');
});

test('image blocks without media_type produce [image: unknown]', () => {
  const result = normalizeAnthropicText([
    { type: 'image', source: { type: 'base64' } },
  ]);
  assert.equal(result, '[image: unknown]');
});

test('thinking blocks preserve thinking text', () => {
  const result = normalizeAnthropicText([
    { type: 'thinking', thinking: 'step by step reasoning' },
  ]);
  assert.equal(result, '[thinking]\nstep by step reasoning');
});

test('thinking blocks with empty thinking return empty', () => {
  const result = normalizeAnthropicText([
    { type: 'thinking', thinking: '' },
  ]);
  assert.equal(result, '');
});

test('document blocks produce [document: <name>] placeholder', () => {
  const result = normalizeAnthropicText([
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf' }, name: 'report.pdf' },
  ]);
  assert.equal(result, '[document: report.pdf]');
});

test('document blocks without name use media_type or file', () => {
  const withMediaType = normalizeAnthropicText([
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf' } },
  ]);
  assert.equal(withMediaType, '[document: application/pdf]');

  const bare = normalizeAnthropicText([
    { type: 'document', source: { type: 'url' } },
  ]);
  assert.equal(bare, '[document: file]');
});

test('unknown type blocks produce [unsupported content: <type>]', () => {
  const result = normalizeAnthropicText([
    { type: 'some_future_type', data: 'whatever' },
  ]);
  assert.equal(result, '[unsupported content: some_future_type]');
});

test('mixed content blocks are joined with newlines', () => {
  const result = normalizeAnthropicText([
    { type: 'text', text: 'before' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'x' } },
    { type: 'thinking', thinking: 'reasoning here' },
  ]);
  assert.equal(result, 'before\n[image: image/jpeg]\n[thinking]\nreasoning here');
});

test('tool_result and tool_use use tagged format (regression)', () => {
  const toolResult = normalizeAnthropicText([
    { type: 'tool_result', tool_use_id: 'abc', content: 'output text' },
  ]);
  assert.equal(toolResult, '<tool_result id="abc">\noutput text\n</tool_result>');

  const toolUse = normalizeAnthropicText([
    { type: 'tool_use', name: 'read_file', input: { path: '/tmp/x' } },
  ]);
  assert.equal(toolUse, '<tool_use name="read_file" id="">\n{"path":"/tmp/x"}\n</tool_use>');
});

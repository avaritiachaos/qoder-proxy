const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { executeToolCall, tokenizeCommand } = require('../clean/tools-executor');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-tools-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function withEnv(vars, body) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ─── Workspace confinement ───────────────────────────────────────────────────

test('Read is confined to the workspace', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    fs.writeFileSync(path.join(root, 'inside.txt'), 'visible', 'utf8');
    const outside = path.join(os.tmpdir(), `qoder-outside-${process.pid}.txt`);
    fs.writeFileSync(outside, 'SECRET', 'utf8');

    await withEnv({ SERVER_TOOL_WORKSPACE: root }, async () => {
      const allowed = await executeToolCall({
        name: 'Read',
        arguments: { file_path: 'inside.txt' },
      });
      assert.equal(allowed.content, 'visible');

      // An absolute path used to sail straight past the old ".." check.
      const blockedAbsolute = await executeToolCall({
        name: 'Read',
        arguments: { file_path: outside },
      });
      assert.match(blockedAbsolute.error, /escapes the tool workspace/);
      assert.equal(blockedAbsolute.content, undefined);

      const blockedRelative = await executeToolCall({
        name: 'Read',
        arguments: { file_path: path.join('..', path.basename(outside)) },
      });
      assert.match(blockedRelative.error, /escapes the tool workspace/);
    });

    fs.rmSync(outside, { force: true });
  } finally {
    cleanup();
  }
});

test('Write and Edit cannot escape the workspace', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    await withEnv({ SERVER_TOOL_WORKSPACE: root }, async () => {
      const escaped = path.join(os.tmpdir(), `qoder-escape-${process.pid}.txt`);
      const write = await executeToolCall({
        name: 'Write',
        arguments: { file_path: escaped, content: 'pwned' },
      });
      assert.match(write.error, /escapes the tool workspace/);
      assert.equal(fs.existsSync(escaped), false);

      const ok = await executeToolCall({
        name: 'Write',
        arguments: { file_path: 'nested/dir/file.txt', content: 'hello' },
      });
      assert.equal(ok.success, true);

      const edited = await executeToolCall({
        name: 'Edit',
        arguments: { file_path: 'nested/dir/file.txt', old_string: 'hello', new_string: 'bye' },
      });
      assert.equal(edited.success, true);
      assert.equal(fs.readFileSync(path.join(root, 'nested/dir/file.txt'), 'utf8'), 'bye');
    });
  } finally {
    cleanup();
  }
});

test('a symlink planted in the workspace cannot be used to read outside it', async (t) => {
  const { root, cleanup } = makeWorkspace();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-secrets-'));
  try {
    fs.writeFileSync(path.join(outsideDir, 'key.txt'), 'SECRET', 'utf8');
    try {
      fs.symlinkSync(outsideDir, path.join(root, 'link'), 'junction');
    } catch (_) {
      // Creating links can require privileges on Windows.
      t.skip('symlink creation not permitted in this environment');
      return;
    }

    await withEnv({ SERVER_TOOL_WORKSPACE: root }, async () => {
      const result = await executeToolCall({
        name: 'Read',
        arguments: { file_path: path.join('link', 'key.txt') },
      });
      assert.match(result.error, /escapes the tool workspace/);
      assert.equal(result.content, undefined);
    });
  } finally {
    cleanup();
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('Glob and Grep stay inside the workspace', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    fs.writeFileSync(path.join(root, 'a.js'), 'needle here', 'utf8');
    fs.writeFileSync(path.join(root, 'b.txt'), 'nothing', 'utf8');

    await withEnv({ SERVER_TOOL_WORKSPACE: root }, async () => {
      const glob = await executeToolCall({ name: 'Glob', arguments: { pattern: '*.js' } });
      assert.equal(glob.files.length, 1);
      assert.match(glob.files[0], /a\.js$/);

      // "*.js" must not match "b.txt" — the old version left "." unescaped.
      assert.equal(glob.files.some((file) => file.endsWith('b.txt')), false);

      const grep = await executeToolCall({ name: 'Grep', arguments: { pattern: 'needle' } });
      assert.equal(grep.matches.length, 1);

      const escaped = await executeToolCall({
        name: 'Glob',
        arguments: { pattern: '*', path: os.tmpdir() },
      });
      assert.match(escaped.error, /escapes the tool workspace/);
    });
  } finally {
    cleanup();
  }
});

// ─── Bash gating ─────────────────────────────────────────────────────────────

test('Bash refuses to run until explicitly enabled with an allowlist', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    await withEnv(
      {
        SERVER_TOOL_WORKSPACE: root,
        SERVER_TOOL_ALLOW_BASH: undefined,
        SERVER_TOOL_BASH_ALLOWLIST: undefined,
      },
      async () => {
        const disabled = await executeToolCall({
          name: 'Bash',
          arguments: { command: 'node --version' },
        });
        assert.match(disabled.error, /SERVER_TOOL_ALLOW_BASH/);
        assert.equal(disabled.output, undefined);
      }
    );

    await withEnv(
      {
        SERVER_TOOL_WORKSPACE: root,
        SERVER_TOOL_ALLOW_BASH: '1',
        SERVER_TOOL_BASH_ALLOWLIST: '',
      },
      async () => {
        const noAllowlist = await executeToolCall({
          name: 'Bash',
          arguments: { command: 'node --version' },
        });
        assert.match(noAllowlist.error, /ALLOWLIST is empty/);
        assert.equal(noAllowlist.output, undefined);
      }
    );
  } finally {
    cleanup();
  }
});

test('Bash runs allowlisted commands and rejects everything else', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    await withEnv(
      {
        SERVER_TOOL_WORKSPACE: root,
        SERVER_TOOL_ALLOW_BASH: '1',
        SERVER_TOOL_BASH_ALLOWLIST: 'node',
      },
      async () => {
        const allowed = await executeToolCall({
          name: 'Bash',
          arguments: { command: 'node --version' },
        });
        assert.match(allowed.output || '', /^v\d+\./);

        const notListed = await executeToolCall({
          name: 'Bash',
          arguments: { command: 'curl https://evil.example' },
        });
        assert.match(notListed.error, /not in SERVER_TOOL_BASH_ALLOWLIST/);
        assert.equal(notListed.output, undefined);
      }
    );
  } finally {
    cleanup();
  }
});

test('shell metacharacters cannot smuggle a second command past the allowlist', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    await withEnv(
      {
        SERVER_TOOL_WORKSPACE: root,
        SERVER_TOOL_ALLOW_BASH: '1',
        SERVER_TOOL_BASH_ALLOWLIST: 'node',
      },
      async () => {
        const smuggled = [
          'node --version && curl https://evil.example',
          'node --version; rm -rf .',
          'node --version | tee /tmp/out',
          'node -e "1" > /tmp/out',
          'node $(whoami)',
          'node `whoami`',
          'node --version\nrm -rf .',
        ];
        for (const command of smuggled) {
          const result = await executeToolCall({ name: 'Bash', arguments: { command } });
          assert.match(result.error, /Shell syntax/, `expected refusal for: ${command}`);
          assert.equal(result.output, undefined);
        }
      }
    );
  } finally {
    cleanup();
  }
});

test('an allowlisted name cannot be borrowed by a path-qualified binary', async () => {
  const { root, cleanup } = makeWorkspace();
  try {
    await withEnv(
      {
        SERVER_TOOL_WORKSPACE: root,
        SERVER_TOOL_ALLOW_BASH: '1',
        SERVER_TOOL_BASH_ALLOWLIST: 'node',
      },
      async () => {
        for (const command of ['./node --version', '/tmp/evil/node --version']) {
          const result = await executeToolCall({ name: 'Bash', arguments: { command } });
          assert.match(result.error, /bare command names/);
          assert.equal(result.output, undefined);
        }
      }
    );
  } finally {
    cleanup();
  }
});

test('command tokenizer keeps quoted arguments intact', () => {
  assert.deepEqual(tokenizeCommand('node --version'), ['node', '--version']);
  assert.deepEqual(tokenizeCommand('node -e "console.log(1)"'), ['node', '-e', 'console.log(1)']);
  assert.deepEqual(tokenizeCommand("git commit -m 'a message'"), [
    'git',
    'commit',
    '-m',
    'a message',
  ]);
  assert.deepEqual(tokenizeCommand('   '), []);
});

test('unknown tools are still refused', async () => {
  const result = await executeToolCall({ name: 'Nope', arguments: {} });
  assert.match(result.error, /Unknown tool/);
});

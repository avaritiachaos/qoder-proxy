'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Server-side tool execution runs whatever the model asked for, and the model
// is steered by a prompt that any client can supply. Every operation is
// therefore confined to a single workspace directory, and shell execution is
// an allowlist rather than a blocklist — a blocklist of dangerous commands is
// unwinnable, since `rm -rf /` has an unbounded number of spellings.

const MAX_MATCHES = 500;
const MAX_PATTERN_LENGTH = 200;
const BASH_TIMEOUT_MS = 30000;
const BASH_MAX_BUFFER = 1024 * 1024;

// Anything that would need a shell to interpret. We never spawn a shell, so
// these characters cannot mean what the model intended — refuse instead of
// silently passing them through as literal argv text.
const SHELL_METACHARACTERS = /[;&|`$<>(){}\n\r]/;

function isEnabled(value) {
  return /^(1|true|yes)$/i.test(value || '');
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Root directory that every tool operation is confined to. Defaults to the
 * proxy's working directory so the blast radius matches where it was started.
 */
function workspaceRoot() {
  return path.resolve(process.env.SERVER_TOOL_WORKSPACE || process.cwd());
}

/** Realpath of the nearest existing ancestor, for paths that don't exist yet. */
function realpathOfNearestExisting(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      return fs.realpathSync(current);
    } catch (_) {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === '') return true;
  // An absolute result means different drives on Windows; ".." means above root.
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Resolve a model-supplied path inside the workspace, or throw.
 *
 * Checks containment both lexically and after symlink resolution, so neither an
 * absolute path (`C:\Users\me\.ssh\id_rsa`) nor a symlink planted inside the
 * workspace can reach outside it.
 */
function resolveInWorkspace(filePath) {
  if (!filePath) return null;

  const root = workspaceRoot();
  const resolved = path.resolve(root, filePath);
  const realRoot = realpathOfNearestExisting(root);

  if (!isInside(root, resolved) || !isInside(realRoot, realpathOfNearestExisting(resolved))) {
    throw new Error(`Path escapes the tool workspace: ${filePath}`);
  }
  return resolved;
}

function compilePattern(pattern) {
  if (String(pattern).length > MAX_PATTERN_LENGTH) {
    throw new Error(`Pattern is too long (max ${MAX_PATTERN_LENGTH} characters).`);
  }
  return new RegExp(pattern);
}

/**
 * Execute a tool call and return the result.
 * Supported tools: Read, Write, Edit, Bash, Glob, Grep
 */
async function executeToolCall(toolCall) {
  const { name, arguments: args } = toolCall;

  try {
    switch (name) {
      case 'Read':
        return await executeRead(args);
      case 'Write':
        return await executeWrite(args);
      case 'Edit':
        return await executeEdit(args);
      case 'Bash':
        return await executeBash(args);
      case 'Glob':
        return await executeGlob(args);
      case 'Grep':
        return await executeGrep(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

async function executeRead(args) {
  const filePath = resolveInWorkspace(args?.file_path || args?.path);
  if (!filePath) {
    return { error: 'Missing file_path parameter' };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { content };
  } catch (error) {
    return { error: `Failed to read file: ${error.message}` };
  }
}

async function executeWrite(args) {
  const filePath = resolveInWorkspace(args?.file_path || args?.path);
  const content = args?.content;

  if (!filePath) {
    return { error: 'Missing file_path parameter' };
  }
  if (content === undefined) {
    return { error: 'Missing content parameter' };
  }

  try {
    const dir = path.dirname(filePath);
    if (dir && dir !== '.') {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true, message: `File written: ${filePath}` };
  } catch (error) {
    return { error: `Failed to write file: ${error.message}` };
  }
}

async function executeEdit(args) {
  const filePath = resolveInWorkspace(args?.file_path || args?.path);
  const oldString = args?.old_string || args?.oldString;
  const newString = args?.new_string || args?.newString || '';

  if (!filePath) {
    return { error: 'Missing file_path parameter' };
  }
  if (oldString === undefined) {
    return { error: 'Missing old_string parameter' };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes(oldString)) {
      return { error: `Could not find the text to replace in ${filePath}` };
    }
    const newContent = content.replace(oldString, newString);
    fs.writeFileSync(filePath, newContent, 'utf8');
    return { success: true, message: `File edited: ${filePath}` };
  } catch (error) {
    return { error: `Failed to edit file: ${error.message}` };
  }
}

/**
 * Split a command into argv without involving a shell. Only needs to cover the
 * plain `cmd arg "quoted arg"` forms a model realistically emits, because
 * anything requiring shell interpretation is rejected before we get here.
 */
function tokenizeCommand(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token !== undefined) tokens.push(token);
  }
  return tokens;
}

function normalizeExecutableName(token) {
  return path.basename(token).replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
}

async function executeBash(args) {
  const command = args?.command;
  if (!command) {
    return { error: 'Missing command parameter' };
  }

  if (!isEnabled(process.env.SERVER_TOOL_ALLOW_BASH)) {
    return {
      error:
        'Bash execution is disabled. It requires SERVER_TOOL_ALLOW_BASH=1 plus an explicit ' +
        'SERVER_TOOL_BASH_ALLOWLIST, because any client can steer the model into calling it.',
    };
  }

  const allowlist = splitList(process.env.SERVER_TOOL_BASH_ALLOWLIST).map(normalizeExecutableName);
  if (!allowlist.length) {
    return {
      error:
        'SERVER_TOOL_BASH_ALLOWLIST is empty, so no command is permitted. Name the executables ' +
        'you want to allow, e.g. SERVER_TOOL_BASH_ALLOWLIST=git,node,pytest.',
    };
  }

  if (SHELL_METACHARACTERS.test(command)) {
    return {
      error:
        'Shell syntax (chaining, pipes, redirection, substitution) is not supported. ' +
        'Send one command with plain arguments.',
    };
  }

  const tokens = tokenizeCommand(command);
  if (!tokens.length) {
    return { error: 'Empty command' };
  }

  // The allowlist names commands, not arbitrary binaries: a path-qualified
  // executable would let `./git` or `C:\evil\git.exe` borrow an allowed name.
  if (/[\\/]/.test(tokens[0])) {
    return { error: 'Only bare command names from the allowlist may be run, not paths.' };
  }

  const executable = normalizeExecutableName(tokens[0]);
  if (!allowlist.includes(executable)) {
    return { error: `Command "${executable}" is not in SERVER_TOOL_BASH_ALLOWLIST.` };
  }

  try {
    const output = execFileSync(tokens[0], tokens.slice(1), {
      encoding: 'utf8',
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: BASH_MAX_BUFFER,
      cwd: workspaceRoot(),
      shell: false,
      windowsHide: true,
    });
    return { output: output.trim() };
  } catch (error) {
    return {
      error: error.message || 'Command execution failed',
      output: error.stdout?.toString?.() || '',
      stderr: error.stderr?.toString?.() || '',
    };
  }
}

function globToRegExp(pattern) {
  if (String(pattern).length > MAX_PATTERN_LENGTH) {
    throw new Error(`Pattern is too long (max ${MAX_PATTERN_LENGTH} characters).`);
  }
  // Escape regex metacharacters first, then re-enable the glob wildcards, so a
  // literal "." in "*.js" does not match any character.
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.'));
}

function walkWorkspace(startDir, visitFile) {
  const stack = [startDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue; // Unreadable directory — skip rather than abort the walk.
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          stack.push(fullPath);
        }
      } else if (entry.isFile()) {
        if (visitFile(fullPath) === false) return;
      }
    }
  }
}

async function executeGlob(args) {
  const pattern = args?.pattern;
  if (!pattern) {
    return { error: 'Missing pattern parameter' };
  }

  try {
    const searchDir = resolveInWorkspace(args?.path || '.');
    const regex = globToRegExp(pattern);
    const results = [];
    let truncated = false;

    walkWorkspace(searchDir, (fullPath) => {
      if (regex.test(path.basename(fullPath)) || regex.test(fullPath)) {
        results.push(fullPath);
        if (results.length >= MAX_MATCHES) {
          truncated = true;
          return false;
        }
      }
      return true;
    });

    return truncated ? { files: results, truncated: true } : { files: results };
  } catch (error) {
    return { error: `Failed to glob: ${error.message}` };
  }
}

async function executeGrep(args) {
  const pattern = args?.pattern;
  if (!pattern) {
    return { error: 'Missing pattern parameter' };
  }

  try {
    const regex = compilePattern(pattern);
    const filePath = resolveInWorkspace(args?.file_path || args?.path);

    if (filePath && fs.statSync(filePath).isFile()) {
      const content = fs.readFileSync(filePath, 'utf8');
      const matches = [];
      content.split('\n').forEach((line, index) => {
        if (matches.length < MAX_MATCHES && regex.test(line)) {
          matches.push({ line: index + 1, text: line.trim() });
        }
      });
      return { matches, file: filePath };
    }

    const searchDir = resolveInWorkspace(args?.search_path || filePath || '.');
    const results = [];
    let truncated = false;

    walkWorkspace(searchDir, (fullPath) => {
      let content;
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch (_) {
        return true; // Binary or unreadable — skip.
      }
      if (regex.test(content)) {
        results.push(fullPath);
        if (results.length >= MAX_MATCHES) {
          truncated = true;
          return false;
        }
      }
      return true;
    });

    const matches = results.map((file) => ({ file }));
    return truncated ? { matches, truncated: true } : { matches };
  } catch (error) {
    return { error: `Failed to grep: ${error.message}` };
  }
}

module.exports = {
  executeToolCall,
  resolveInWorkspace,
  tokenizeCommand,
  workspaceRoot,
};

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

function resolveFilePath(filePath) {
  if (!filePath) return null;
  // Prevent directory traversal
  const normalized = path.normalize(filePath);
  if (normalized.startsWith('..')) {
    throw new Error('Path traversal not allowed');
  }
  return normalized;
}

async function executeRead(args) {
  const filePath = resolveFilePath(args?.file_path || args?.path);
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
  const filePath = resolveFilePath(args?.file_path || args?.path);
  const content = args?.content;

  if (!filePath) {
    return { error: 'Missing file_path parameter' };
  }
  if (content === undefined) {
    return { error: 'Missing content parameter' };
  }

  try {
    // Create parent directories if needed
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
  const filePath = resolveFilePath(args?.file_path || args?.path);
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

async function executeBash(args) {
  const command = args?.command;
  if (!command) {
    return { error: 'Missing command parameter' };
  }

  // Block dangerous commands
  const blockedPatterns = [
    /rm\s+-rf\s+\/+/,
    />\s*\/dev\/null/,
    /dd\s+if=/,
    /mkfs\./,
    /:(){ :|:& };:/,
  ];
  for (const pattern of blockedPatterns) {
    if (pattern.test(command)) {
      return { error: 'Command blocked for security reasons' };
    }
  }

  try {
    const output = execSync(command, {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      cwd: process.cwd(),
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

async function executeGlob(args) {
  const pattern = args?.pattern;
  if (!pattern) {
    return { error: 'Missing pattern parameter' };
  }

  try {
    // Simple glob implementation using fs
    const results = [];
    const searchDir = args?.path || '.';

    function searchRecursive(dir, pat) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Recurse but skip node_modules and .git
          if (entry.name !== 'node_modules' && entry.name !== '.git') {
            searchRecursive(fullPath, pat);
          }
        } else {
          // Simple pattern matching
          const regex = new RegExp(pat.replace(/\*/g, '.*').replace(/\?/g, '.'));
          if (regex.test(entry.name) || regex.test(fullPath)) {
            results.push(fullPath);
          }
        }
      }
    }

    searchRecursive(searchDir, pattern);
    return { files: results };
  } catch (error) {
    return { error: `Failed to glob: ${error.message}` };
  }
}

async function executeGrep(args) {
  const pattern = args?.pattern;
  const filePath = resolveFilePath(args?.file_path || args?.path);
  const searchPath = args?.search_path || '.';

  if (!pattern) {
    return { error: 'Missing pattern parameter' };
  }

  try {
    if (filePath) {
      // Search in a specific file
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const matches = [];
      const regex = new RegExp(pattern);
      lines.forEach((line, index) => {
        if (regex.test(line)) {
          matches.push({ line: index + 1, text: line.trim() });
        }
      });
      return { matches, file: filePath };
    } else {
      // Search in directory
      const results = [];
      function searchRecursive(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && entry.name !== '.git') {
              searchRecursive(fullPath);
            }
          } else {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              const regex = new RegExp(pattern);
              if (regex.test(content)) {
                results.push(fullPath);
              }
            } catch (_) {
              // Skip binary or unreadable files
            }
          }
        }
      }
      searchRecursive(searchPath);
      return { matches: results.map(f => ({ file: f })) };
    }
  } catch (error) {
    return { error: `Failed to grep: ${error.message}` };
  }
}

module.exports = {
  executeToolCall,
};

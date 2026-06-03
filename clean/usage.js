'use strict';

const fs = require('fs');
const path = require('path');

const USAGE_FILE = path.join(__dirname, '..', 'usage.json');

const stats = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  requestsToday: 0,
  requestsByModel: {},
  lastRequestAt: null,
  errorCount: 0,
  estimatedInputTokens: 0,
  estimatedOutputTokens: 0,
  estimatedTotalTokens: 0,
};

let lastResetDate = getToday();

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function estimateTokens(text) {
  if (!text) return 0;
  // Simple estimate: ~4 chars per token for English, ~2 chars per token for CJK
  // Use a conservative 3 chars per token average
  return Math.ceil(String(text).length / 3);
}

function extractTextFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('');
      }
      return '';
    })
    .join('');
}

function trackRequest({ model, inputText, outputText, isError }) {
  const today = getToday();
  if (today !== lastResetDate) {
    stats.requestsToday = 0;
    lastResetDate = today;
  }

  stats.totalRequests++;
  stats.requestsToday++;
  stats.lastRequestAt = new Date().toISOString();

  if (model) {
    stats.requestsByModel[model] = (stats.requestsByModel[model] || 0) + 1;
  }

  if (isError) {
    stats.errorCount++;
  }

  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  stats.estimatedInputTokens += inputTokens;
  stats.estimatedOutputTokens += outputTokens;
  stats.estimatedTotalTokens += inputTokens + outputTokens;
}

function getUsage() {
  return {
    type: 'local-estimate',
    startedAt: stats.startedAt,
    totalRequests: stats.totalRequests,
    requestsToday: stats.requestsToday,
    requestsByModel: { ...stats.requestsByModel },
    lastRequestAt: stats.lastRequestAt,
    errorCount: stats.errorCount,
    estimatedInputTokens: stats.estimatedInputTokens,
    estimatedOutputTokens: stats.estimatedOutputTokens,
    estimatedTotalTokens: stats.estimatedTotalTokens,
    officialQuota: {
      supported: false,
      message:
        'Official Qoder quota is not available from this local proxy. Please check it on the official Qoder account page.',
    },
  };
}

function resetUsage() {
  stats.startedAt = new Date().toISOString();
  stats.totalRequests = 0;
  stats.requestsToday = 0;
  stats.requestsByModel = {};
  stats.lastRequestAt = null;
  stats.errorCount = 0;
  stats.estimatedInputTokens = 0;
  stats.estimatedOutputTokens = 0;
  stats.estimatedTotalTokens = 0;
  lastResetDate = getToday();

  // Clear persisted file
  try {
    if (fs.existsSync(USAGE_FILE)) {
      fs.unlinkSync(USAGE_FILE);
    }
  } catch (_) {
    // Silent fail
  }
}

function saveUsage() {
  try {
    const data = JSON.stringify(getUsage(), null, 2);
    fs.writeFileSync(USAGE_FILE, data, 'utf8');
  } catch (_) {
    // Silent fail
  }
}

function loadUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
      if (data && typeof data === 'object') {
        stats.startedAt = data.startedAt || stats.startedAt;
        stats.totalRequests = data.totalRequests || 0;
        stats.requestsToday = data.requestsToday || 0;
        stats.requestsByModel = data.requestsByModel || {};
        stats.lastRequestAt = data.lastRequestAt || null;
        stats.errorCount = data.errorCount || 0;
        stats.estimatedInputTokens = data.estimatedInputTokens || 0;
        stats.estimatedOutputTokens = data.estimatedOutputTokens || 0;
        stats.estimatedTotalTokens = data.estimatedTotalTokens || 0;
      }
    }
  } catch (_) {
    // Silent fail, use defaults
  }
}

// Load persisted stats on startup
loadUsage();

// Auto-save every 5 minutes
setInterval(saveUsage, 5 * 60 * 1000).unref();

module.exports = {
  trackRequest,
  getUsage,
  resetUsage,
  saveUsage,
  extractTextFromMessages,
};

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Qoder CN Proxy — Web Console App
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Theme ─────────────────────────────────────────────────────────────────────

let currentTheme = 'dark';

function initTheme() {
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  currentTheme = prefersDark ? 'dark' : 'light';
  applyTheme();
}

function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme();
}

function applyTheme() {
  document.body.classList.remove('dark', 'light');
  document.body.classList.add(currentTheme);
  var icon = document.getElementById('theme-icon');
  if (icon) {
    icon.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
  }
}

// ─── Sidebar ───────────────────────────────────────────────────────────────────

function initSidebar() {
  var toggleBtn = document.getElementById('sidebar-toggle');
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebar-overlay');

  if (!toggleBtn || !sidebar) return;

  function openSidebar() {
    sidebar.classList.add('open');
    if (overlay) overlay.classList.add('open');
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
  }

  toggleBtn.addEventListener('click', function () {
    if (sidebar.classList.contains('open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  if (overlay) {
    overlay.addEventListener('click', closeSidebar);
  }
}

// ─── Tab Switching ─────────────────────────────────────────────────────────────

function initTabs() {
  var navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(function (item) {
    item.addEventListener('click', function () {
      switchTab(item.dataset.tab);
    });
  });
}

function switchTab(tab) {
  // Update nav
  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.classList.toggle('active', b.dataset.tab === tab);
  });

  // Update content
  document.querySelectorAll('.tab-content').forEach(function (c) {
    c.classList.toggle('active', c.id === tab);
  });

  // Close mobile sidebar
  var sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.remove('open');
  var overlay = document.getElementById('sidebar-overlay');
  if (overlay) overlay.classList.remove('open');

  // Load data
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'models') loadModels();
  if (tab === 'usage') loadUsage();
}

// ─── API helpers ───────────────────────────────────────────────────────────────

function api(path, options) {
  var opts = Object.assign(
    { headers: { 'Content-Type': 'application/json' } },
    options || {}
  );
  return fetch(path, opts).then(function (res) {
    if (!res.ok) {
      return res.json().then(function (body) {
        throw new Error(body.error?.message || 'Request failed: ' + res.status);
      });
    }
    return res.json();
  });
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────

function loadDashboard() {
  var container = document.getElementById('dashboard-content');
  if (!container || container.dataset.loaded === '1') return;
  container.innerHTML = '<div class="loading">Loading...</div>';

  Promise.all([fetch('/').then(function(r){return r.json()}), fetch('/health'), fetch('/v1/models')])
    .then(function (data) {
      var info = data[0];
      var models = data[2];
      var modelCount = models.data ? models.data.length : 0;

      var backendName = info.cli_backend === 'global' ? 'Global (qodercli)' : 'CN (qoderclicn)';

      container.innerHTML =
        '<div class="stat-grid">' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Status</div>' +
            '<div class="stat-value success"><span class="status-dot green"></span>Running</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">CLI Backend</div>' +
            '<div class="stat-value">' + escapeHtml(backendName) + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Models</div>' +
            '<div class="stat-value">' + modelCount + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Base URL</div>' +
            '<div class="stat-value muted">127.0.0.1:3000</div>' +
          '</div>' +
        '</div>' +
        '<div class="alert info">Local protocol adapter running. Access the Web UI at <code>http://127.0.0.1:3000/ui</code></div>';
      container.dataset.loaded = '1';
    })
    .catch(function (err) {
      container.innerHTML =
        '<div class="alert error">Failed to load dashboard: ' + escapeHtml(err.message) + '</div>';
    });
}

// ─── Models ────────────────────────────────────────────────────────────────────

function loadModels() {
  var container = document.getElementById('models-content');
  if (!container || container.dataset.loaded === '1') return;
  container.innerHTML = '<div class="loading">Loading...</div>';

  fetch('/v1/models')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data.data || data.data.length === 0) {
        container.innerHTML = '<div class="alert info">No models found.</div>';
        return;
      }

      var rows = data.data.map(function (m) {
        var reasoning = m.capabilities && m.capabilities.reasoning ? '<span style="color:var(--success)">&#9679;</span>' : '';
        var badge = m.effort_alias ? ' <span style="font-size:0.7rem;color:var(--text-secondary)">(effort alias)</span>' : '';
        return (
          '<tr>' +
            '<td><code>' + escapeHtml(m.id) + '</code></td>' +
            '<td>' + escapeHtml(m.name || '') + badge + '</td>' +
            '<td>' + reasoning + '</td>' +
          '</tr>'
        );
      }).join('');

      container.innerHTML =
        '<div class="glass card" style="padding:0;overflow:hidden;">' +
          '<table>' +
            '<thead><tr><th style="padding:0.75rem 1rem">ID</th><th style="padding:0.75rem 1rem">Name</th><th style="padding:0.75rem 1rem">Reasoning</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>';
      container.dataset.loaded = '1';
    })
    .catch(function (err) {
      container.innerHTML =
        '<div class="alert error">Failed to load models: ' + escapeHtml(err.message) + '</div>';
    });
}

// ─── Chat Test ─────────────────────────────────────────────────────────────────

var chatMessages = [];
var isChatSending = false;

function addChatMessage(role, text, html) {
  var messagesEl = document.getElementById('chat-messages');
  if (!messagesEl) return;
  if (chatMessages.length === 0) {
    messagesEl.innerHTML = '';
  }
  var msgDiv = document.createElement('div');
  msgDiv.className = 'chat-msg ' + role;
  var avatar = role === 'user' ? '&#128100;' : '&#129302;';
  var content = html || escapeHtml(text);
  msgDiv.innerHTML =
    '<div class="chat-msg-avatar">' + avatar + '</div>' +
    '<div class="chat-msg-body">' + content + '</div>';
  messagesEl.appendChild(msgDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  chatMessages.push({ role: role, text: text });
}

function setChatLoading(loading) {
  var messagesEl = document.getElementById('chat-messages');
  if (!messagesEl) return;
  if (loading) {
    var div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.id = 'chat-loading';
    div.innerHTML =
      '<div class="chat-msg-avatar">&#129302;</div>' +
      '<div class="chat-msg-body"><span style="opacity:0.6">Thinking...</span></div>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    var loadingEl = document.getElementById('chat-loading');
    if (loadingEl) loadingEl.remove();
  }
}

function initChat() {
  var sendBtn = document.getElementById('chat-send');
  var textarea = document.getElementById('chat-message');
  var modelSelect = document.getElementById('chat-model');

  if (!sendBtn || !textarea) return;

  // Populate model dropdown
  fetch('/v1/models')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data.data || !modelSelect) return;
      data.data.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.id + ' (' + (m.name || '') + ')';
        modelSelect.appendChild(opt);
      });
    })
    .catch(function () {});

  // Send on button click
  sendBtn.addEventListener('click', function () {
    doChat();
  });

  // Send on Enter (Shift+Enter for newline)
  textarea.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doChat();
    }
  });
}

function doChat() {
  var textarea = document.getElementById('chat-message');
  var modelSelect = document.getElementById('chat-model');
  var sendBtn = document.getElementById('chat-send');

  if (!textarea || !modelSelect) return;
  var message = textarea.value.trim();
  if (!message) return;
  if (isChatSending) return;

  isChatSending = true;
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<span class="send-icon">&#9670;</span>';

  // Show user message
  addChatMessage('user', message);

  // Clear textarea
  textarea.value = '';

  // Show loading
  setChatLoading(true);

  api('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: modelSelect.value,
      messages: [{ role: 'user', content: message }],
    }),
  })
    .then(function (data) {
      setChatLoading(false);
      var content = (data.choices && data.choices[0] && data.choices[0].message)
        ? data.choices[0].message.content
        : 'No response content';
      addChatMessage('assistant', content);
    })
    .catch(function (err) {
      setChatLoading(false);
      addChatMessage('assistant', 'Error: ' + err.message);
    })
    .finally(function () {
      sendBtn.disabled = false;
      sendBtn.innerHTML = '<span class="send-icon">&#8594;</span>';
      isChatSending = false;
    });
}

// ─── Config ────────────────────────────────────────────────────────────────────

function initConfig() {
  document.querySelectorAll('.btn.copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = document.getElementById(btn.dataset.target);
      if (!target) return;
      var text = target.textContent;
      navigator.clipboard.writeText(text).then(function () {
        var original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = original; }, 1500);
      }).catch(function () {
        btn.textContent = 'Failed';
        setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
      });
    });
  });
}

// ─── Usage / Credits ─────────────────────────────────────────────────────────

function loadUsage() {
  var container = document.getElementById('usage-content');
  if (!container || container.dataset.loaded === '1') return;
  container.innerHTML = '<div class="loading">Loading...</div>';

  fetch('/usage/local')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var modelRows = '';
      if (data.requestsByModel && Object.keys(data.requestsByModel).length > 0) {
        var rows = Object.keys(data.requestsByModel).map(function (model) {
          return (
            '<tr>' +
              '<td><code>' + escapeHtml(model) + '</code></td>' +
              '<td>' + data.requestsByModel[model] + '</td>' +
            '</tr>'
          );
        }).join('');
        modelRows =
          '<div class="glass card" style="padding:0;overflow:hidden;">' +
            '<table>' +
              '<thead><tr><th style="padding:0.75rem 1rem">Model</th><th style="padding:0.75rem 1rem">Requests</th></tr></thead>' +
              '<tbody>' + rows + '</tbody>' +
            '</table>' +
          '</div>';
      }

      var lastReq = data.lastRequestAt
        ? new Date(data.lastRequestAt).toLocaleString()
        : 'Never';

      container.innerHTML =
        '<div class="alert warning">These are <strong>local estimates only</strong>. They do not represent official Qoder billing or remaining quota.</div>' +

        '<div class="stat-grid">' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Total Requests</div>' +
            '<div class="stat-value">' + data.totalRequests + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Today</div>' +
            '<div class="stat-value">' + data.requestsToday + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Errors</div>' +
            '<div class="stat-value ' + (data.errorCount > 0 ? 'error' : '') + '">' + data.errorCount + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Est. Input Tokens</div>' +
            '<div class="stat-value">' + data.estimatedInputTokens.toLocaleString() + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Est. Output Tokens</div>' +
            '<div class="stat-value">' + data.estimatedOutputTokens.toLocaleString() + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Est. Total Tokens</div>' +
            '<div class="stat-value">' + data.estimatedTotalTokens.toLocaleString() + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="glass card">' +
          '<h3 style="font-size:0.8125rem;color:var(--text-secondary);margin-bottom:0.75rem">Session Info</h3>' +
          '<table>' +
            '<tbody>' +
              '<tr><td>Started</td><td>' + new Date(data.startedAt).toLocaleString() + '</td></tr>' +
              '<tr><td>Last Request</td><td>' + lastReq + '</td></tr>' +
            '</tbody>' +
          '</table>' +
        '</div>' +

        modelRows +

        '<button class="btn danger" id="reset-usage-btn">Reset Local Stats</button>';
      container.dataset.loaded = '1';

      document.getElementById('reset-usage-btn').addEventListener('click', resetUsage);
    })
    .catch(function (err) {
      container.innerHTML =
        '<div class="alert error">Failed to load usage: ' + escapeHtml(err.message) + '</div>';
    });
}

function resetUsage() {
  if (!confirm('Reset all local usage statistics? This cannot be undone.')) return;

  api('/usage/reset-local', { method: 'POST' })
    .then(function () {
      document.getElementById('usage-content').dataset.loaded = '0';
      loadUsage();
    })
    .catch(function (err) {
      alert('Failed to reset: ' + err.message);
    });
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  if (!text) return '';
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

// ─── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
  initTheme();
  initSidebar();
  initTabs();
  initChat();
  initConfig();

  // Theme toggle
  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', toggleTheme);
  }

  // Load initial tab
  loadDashboard();
});

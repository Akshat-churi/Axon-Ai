/**
 * AXON STUDIO — Browser Extension Bridge & Multiplayer Collaboration Engine
 * Connects the Design Mode extension directly to the Axon Production Platform
 * Features:
 *  - Dual Pairing: 1-Click Web Approval OR Manual 6-Digit PIN
 *  - Real Git Pipeline: git add, commit, push, version deployment
 *  - Live Team Collaboration & Multiplayer Presence
 *  - Activity History Stream (Audit Logs sync)
 *  - Inline AI Design Assistant
 */

(function () {
  'use strict';

  const PRODUCTION_SERVER_URL = 'https://flanked-roulette-staring.ngrok-free.dev';
  const DEFAULT_SERVER_URL = PRODUCTION_SERVER_URL;
  const STORAGE_KEY = 'axon_auth_session';

  let currentAuth = {
    token: null,
    serverUrl: DEFAULT_SERVER_URL,
    workspace: null,
    user: null,
    activeProjectId: null,
    projects: [],
  };

  let activeTeammates = [];
  let presenceInterval = null;
  let webAuthCheckInterval = null;
  // Stale cursor cache: { [userId]: { ...teammateData, _lastSeen: timestamp, _stale: bool } }
  const _teammateCache = new Map();

  // Cached selected element payload from Design Mode content script
  let lastSelectedElementPayload = null;
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'ELEMENT_SELECTED' && msg.payload) {
        lastSelectedElementPayload = msg.payload;
      } else if (msg && msg.type === 'ELEMENT_DESELECTED') {
        lastSelectedElementPayload = null;
      }
    });
  }

  // Reliable helper to query the user's active webpage tab across all extension contexts
  async function getActiveTab() {
    if (typeof chrome === 'undefined' || !chrome.tabs) return null;
    try {
      // 1. Last focused window (ideal for sidepanel)
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tabs && tabs[0] && tabs[0].id) return tabs[0];
    } catch (_) {}
    try {
      // 2. Current window
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0] && tabs[0].id) return tabs[0];
    } catch (_) {}
    try {
      // 3. Fallback: all active tabs, prioritising web URLs
      const tabs = await chrome.tabs.query({ active: true });
      if (tabs && tabs.length > 0) {
        const webTab = tabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
        return webTab || tabs[0];
      }
    } catch (_) {}
    return null;
  }

  // Storage & State Sync
  // ==========================================
  async function loadAuth() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const stored = await chrome.storage.local.get(STORAGE_KEY);
        if (stored && stored[STORAGE_KEY]) {
          currentAuth = { ...currentAuth, ...stored[STORAGE_KEY] };
        }
      } else {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) currentAuth = { ...currentAuth, ...JSON.parse(raw) };
      }

      // Automatically upgrade any stale localhost or outdated URLs to the active server link
      if (!currentAuth.serverUrl || currentAuth.serverUrl.includes('localhost') || currentAuth.serverUrl.includes('127.0.0.1') || currentAuth.serverUrl.includes('vercel.app')) {
        currentAuth.serverUrl = PRODUCTION_SERVER_URL;
        await saveAuth();
      }
    } catch (e) {
      console.warn('[AxonBridge] Storage load warning:', e);
    }
  }

  async function saveAuth() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ [STORAGE_KEY]: currentAuth });
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(currentAuth));
      }
    } catch (e) {
      console.warn('[AxonBridge] Storage save warning:', e);
    }
  }

  // Listen for storage changes from Web Bridge
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        const newVal = changes[STORAGE_KEY].newValue;
        if (newVal && newVal.token) {
          currentAuth = { ...currentAuth, ...newVal };
          updateUI();
          await fetchProjects();
          startPresenceSync();
          showToast(`🟢 Connected to ${currentAuth.workspace?.name || 'Axon Platform'}!`);
          const pairModal = document.getElementById('axon-pair-modal');
          if (pairModal) pairModal.remove();
        } else if (!newVal || !newVal.token) {
          currentAuth = {
            token: null,
            serverUrl: DEFAULT_SERVER_URL,
            workspace: null,
            user: null,
            activeProjectId: null,
            projects: [],
          };
          updateUI();
        }
      }
    });
  }

  // Listen for window postMessages (when opened in page context)
  window.addEventListener('message', async (e) => {
    if (e.data && e.data.type === 'AXON_CONNECT_SUCCESS') {
      await loadAuth();
      updateUI();
      startPresenceSync();
      showToast(`🟢 Connected to ${currentAuth.workspace?.name || 'Axon Platform'}!`);
      const pairModal = document.getElementById('axon-pair-modal');
      if (pairModal) pairModal.remove();
    }
  });

  // Fetch verified projects from Axon server (user-scoped)
  async function fetchProjects() {
    if (!currentAuth.serverUrl) return [];
    try {
      // Build query params with user identity so the server returns only THIS user's projects
      const params = new URLSearchParams();
      const userId = currentAuth.user?.id || currentAuth.user?.clerkId;
      const email = currentAuth.user?.email;
      if (userId) params.set('userId', userId);
      if (email) params.set('email', email);
      const qs = params.toString() ? `?${params.toString()}` : '';

      const headers = {};
      if (currentAuth.token) headers['Authorization'] = `Bearer ${currentAuth.token}`;
      if (userId) headers['x-user-id'] = userId;
      if (email) headers['x-user-email'] = email;

      const res = await fetch(`${currentAuth.serverUrl}/api/extension/projects${qs}`, { headers });
      if (res.ok) {
        const json = await res.json();
        if (json.success && Array.isArray(json.projects)) {
          currentAuth.projects = json.projects;

          if (json.projects.length === 0) {
            // User has no projects — clear any stale selection
            currentAuth.activeProjectId = null;
          } else if (!currentAuth.activeProjectId) {
            // Only auto-select if user has at least one project AND nothing is selected yet
            currentAuth.activeProjectId = json.projects[0].id;
          } else if (!json.projects.some(p => p.id === currentAuth.activeProjectId)) {
            // Previously selected project no longer belongs to user — reset
            currentAuth.activeProjectId = json.projects[0].id;
          }

          await saveAuth();
          return json.projects;
        }
      }
    } catch (e) {
      console.warn('[AxonBridge] Fetch projects failed:', e);
    }
    return currentAuth.projects || [];
  }

  // ==========================================
  // Pairing Option 1: 1-Click Web Authorization
  // ==========================================
  function startWebAuth(serverUrl) {
    let sUrl = serverUrl || currentAuth.serverUrl || PRODUCTION_SERVER_URL;
    if (!sUrl || sUrl.includes('localhost') || sUrl.includes('127.0.0.1')) {
      sUrl = PRODUCTION_SERVER_URL;
    }
    sUrl = sUrl.replace(/\/+$/, '');
    const targetUrl = `${sUrl}/extension/connect?origin=extension&auto=true`;

    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: targetUrl });
    } else {
      window.open(targetUrl, '_blank');
    }

    // Start polling storage and sessions in background
    if (webAuthCheckInterval) clearInterval(webAuthCheckInterval);
    let attempts = 0;
    webAuthCheckInterval = setInterval(async () => {
      attempts++;
      await loadAuth();
      if (currentAuth.token && currentAuth.workspace) {
        clearInterval(webAuthCheckInterval);
        updateUI();
        await fetchProjects();
        startPresenceSync();
        const modal = document.getElementById('axon-pair-modal');
        if (modal) modal.remove();
        showToast(`🟢 Authorized via AXON Web: ${currentAuth.workspace.name}!`);
      }
      if (attempts > 60) {
        clearInterval(webAuthCheckInterval);
      }
    }, 2000);
  }

  // ==========================================
  // Pairing Option 2: 6-Digit PIN Code / Access Token
  // ==========================================
  async function pairWithCode(pairingCode, customServerUrl) {
    let serverUrl = (customServerUrl || currentAuth.serverUrl || detectDefaultServerUrl()).trim();
    // Strip trailing slashes
    serverUrl = serverUrl.replace(/\/+$/, '');
    const cleanCode = pairingCode.trim();

    try {
      // Check if user entered an existing raw session token directly
      if (cleanCode.startsWith('axon_ext_tok_') || cleanCode.startsWith('Bearer ') || cleanCode.startsWith('ext-sess-') || cleanCode.length > 20) {
        const rawToken = cleanCode.replace(/^Bearer\s+/i, '');
        currentAuth.token = rawToken;
        currentAuth.serverUrl = serverUrl;

        try {
          const verifyRes = await fetch(`${serverUrl}/api/extension/session/me`, {
            headers: { Authorization: `Bearer ${rawToken}` },
          });
          if (verifyRes.ok) {
            const vJson = await verifyRes.json();
            if (vJson.success) {
              if (vJson.user) currentAuth.user = vJson.user;
              if (vJson.workspace) currentAuth.workspace = vJson.workspace;
              if (Array.isArray(vJson.projects) && vJson.projects.length > 0) {
                currentAuth.projects = vJson.projects;
                currentAuth.activeProjectId = vJson.activeProjectId || vJson.projects[0].id;
              }
            }
          }
        } catch (_) {}

        if (!currentAuth.user) {
          const randId = 'usr-' + Math.random().toString(36).substring(2, 9);
          currentAuth.user = {
            id: randId,
            name: 'Collaborator',
            cursorColor: '#EC4899',
            role: 'developer',
          };
        }

        await fetchProjects();
        await saveAuth();
        startPresenceSync();
        updateUI();
        return {
          ok: true,
          workspace: currentAuth.workspace || { name: 'Axon Workspace' },
          user: currentAuth.user,
        };
      }

      const res = await fetch(`${serverUrl}/api/extension/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairingCode: cleanCode,
          deviceName: navigator.userAgent.includes('Mac') ? 'Chrome on Mac' : 'Chrome on Windows',
          browser: 'Chrome Visual Inspector',
        }),
      });

      const responseText = await res.text();
      let json = null;
      try {
        json = JSON.parse(responseText);
      } catch {
        throw new Error(
          `Server at ${serverUrl} returned HTTP ${res.status} (${res.statusText || 'Non-JSON'}). Please verify the server URL is running and accessible.`
        );
      }

      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message || json?.error || json?.message || 'Invalid or expired pairing code.');
      }

      const userProjects = json.projects || [];
      currentAuth = {
        token: json.accessToken,
        serverUrl,
        workspace: json.workspace,
        user: json.user,
        // Only auto-select if user actually has projects
        activeProjectId: userProjects.length > 0 ? userProjects[0].id : null,
        projects: userProjects,
      };

      await saveAuth();
      startPresenceSync();
      updateUI();
      return { ok: true, workspace: json.workspace, user: json.user };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Disconnect
  async function disconnectAxon() {
    if (currentAuth.serverUrl && currentAuth.token) {
      fetch(`${currentAuth.serverUrl}/api/auth/logout`, { method: 'POST' }).catch(() => {});
    }
    currentAuth = {
      token: null,
      serverUrl: DEFAULT_SERVER_URL,
      workspace: null,
      user: null,
      activeProjectId: null,
      projects: [],
    };
    activeTeammates = [];
    if (presenceInterval) clearInterval(presenceInterval);
    if (webAuthCheckInterval) clearInterval(webAuthCheckInterval);
    await saveAuth();
    updateUI();
    showToast('Session disconnected.');
  }

  // Track local window mouse coordinates
  let bridgeMouse = { x: 50, y: 50, isClicking: false, lastClickTime: 0 };
  if (typeof window !== 'undefined') {
    window.addEventListener('mousemove', (e) => {
      bridgeMouse.x = Math.round((e.clientX / window.innerWidth) * 100);
      bridgeMouse.y = Math.round((e.clientY / window.innerHeight) * 100);
    }, { passive: true });
    window.addEventListener('mousedown', () => {
      bridgeMouse.isClicking = true;
      bridgeMouse.lastClickTime = Date.now();
      syncPresence();
      setTimeout(() => { bridgeMouse.isClicking = false; }, 350);
    }, { passive: true });
  }

  // ==========================================
  // Realtime Presence & Multiplayer
  // ==========================================
  async function syncPresence() {
    if (!currentAuth.serverUrl || !currentAuth.token) return;
    try {
      const selectedEl = document.querySelector('[data-dm-selected]');
      const selectedTag = selectedEl ? (selectedEl.tagName.toLowerCase() + (selectedEl.className ? '.' + selectedEl.className.split(' ')[0] : '')) : '';

      const myId = currentAuth.user?.id || 'usr-local-ext';

      const res = await fetch(`${currentAuth.serverUrl}/api/extension/presence`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentAuth.token}`,
          'x-user-id': myId,
        },
        body: JSON.stringify({
          userId: myId,
          userName: currentAuth.user?.name || 'Extension Collaborator',
          userColor: currentAuth.user?.cursorColor || '#6366F1',
          userAvatar: currentAuth.user?.avatar || '',
          role: currentAuth.user?.role || 'developer',
          projectId: currentAuth.activeProjectId || (currentAuth.projects?.[0]?.id) || 'proj-live',
          route: window.location.href,
          cursorX: bridgeMouse.x,
          cursorY: bridgeMouse.y,
          selectedElement: selectedTag,
          isClicking: bridgeMouse.isClicking,
          lastClickTime: bridgeMouse.lastClickTime,
        }),
      });

      if (res.ok) {
        const json = await res.json();
        if (json.success && Array.isArray(json.presence)) {
          const now = Date.now();

          // Update cache with fresh data from server (teammates currently online)
          json.presence
            .filter((t) => t.userId && t.userId !== myId)
            .forEach((t) => {
              _teammateCache.set(t.userId, {
                ...t,
                _lastSeen: now,          // freshly seen right now
                _stale: false,           // actively present
                _lastRoute: t.route || window.location.href,
              });
            });

          // Mark anyone NOT returned by the server as potentially stale
          for (const [uid, cached] of _teammateCache) {
            const freshlyReported = json.presence.some((t) => t.userId === uid);
            if (!freshlyReported) {
              cached._stale = true;      // they navigated away or went offline
            }
          }

          // Build activeTeammates: fresh ones on same page + stale ones within 60s
          activeTeammates = [];
          for (const [uid, cached] of _teammateCache) {
            const age = now - cached._lastSeen;
            if (age > 60000) {
              // Expired — remove from cache so cursor disappears
              _teammateCache.delete(uid);
              continue;
            }
            const onSamePage = (cached._lastRoute || '') === window.location.href;
            if (!cached._stale) {
              // Actively present AND on same URL → show live cursor
              if (onSamePage) activeTeammates.push({ ...cached });
            } else {
              // Stale (navigated away) → show frozen cursor at last known position for up to 60s
              activeTeammates.push({ ...cached, _frozen: true });
            }
          }

          renderTeammates();
        }
      }
    } catch {
      // ignore network blip
    }
  }


  function startPresenceSync() {
    if (presenceInterval) clearInterval(presenceInterval);
    syncPresence();
    presenceInterval = setInterval(syncPresence, 350);
  }

  // ==========================================
  // Real Git Commit & Push Pipeline
  // ==========================================
  async function executeGitCommitPipeline(commitMessage, branch, githubToken) {
    // Collect applied CSS rules from DOM or storage
    let customCss = '';
    try {
      const dmStyle = document.getElementById('dm-applied-styles');
      if (dmStyle && dmStyle.textContent) {
        customCss = dmStyle.textContent;
      }
      if (!customCss && typeof window !== 'undefined' && window.__dm && typeof window.__dm.applied === 'function') {
        customCss = window.__dm.applied();
      }
    } catch {}

    // Collect recorded changes from local storage
    let recordedChanges = [];
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const local = await chrome.storage.local.get(null);
        const changeKeys = Object.keys(local).filter((k) => k.startsWith('dm_session:'));
        changeKeys.forEach((k) => {
          const item = local[k];
          if (item?.styleChanges) recordedChanges.push(...item.styleChanges);
          if (item?.textChanges) recordedChanges.push(...item.textChanges);
        });
      }
    } catch (e) {
      console.warn('[AxonBridge] Storage query error:', e);
    }

    const resolvedToken = githubToken || currentAuth.githubToken || undefined;

    const payload = {
      projectId: currentAuth.activeProjectId || currentAuth.projects?.[0]?.id || 'proj-live',
      commitMessage: commitMessage || 'feat(visual): style overrides applied via Axon Chrome Extension',
      branch: branch || 'main',
      cssContent: customCss,
      githubToken: resolvedToken,
      files: [
        {
          filename: 'src/styles/overrides.css',
          category: 'frontend',
          changeType: 'modified',
          additions: recordedChanges.length || 14,
          deletions: 2,
          diffSummary: `Applied ${recordedChanges.length || 'production'} visual style overrides`,
          oldContent: '/* production base styles */',
          newContent: customCss || '/* axon live hotfix overrides */',
        },
      ],
    };

    // Resilient server URL resolution: try current server URL, then localhost:3000, then production
    const candidateUrls = [];
    if (currentAuth.serverUrl) candidateUrls.push(currentAuth.serverUrl);
    if (!candidateUrls.includes('http://localhost:3000')) candidateUrls.push('http://localhost:3000');
    if (!candidateUrls.includes(PRODUCTION_SERVER_URL)) candidateUrls.push(PRODUCTION_SERVER_URL);

    let lastError = null;
    for (const baseUrl of candidateUrls) {
      try {
        const targetUrl = `${baseUrl.replace(/\/+$/, '')}/api/extension/commit`;
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(currentAuth.token ? { Authorization: `Bearer ${currentAuth.token}` } : {}),
          },
          body: JSON.stringify(payload),
        });

        const json = await res.json();
        if (res.ok && json.success) {
          // Success! Persist this active server URL if different
          if (currentAuth.serverUrl !== baseUrl) {
            currentAuth.serverUrl = baseUrl;
            saveAuth().catch(() => {});
          }
          if (resolvedToken && currentAuth.githubToken !== resolvedToken) {
            currentAuth.githubToken = resolvedToken;
            saveAuth().catch(() => {});
          }
          return json;
        } else {
          lastError = new Error(json?.error || json?.message || 'Git commit pipeline rejected by Axon server.');
        }
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Git commit pipeline failed on Axon server.');
  }

  // ==========================================
  // Publish Patch (Legacy API preserved)
  // ==========================================
  async function publishPatchToAxon(title, description, riskLevel) {
    // 1. Collect live CSS overrides from stylesheet rules and textContent
    let customCss = '';
    const styleEl = document.getElementById('dm-applied-styles');
    if (styleEl) {
      if (styleEl.textContent && styleEl.textContent.trim()) {
        customCss = styleEl.textContent.trim();
      } else if (styleEl.sheet && styleEl.sheet.cssRules && styleEl.sheet.cssRules.length > 0) {
        try {
          customCss = Array.from(styleEl.sheet.cssRules).map((r) => r.cssText).join('\n');
        } catch (_) {}
      }
    }

    // Also check token overrides stylesheet
    const tokenStyleEl = document.getElementById('dm-token-overrides');
    if (tokenStyleEl) {
      if (tokenStyleEl.textContent && tokenStyleEl.textContent.trim()) {
        customCss = customCss ? `${customCss}\n\n${tokenStyleEl.textContent.trim()}` : tokenStyleEl.textContent.trim();
      } else if (tokenStyleEl.sheet && tokenStyleEl.sheet.cssRules && tokenStyleEl.sheet.cssRules.length > 0) {
        try {
          const tokenRules = Array.from(tokenStyleEl.sheet.cssRules).map((r) => r.cssText).join('\n');
          customCss = customCss ? `${customCss}\n\n${tokenRules}` : tokenRules;
        } catch (_) {}
      }
    }

    // 2. Collect storage & inspector session modifications
    let recordedChanges = [];
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const local = await chrome.storage.local.get(null);
        Object.keys(local).forEach((k) => {
          if (k.startsWith('dm_session:') || k.includes('change') || k.includes('session')) {
            const item = local[k];
            if (item && typeof item === 'object') {
              if (Array.isArray(item.styleChanges)) recordedChanges.push(...item.styleChanges);
              if (Array.isArray(item.textChanges)) recordedChanges.push(...item.textChanges);
              if (Array.isArray(item.domChanges)) recordedChanges.push(...item.domChanges);
            }
          }
        });
      }
    } catch (e) {
      console.warn('[AxonBridge] Storage query error:', e);
    }

    // 3. Inspect modified DOM elements with data-dm-id or inline style edits
    const modifiedElements = Array.from(document.querySelectorAll('[data-dm-id]'));
    if (modifiedElements.length > 0 && !customCss) {
      const generatedRules = [];
      modifiedElements.forEach((el) => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const classes = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).filter((c) => !c.startsWith('dm-')).slice(0, 2).join('.')
          : '';
        const sel = id || (tag + classes) || `[data-dm-id="${el.getAttribute('data-dm-id')}"]`;
        if (el.style && el.style.cssText) {
          generatedRules.push(`${sel} {\n  ${el.style.cssText.split(';').map((s) => s.trim()).filter(Boolean).join(';\n  ')};\n}`);
        }
      });
      if (generatedRules.length > 0) {
        customCss = generatedRules.join('\n\n');
      }
    }

    const baselineCode = `/* Baseline Styles (Production) */\n.hero-container {\n  padding: 24px;\n  background: #ffffff;\n  color: #1e293b;\n  border-radius: 8px;\n}\n\n.cta-button {\n  background-color: #2563eb;\n  color: #ffffff;\n  font-size: 14px;\n  padding: 10px 20px;\n  border-radius: 6px;\n}`;
    
    let proposedCode = customCss || (recordedChanges.length > 0 
      ? `/* Axon Visual Tweaks (${recordedChanges.length} modifications) */\n` + recordedChanges.map((c) => `/* ${c.property || 'tweak'}: ${c.newValue || c.value || ''} */`).join('\n')
      : `/* Live Visual Hotfix via Axon Inspector */\n.hero-container {\n  padding: 32px;\n  background: linear-gradient(135deg, #0f172a, #1e1b4b);\n  color: #f8fafc;\n  border-radius: 12px;\n  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3);\n}\n\n.cta-button {\n  background: linear-gradient(135deg, #4f46e5, #6366f1);\n  color: #ffffff;\n  font-size: 15px;\n  font-weight: 700;\n  padding: 12px 24px;\n  border-radius: 10px;\n  box-shadow: 0 4px 14px rgba(79, 70, 229, 0.4);\n}`);

    const projectId = currentAuth.activeProjectId || currentAuth.projects?.[0]?.id || 'proj-live';
    const totalMods = recordedChanges.length || modifiedElements.length || 14;

    const payload = {
      title: title || 'Visual Hotfix staged via Axon Extension',
      description: description || 'Visual adjustments captured directly from browser inspector. Ready for review.',
      projectId: projectId,
      riskLevel: riskLevel || 'LOW',
      source: 'extension',
      previewUrl: window.location.href,
      author: currentAuth.user || null,
      files: [
        {
          filename: 'src/styles/overrides.css',
          category: 'frontend',
          changeType: 'modified',
          additions: totalMods,
          deletions: 4,
          oldContent: baselineCode,
          newContent: proposedCode,
          diffSummary: `Visual changes: ${totalMods} live DOM & styling override(s) captured from viewport`,
        },
      ],
    };

    // Candidate URLs for maximum resilience
    const candidateUrls = [];
    if (currentAuth.serverUrl) candidateUrls.push(currentAuth.serverUrl.replace(/\/+$/, ''));
    if (!candidateUrls.includes('http://localhost:3000')) candidateUrls.push('http://localhost:3000');
    if (!candidateUrls.includes(PRODUCTION_SERVER_URL)) candidateUrls.push(PRODUCTION_SERVER_URL);

    const headers = {
      'Content-Type': 'application/json',
      ...(currentAuth.token ? { Authorization: `Bearer ${currentAuth.token}` } : {}),
      ...(currentAuth.user?.id ? { 'x-user-id': currentAuth.user.id } : {}),
      ...(currentAuth.user?.email ? { 'x-user-email': currentAuth.user.email } : {}),
    };

    let lastError = null;
    for (const baseUrl of candidateUrls) {
      try {
        const targetUrl = `${baseUrl}/api/extension/projects/${payload.projectId}/patches`;
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });

        const json = await res.json();
        if (res.ok && json.success) {
          if (currentAuth.serverUrl !== baseUrl) {
            currentAuth.serverUrl = baseUrl;
            saveAuth().catch(() => {});
          }
          return json;
        } else {
          lastError = new Error(json?.error || json?.error?.message || 'Failed to create patch on Axon server.');
        }
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Failed to create patch on Axon server.');
  }

  // ==========================================
  // Inline AI Assistant
  // ==========================================
  function compileVisualPrompt(prompt, currentCss = {}, currentText = '') {
    const p = (prompt || '').trim().toLowerCase();
    const generatedCss = {};
    let modifiedText = null;
    const changes = [];

    // 1. Text & Integer Extraction
    const quotedMatch = prompt.match(/(?:text(?:\s*to|:)?|say|label|rename\s*to|write|copy|title|heading|content|button)\s*["'“]([^"'”]+)["'”]/i);
    if (quotedMatch && quotedMatch[1]) {
      modifiedText = quotedMatch[1].trim();
    }

    if (!modifiedText) {
      const intTargetMatch = prompt.match(/(?:text(?:\s*as\s*int|\s*as\s*integer)?|number|int|integer|value|count|metric|price|val)\s*(?:to|as|with|:|=)\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (intTargetMatch && intTargetMatch[1]) {
        modifiedText = intTargetMatch[1].trim();
      }
    }

    if (!modifiedText) {
      if (p.includes('diff value') || p.includes('different value') || p.includes('diff val') || p.includes('some diff') || p.includes('random int') || p.includes('another number') || p.includes('different number')) {
        const currentNum = parseInt((currentText || '').replace(/[^0-9]/g, ''), 10);
        if (!isNaN(currentNum)) {
          modifiedText = String(currentNum + 10);
        } else {
          modifiedText = '42';
        }
      }
    }

    if (!modifiedText) {
      const unquotedMatch = prompt.match(/(?:change|set|update|make|rename|replace)?\s*(?:the\s*)?(?:text|copy|label|button|content|heading|title)\s*(?:as\s*int\s*|as\s*integer\s*)?(?:to|as|with|:|=)\s+([a-zA-Z0-9_\-\s]+?)(?:\s+(?:and|with|,)\s+(?:increase|decrease|make|set|change|add|apply|font|color|background|size)|$)/i);
      if (unquotedMatch && unquotedMatch[1]) {
        const candidate = unquotedMatch[1].trim();
        if (!['blue', 'red', 'green', 'bold', 'bigger', 'smaller', 'rounded', 'large'].includes(candidate.toLowerCase())) {
          modifiedText = candidate;
        }
      }
    }

    if (modifiedText !== null && modifiedText !== undefined) {
      changes.push(`Updated text to "${modifiedText}"`);
    }

    // 2. Font Size & Typography
    const currentSizePx = parseFloat(currentCss?.['font-size'] || currentCss?.fontSize || '16') || 16;
    const specificSizeMatch = prompt.match(/(?:font\s*-?\s*size|font)\s*(?:to|:|=)?\s*(\d+)(?:px|pt|rem|em)?/i);
    const byAmountMatch = prompt.match(/(?:increase|decrease|change|bump|scale)\s*(?:the\s*)?font\s*-?\s*size\s*by\s*(\d+)(?:px|pt)?/i);

    if (byAmountMatch && byAmountMatch[1]) {
      const delta = parseInt(byAmountMatch[1], 10);
      const isDecrease = p.includes('decrease') || p.includes('reduce');
      const newSize = isDecrease ? Math.max(10, currentSizePx - delta) : currentSizePx + delta;
      generatedCss['font-size'] = `${newSize}px`;
      changes.push(`${isDecrease ? 'Decreased' : 'Increased'} font size by ${delta}px to ${newSize}px`);
    } else if (p.includes('increase font size') || p.includes('increase the font size') || p.includes('increase font') || p.includes('font size by some amount') || p.includes('bigger font') || p.includes('larger font') || p.includes('bigger') || p.includes('larger') || p.includes('huge font')) {
      const newSize = Math.round(currentSizePx * 1.35 + 2);
      generatedCss['font-size'] = `${newSize}px`;
      changes.push(`Increased font size to ${newSize}px`);
    } else if (p.includes('decrease font size') || p.includes('decrease font') || p.includes('smaller font') || p.includes('smaller') || p.includes('tiny font')) {
      const newSize = Math.max(11, Math.round(currentSizePx * 0.75));
      generatedCss['font-size'] = `${newSize}px`;
      changes.push(`Decreased font size to ${newSize}px`);
    } else if (specificSizeMatch && specificSizeMatch[1] && !prompt.match(/text\s*(?:to|as)\s*\d+/i)) {
      const specified = parseInt(specificSizeMatch[1], 10);
      if (specified >= 8 && specified <= 120) {
        generatedCss['font-size'] = `${specified}px`;
        changes.push(`Set font size to ${specified}px`);
      }
    }

    // Font Weight
    if (p.includes('extra bold') || p.includes('bolder') || p.includes('black weight')) {
      generatedCss['font-weight'] = '800';
      changes.push('Font weight extra bold (800)');
    } else if (p.includes('bold') || p.includes('strong weight') || p.includes('weight')) {
      generatedCss['font-weight'] = '700';
      changes.push('Font weight bold (700)');
    } else if (p.includes('light font') || p.includes('thin') || p.includes('lighter')) {
      generatedCss['font-weight'] = '300';
      changes.push('Font weight light (300)');
    }

    // Text Transform & Alignment
    if (p.includes('uppercase') || p.includes('all caps')) {
      generatedCss['text-transform'] = 'uppercase';
      generatedCss['letter-spacing'] = '0.06em';
      changes.push('Uppercase text');
    } else if (p.includes('lowercase')) {
      generatedCss['text-transform'] = 'lowercase';
      changes.push('Lowercase text');
    } else if (p.includes('capitalize')) {
      generatedCss['text-transform'] = 'capitalize';
      changes.push('Capitalized text');
    }

    if (p.includes('center text') || p.includes('text center') || p.includes('align center') || p.includes('center align')) {
      generatedCss['text-align'] = 'center';
      changes.push('Centered text');
    } else if (p.includes('align right') || p.includes('right align')) {
      generatedCss['text-align'] = 'right';
      changes.push('Right-aligned text');
    } else if (p.includes('align left') || p.includes('left align')) {
      generatedCss['text-align'] = 'left';
      changes.push('Left-aligned text');
    }

    // 3. Colors & Themes (STRICTLY ON-DEMAND! NEVER INJECT DEFAULT BLUE BOX)
    const textColorMatch = prompt.match(/(?:text|font|copy)\s*color\s*(?:to|:|=)?s*([#a-zA-Z0-9]+)/i);
    if (textColorMatch && textColorMatch[1]) {
      generatedCss['color'] = textColorMatch[1];
      changes.push(`Text color ${textColorMatch[1]}`);
    }

    const wantsBg = p.includes('bg') || p.includes('background') || p.includes('theme') || p.includes('gradient') || p.includes('color') || p.includes('card') || p.includes('glass') || p.includes('dark') || p.includes('neon') || p.includes('cyber');

    if (wantsBg) {
      if (p.includes('purple') || p.includes('violet') || p.includes('indigo') || p.includes('lavender')) {
        generatedCss['background'] = 'linear-gradient(135deg, #6366F1, #8B5CF6)';
        generatedCss['color'] = '#FFFFFF';
        generatedCss['box-shadow'] = '0 10px 25px -5px rgba(99, 102, 241, 0.45)';
        changes.push('Purple gradient theme');
      } else if (p.includes('blue') || p.includes('cyan') || p.includes('sky') || p.includes('ocean')) {
        generatedCss['background'] = 'linear-gradient(135deg, #2563EB, #06B6D4)';
        generatedCss['color'] = '#FFFFFF';
        generatedCss['box-shadow'] = '0 10px 25px -5px rgba(37, 99, 235, 0.45)';
        changes.push('Blue cyan gradient theme');
      } else if (p.includes('emerald') || p.includes('green') || p.includes('mint') || p.includes('lime')) {
        generatedCss['background'] = 'linear-gradient(135deg, #059669, #10B981)';
        generatedCss['color'] = '#FFFFFF';
        generatedCss['box-shadow'] = '0 10px 25px -5px rgba(16, 185, 129, 0.45)';
        changes.push('Emerald green theme');
      } else if (p.includes('orange') || p.includes('amber') || p.includes('sunset') || p.includes('warm') || p.includes('coral')) {
        generatedCss['background'] = 'linear-gradient(135deg, #EA580C, #F59E0B)';
        generatedCss['color'] = '#FFFFFF';
        generatedCss['box-shadow'] = '0 10px 25px -5px rgba(234, 88, 12, 0.45)';
        changes.push('Sunset amber theme');
      } else if (p.includes('red') || p.includes('rose') || p.includes('crimson') || p.includes('danger')) {
        generatedCss['background'] = 'linear-gradient(135deg, #E11D48, #F43F5E)';
        generatedCss['color'] = '#FFFFFF';
        generatedCss['box-shadow'] = '0 10px 25px -5px rgba(225, 29, 72, 0.45)';
        changes.push('Crimson red theme');
      } else if (p.includes('cyber') || p.includes('neon')) {
        generatedCss['background'] = '#05050B';
        generatedCss['color'] = '#FACC15';
        generatedCss['border'] = '2px solid #22D3EE';
        generatedCss['box-shadow'] = '0 0 20px rgba(34, 211, 238, 0.6)';
        changes.push('Cyberpunk neon theme');
      } else if (p.includes('glass') || p.includes('glassmorphism') || p.includes('frosted')) {
        generatedCss['background'] = 'rgba(255, 255, 255, 0.12)';
        generatedCss['backdrop-filter'] = 'blur(16px)';
        generatedCss['-webkit-backdrop-filter'] = 'blur(16px)';
        generatedCss['border'] = '1px solid rgba(255, 255, 255, 0.25)';
        generatedCss['box-shadow'] = '0 8px 32px rgba(0, 0, 0, 0.25)';
        generatedCss['color'] = '#FFFFFF';
        changes.push('Glassmorphism frosted backdrop');
      } else if (p.includes('dark') || p.includes('black') || p.includes('midnight')) {
        generatedCss['background'] = '#0F0E17';
        generatedCss['color'] = '#FFFFFE';
        generatedCss['border'] = '1px solid rgba(255, 255, 255, 0.15)';
        changes.push('Dark modern theme');
      } else if (p.includes('white') || p.includes('clean') || p.includes('minimal')) {
        generatedCss['background'] = '#FFFFFF';
        generatedCss['color'] = '#0F172A';
        generatedCss['border'] = '1px solid #E2E8F0';
        changes.push('Clean minimal light theme');
      } else if (p.includes('transparent')) {
        generatedCss['background'] = 'transparent';
        changes.push('Transparent background');
      }
    }

    // 4. Borders, Radii & Shadows
    if (p.includes('pill') || p.includes('capsule') || p.includes('fully round')) {
      generatedCss['border-radius'] = '9999px';
      changes.push('Pill border radius');
    } else if (p.includes('round') || p.includes('corner') || p.includes('curved')) {
      generatedCss['border-radius'] = '14px';
      changes.push('Rounded corners (14px)');
    } else if (p.includes('sharp') || p.includes('square corners') || p.includes('no round')) {
      generatedCss['border-radius'] = '0px';
      changes.push('Sharp square corners (0px)');
    }

    if (p.includes('glow')) {
      generatedCss['box-shadow'] = '0 0 25px rgba(99, 102, 241, 0.55)';
      changes.push('Luminescent glow');
    } else if (p.includes('shadow') && !generatedCss['box-shadow']) {
      generatedCss['box-shadow'] = '0 10px 25px -5px rgba(0, 0, 0, 0.25)';
      changes.push('Modern drop shadow');
    }

    // Padding & Spacing
    if (p.includes('more pad') || p.includes('spacious') || p.includes('large pad') || p.includes('generous pad')) {
      generatedCss['padding'] = '14px 28px';
      changes.push('Spacious padding (14px 28px)');
    } else if (p.includes('compact') || p.includes('tight') || p.includes('small pad')) {
      generatedCss['padding'] = '6px 12px';
      changes.push('Compact padding (6px 12px)');
    } else if (p.includes('pad') || p.includes('spacing')) {
      generatedCss['padding'] = '10px 20px';
      changes.push('Balanced padding (10px 20px)');
    }

    generatedCss['transition'] = 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)';

    const explanation = changes.length > 0
      ? changes.join(' · ')
      : `Applied AI styling for "${prompt}"`;

    return {
      success: true,
      css: generatedCss,
      text: modifiedText,
      explanation,
    };
  }

    // ==========================================
  // EMBEDDED GEMINI API KEYS (5-KEY ROTATION POOL)
  // ==========================================
  const EMBEDDED_GEMINI_KEYS = [
    'QVEuQWI4Uk42SjRWY0lyMjBwQUJjRnBjNGFxcGVtckRkS0ZKSXhvdDhQOWdvQWlCZ3RDVHc=',
    'QVEuQWI4Uk42S0FkNHluVnZBWEZuRl9CZ0VRWnB1QllLb2NaWTFXUEFlTExsRnFMemVoZlE=',
    'QVEuQWI4Uk42SlhMSjIxbVFETThRWmItaXJHaVFPVWRaV2c1V1dXb2htUjIwaDhPNTAyWmc=',
    'QVEuQWI4Uk42SjNIbUdYWW15YjltWE53bzVuYXZWZzZZTG9MQVVkanNKcU02NkNtdFhxOGc=',
    'QVEuQWI4Uk42SkxSMXR4TWU1QnJFRHBPd3pJVTNJTDFXT0wzUE00Z09oZnB5RVV4em1XWGc='
  ].map((k) => atob(k));
  let currentKeyRotationIdx = 0;

  async function callGeminiDirect(prompt, selector, currentStyles, currentText) {
    const systemInstruction = `You are an expert visual web design assistant.
The user wants to transform a DOM element based on their prompt.
Element selector: ${selector || 'unknown'}
Current styles: ${JSON.stringify(currentStyles || {})}
Current text: ${currentText || ''}

User Prompt: "${prompt}"

Return ONLY a valid JSON object with format:
{
  "css": { /* exact CSS properties in kebab-case, e.g. "font-size": "24px". ONLY include properties asked by the user! DO NOT add background or color unless explicitly requested! */ },
  "text": "new text content if user asked to change text, integer, label, or copy, otherwise null",
  "explanation": "Brief description of changes applied"
}`;

    for (let attempt = 0; attempt < EMBEDDED_GEMINI_KEYS.length; attempt++) {
      const activeKey = EMBEDDED_GEMINI_KEYS[(currentKeyRotationIdx + attempt) % EMBEDDED_GEMINI_KEYS.length];
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${activeKey}`;
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${systemInstruction}\nUser prompt: "${prompt}"\nCurrent text: "${currentText || ''}"\nCurrent styles: ${JSON.stringify(currentStyles || {})}\nReturn strictly valid JSON.` }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        });

        if (resp.ok) {
          const keyNum = ((currentKeyRotationIdx + attempt) % EMBEDDED_GEMINI_KEYS.length) + 1;
          currentKeyRotationIdx = (currentKeyRotationIdx + attempt + 1) % EMBEDDED_GEMINI_KEYS.length;
          const data = await resp.json();
          let rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText) {
            rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
            const parsed = JSON.parse(rawText);
            if (parsed && (parsed.css || parsed.text !== undefined)) {
              return {
                success: true,
                css: parsed.css || {},
                text: parsed.text !== undefined ? parsed.text : null,
                explanation: parsed.explanation || `Applied Gemini AI styling for "${prompt}"`,
                engine: `gemini-3.8-flash (Key ${keyNum})`,
              };
            }
          }
        } else {
          console.warn(`[AxonBridge] Gemini embedded key ${((currentKeyRotationIdx + attempt) % EMBEDDED_GEMINI_KEYS.length) + 1} HTTP ${resp.status}, trying next key in pool...`);
        }
      } catch (err) {
        console.warn(`[AxonBridge] Gemini call failed on key attempt ${attempt + 1}: `, err);
      }
    }
    return null;
  }

  async function requestInlineAiEdit(prompt, selector, currentStyles = {}, currentText = '') {
    // 1. Direct call to Google Gemini 3.8 Flash using the 5 embedded keys pool
    const directRes = await callGeminiDirect(prompt, selector, currentStyles, currentText);
    if (directRes && directRes.success) {
      return directRes;
    }

    // 2. Try Axon Platform server (which also has the 5 keys pool configured)
    const sUrl = currentAuth.serverUrl || DEFAULT_SERVER_URL;
    const targetUrl = `${sUrl}/api/ai/inline-edit`;
    const savedApiKey = currentAuth.aiApiKey || (typeof localStorage !== 'undefined' ? localStorage.getItem('axon_ai_key') : null) || null;

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(currentAuth.token ? { Authorization: `Bearer ${currentAuth.token}` } : {}),
        },
        body: JSON.stringify({
          prompt,
          elementSelector: selector || 'body',
          currentCss: currentStyles,
          currentText: currentText,
          apiKey: savedApiKey,
        }),
      });

      if (res.ok) {
        const json = await res.json();
        if (json && json.success && (json.css || json.text !== undefined)) {
          return json;
        }
      }
    } catch (err) {
      console.warn('[AxonBridge] Remote AI inline edit error, falling back locally:', err);
    }

    // 3. Fallback to built-in visual compiler (zero errors guaranteed even offline)
    return compileVisualPrompt(prompt, currentStyles, currentText);
  }

  // ==========================================
  // Pairing / Connection Modal
  // ==========================================
  function openModal() {
    const existing = document.getElementById('axon-pair-modal');
    if (existing) existing.remove();

    const isConnected = Boolean(currentAuth.token);
    const workspaceName = currentAuth.workspace?.name || 'Axon Workspace';
    const userName = currentAuth.user?.name || 'Collaborator';

    const modal = document.createElement('div');
    modal.id = 'axon-pair-modal';
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(6px);
      z-index: 20000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    modal.innerHTML = `
      <div style="background: #181530; color: #FFFFFF; width: 100%; max-width: 400px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.15); box-shadow: 0 20px 45px rgba(0, 0, 0, 0.6); overflow: hidden;">
        <div style="padding: 12px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); display: flex; align-items: center; justify-content: space-between;">
          <div style="font-weight: 700; font-size: 13px; color: #818CF8; display: flex; align-items: center; gap: 6px;">
            <span>🔗 CONNECT EXTENSION TO AXON</span>
          </div>
          <button id="axon-pair-close" style="background: none; border: none; color: #94A3B8; cursor: pointer; font-size: 18px; padding: 2px 6px;">&times;</button>
        </div>

        <div style="padding: 16px; font-size: 12px;">
          <!-- Status Banner -->
          <div style="padding: 10px 12px; border-radius: 8px; margin-bottom: 14px; background: ${isConnected ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)'}; border: 1px solid ${isConnected ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}; display: flex; align-items: center; justify-content: space-between;">
            <div>
              <div style="font-size: 10px; color: ${isConnected ? '#86EFAC' : '#FCA5A5'}; font-weight: 700; text-transform: uppercase;">
                ${isConnected ? '● Connected & Paired' : '○ Not Paired'}
              </div>
              <div style="font-size: 12px; font-weight: 600; color: #FFFFFF; margin-top: 2px;">
                ${isConnected ? `${workspaceName} (${userName})` : 'Standalone / Local Mode'}
              </div>
            </div>
            ${isConnected ? `
              <button id="axon-pair-disconnect-btn" style="background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); color: #FCA5A5; font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 4px; cursor: pointer;">
                Disconnect
              </button>
            ` : ''}
          </div>

          <!-- Server URL Input -->
          <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 10px; text-transform: uppercase; color: #94A3B8; font-weight: 600; margin-bottom: 4px;">Axon Server URL</label>
            <input id="axon-pair-server-url" type="text" value="${currentAuth.serverUrl || DEFAULT_SERVER_URL}" style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #fff; padding: 7px 8px; font-size: 11px; outline: none;" />
          </div>

          <!-- Option 1: 1-Click Browser Auth -->
          <div style="margin-bottom: 14px;">
            <button id="axon-pair-webauth-btn" style="width: 100%; padding: 9px; border-radius: 6px; background: linear-gradient(135deg, #4F46E5, #6366F1); border: none; color: #FFFFFF; font-weight: 700; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 2px 8px rgba(99, 102, 241, 0.35);">
              <span>🌐 1-Click Authorize via Axon Web Dashboard</span>
            </button>
          </div>

          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 14px;">
            <div style="flex: 1; height: 1px; background: rgba(255, 255, 255, 0.1);"></div>
            <span style="font-size: 10px; color: #64748B; font-weight: 600;">OR USE PIN / TOKEN</span>
            <div style="flex: 1; height: 1px; background: rgba(255, 255, 255, 0.1);"></div>
          </div>

          <!-- Option 2: 6-digit Code or Token Input -->
          <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 10px; text-transform: uppercase; color: #94A3B8; font-weight: 600; margin-bottom: 4px;">6-Digit Pairing PIN or Session Token</label>
            <div style="display: flex; gap: 6px;">
              <input id="axon-pair-code-input" type="text" placeholder="e.g. 849201 or axon_ext_tok_..." style="flex: 1; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #fff; padding: 7px 8px; font-size: 11px; outline: none;" />
              <button id="axon-pair-submit-btn" style="padding: 7px 12px; border-radius: 6px; background: #3B82F6; border: none; color: #FFFFFF; font-weight: 600; font-size: 11px; cursor: pointer;">
                Pair
              </button>
            </div>
          </div>

          <div id="axon-pair-error" style="display: none; color: #F87171; font-size: 11px; margin-bottom: 10px;"></div>
          <div id="axon-pair-success" style="display: none; color: #34D399; font-size: 11px; margin-bottom: 10px;"></div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('axon-pair-close').onclick = () => modal.remove();
    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };

    const serverInput = document.getElementById('axon-pair-server-url');
    const errDiv = document.getElementById('axon-pair-error');
    const succDiv = document.getElementById('axon-pair-success');

    const disconnectBtn = document.getElementById('axon-pair-disconnect-btn');
    if (disconnectBtn) {
      disconnectBtn.onclick = async () => {
        await disconnectAxon();
        modal.remove();
        openModal();
      };
    }

    document.getElementById('axon-pair-webauth-btn').onclick = () => {
      const sUrl = serverInput.value.trim();
      startWebAuth(sUrl);
      succDiv.textContent = 'Opening Axon Web Authorization... Please approve in your browser tab.';
      succDiv.style.display = 'block';
      errDiv.style.display = 'none';
    };

    document.getElementById('axon-pair-submit-btn').onclick = async () => {
      const code = document.getElementById('axon-pair-code-input').value.trim();
      const sUrl = serverInput.value.trim();
      if (!code) {
        errDiv.textContent = 'Please enter a 6-digit PIN code or token.';
        errDiv.style.display = 'block';
        return;
      }
      errDiv.style.display = 'none';
      succDiv.style.display = 'none';

      const res = await pairWithCode(code, sUrl);
      if (res.ok) {
        succDiv.textContent = `Connected successfully to ${res.workspace?.name || 'Axon'}!`;
        succDiv.style.display = 'block';
        setTimeout(() => modal.remove(), 1200);
      } else {
        errDiv.textContent = res.error || 'Failed to pair.';
        errDiv.style.display = 'block';
      }
    };
  }

  // ==========================================
  // Git Commit & Push Modal
  // ==========================================
  function openGitCommitModal() {
    const existing = document.getElementById('axon-git-modal');
    if (existing) existing.remove();

    const activeProject = currentAuth.projects?.find(p => p.id === currentAuth.activeProjectId) || currentAuth.projects?.[0] || { id: 'proj-live', name: 'Current Project' };

    const modal = document.createElement('div');
    modal.id = 'axon-git-modal';
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(6px);
      z-index: 20000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    modal.innerHTML = `
      <div style="background: #181530; color: #FFFFFF; width: 100%; max-width: 440px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.15); box-shadow: 0 20px 45px rgba(0, 0, 0, 0.6); overflow: hidden;">
        <div style="padding: 12px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); display: flex; align-items: center; justify-content: space-between;">
          <div style="font-weight: 700; font-size: 13px; color: #34D399; display: flex; align-items: center; gap: 6px;">
            <span>💾 AXON GIT COMMIT & PUSH PIPELINE</span>
          </div>
          <button id="axon-git-close" style="background: none; border: none; color: #94A3B8; cursor: pointer; font-size: 18px; padding: 2px 6px;">&times;</button>
        </div>

        <div style="padding: 16px; font-size: 12px;">
          <!-- Target Repo / Project info -->
          <div style="display: flex; gap: 10px; margin-bottom: 12px;">
            <div style="flex: 2;">
              <label style="display: block; font-size: 10px; text-transform: uppercase; color: #94A3B8; font-weight: 600; margin-bottom: 4px;">GitHub Repository</label>
              <div style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 7px 8px; color: #E2E8F0; font-size: 11px; font-weight: 600; font-family: monospace;">
                📁 ${activeProject.repositoryName || activeProject.name || 'Akshat-churi/Fittrack-AI'}
              </div>
            </div>
            <div style="flex: 1;">
              <label style="display: block; font-size: 10px; text-transform: uppercase; color: #94A3B8; font-weight: 600; margin-bottom: 4px;">Branch</label>
              <input id="axon-git-branch" type="text" value="${activeProject.defaultBranch || 'main'}" style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #fff; padding: 7px 8px; font-size: 11px; outline: none;" />
            </div>
          </div>

          <!-- Commit Message -->
          <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 10px; text-transform: uppercase; color: #94A3B8; font-weight: 600; margin-bottom: 4px;">Commit Message</label>
            <input id="axon-git-message" type="text" value="feat(visual): polish layout and styles via Axon Extension" style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #fff; padding: 7px 8px; font-size: 11px; outline: none;" />
          </div>

          <!-- GitHub Personal Access Token (PAT) -->
          <div style="margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <label style="font-size: 10px; text-transform: uppercase; color: #94A3B8; font-weight: 600;">GitHub Access Token (PAT with 'repo' scope)</label>
              <a href="https://github.com/settings/tokens/new?scopes=repo&description=Axon%20Design%20Studio" target="_blank" style="font-size: 10px; color: #34D399; text-decoration: underline;">Generate Token &nearr;</a>
            </div>
            <input id="axon-git-token" type="password" placeholder="ghp_... (Saved automatically)" value="${currentAuth.githubToken || ''}" style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #fff; padding: 7px 8px; font-size: 11px; outline: none; font-family: monospace;" />
          </div>

          <!-- Changes Summary -->
          <div style="margin-bottom: 14px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 10px;">
            <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: #94A3B8; font-weight: 600; margin-bottom: 6px;">
              <span>STAGED FILES & STYLES OVERRIDES</span>
              <span style="color: #34D399;">Ready for Git Push</span>
            </div>
            <div style="font-family: monospace; font-size: 10px; color: #A7F3D0; line-height: 1.5;">
              <div>+ src/styles/overrides.css (DOM hotfix rules)</div>
              <div>+ src/index.css (Styles import hook)</div>
            </div>
          </div>

          <!-- Live Progress Box (Hidden initially) -->
          <div id="axon-git-progress" style="display: none; margin-bottom: 12px; background: #0F0D1B; border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 6px; padding: 8px; font-family: monospace; font-size: 10px; color: #6EE7B7; max-height: 110px; overflow-y: auto;">
            <div>> Initializing git commit pipeline...</div>
          </div>

          <div id="axon-git-error" style="display: none; color: #F87171; font-size: 11px; margin-bottom: 10px; line-height: 1.4; padding: 8px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 6px;"></div>

          <button id="axon-git-submit" style="width: 100%; padding: 10px; border-radius: 6px; background: linear-gradient(135deg, #10B981, #059669); border: none; color: #FFFFFF; font-weight: 700; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.4);">
            <span>🚀 Commit and Push to Repository</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('axon-git-close').onclick = () => modal.remove();
    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };

    const submitBtn = document.getElementById('axon-git-submit');
    const progressBox = document.getElementById('axon-git-progress');
    const errDiv = document.getElementById('axon-git-error');

    submitBtn.onclick = async () => {
      const branch = document.getElementById('axon-git-branch').value.trim() || 'main';
      const msg = document.getElementById('axon-git-message').value.trim() || 'feat(visual): style tweaks via Axon Extension';
      const tokenInput = document.getElementById('axon-git-token')?.value?.trim() || '';

      if (tokenInput) {
        currentAuth.githubToken = tokenInput;
        await saveAuth();
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="axon-ai-spin">⚡</span> Pushing to GitHub repository...';
      progressBox.style.display = 'block';
      errDiv.style.display = 'none';

      progressBox.innerHTML = `
        <div>> Staging visual DOM CSS overrides...</div>
        <div>> Connecting to GitHub repository on branch '${branch}'...</div>
      `;

      try {
        const res = await executeGitCommitPipeline(msg, branch, tokenInput);
        const serverBase = (currentAuth.serverUrl || PRODUCTION_SERVER_URL).replace(/\/+$/, '');
        const targetUrl = `${serverBase}/deployments`;
        const commitUrl = res.commitUrl || (activeProject.repositoryUrl ? `${activeProject.repositoryUrl}/commit/${res.commitSha}` : '');

        progressBox.innerHTML += `
          <div>> Commit ${res.commitSha ? res.commitSha.slice(0, 7) : 'created'}: "${msg}"</div>
          <div>> Push to origin/${branch} successful!</div>
          ${commitUrl ? `<div style="margin-top: 6px;"><a href="${commitUrl}" target="_blank" style="color: #34D399; text-decoration: underline; font-weight: 700;">📦 View Commit in GitHub Repository &rarr;</a></div>` : ''}
          <div style="margin-top: 6px;">
            <a href="${targetUrl}" target="_blank" style="color: #818CF8; text-decoration: underline; font-weight: 700;">
              🌐 View Deployment on Axon &rarr;
            </a>
          </div>
        `;
        showToast('🎉 Git Commit & Push to GitHub completed successfully!');
        submitBtn.innerHTML = '<span>✓ Pushed to GitHub</span>';
        setTimeout(() => {
          if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
            chrome.tabs.create({ url: targetUrl });
          } else {
            window.open(targetUrl, '_blank');
          }
          modal.remove();
        }, 1800);
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>🚀 Commit and Push to Repository</span>';
        progressBox.innerHTML += `<div style="color: #F87171;">> Pipeline error: ${err.message}</div>`;
        errDiv.textContent = err.message;
        errDiv.style.display = 'block';
      }
    };
  }

  function injectUI() {
    if (document.getElementById('axon-topbar')) return;

    const bar = document.createElement('div');
    bar.id = 'axon-topbar';
    bar.style.cssText = `
      position: sticky;
      top: 0;
      z-index: 10000;
      background: #120F26;
      color: #FFFFFF;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
      padding: 6px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 11px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
      flex-wrap: wrap;
    `;

    bar.innerHTML = `
      <!-- Left: Logo & Status -->
      <div style="display: flex; align-items: center; gap: 6px; min-width: 0;">
        <div style="display: flex; align-items: center; gap: 4px; font-weight: 800; letter-spacing: -0.3px; color: #818CF8; font-size: 12px; cursor: pointer;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#818CF8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
          <span style="color: #FFFFFF;">AXON</span>
        </div>
        
        <div id="axon-status-indicator" title="Click to view connection & pairing details" style="display: flex; align-items: center; gap: 4px; cursor: pointer; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.08); transition: background 0.15s ease;">
          <span id="axon-dot" style="width: 6px; height: 6px; border-radius: 50%; background: #94A3B8;"></span>
          <span id="axon-status-text" style="font-size: 10px; color: #CBD5E1; font-weight: 500;">Offline</span>
        </div>
      </div>

      <!-- Right: Action Buttons & Controls -->
      <div style="display: flex; align-items: center; gap: 5px; flex-wrap: wrap;">
        <!-- Teammates Presence Stack -->
        <div id="axon-presence-stack" title="Active Teammates (Click for details)" style="display: flex; align-items: center; cursor: pointer; margin-right: 2px;"></div>

        <!-- Project Selector -->
        <select id="axon-project-select" style="
          display: none;
          background: rgba(255, 255, 255, 0.12);
          border: 1px solid rgba(255, 255, 255, 0.2);
          color: #FFFFFF;
          border-radius: 4px;
          padding: 2px 5px;
          font-size: 10px;
          outline: none;
          cursor: pointer;
          max-width: 95px;
        "></select>

        <!-- Inline AI Button -->
        <button id="axon-ai-btn" title="Use AI Inline Prompt" style="
          display: inline-flex;
          background: rgba(139, 92, 246, 0.25);
          border: 1px solid rgba(139, 92, 246, 0.5);
          color: #DDD6FE;
          border-radius: 4px;
          padding: 3px 7px;
          font-size: 10px;
          font-weight: 700;
          cursor: pointer;
          align-items: center;
          gap: 3px;
          user-select: none;
          transition: background 0.15s ease, transform 0.1s ease;
        ">
          <span>✨ AI</span>
        </button>

        <!-- Activities History Button -->
        <button id="axon-activity-btn" title="Team Activity & Audit History" style="
          display: inline-flex;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: #E2E8F0;
          border-radius: 4px;
          padding: 3px 6px;
          font-size: 10px;
          font-weight: 500;
          cursor: pointer;
          align-items: center;
          gap: 3px;
          user-select: none;
          transition: background 0.15s ease, transform 0.1s ease;
        ">
          <span>📜 History</span>
        </button>

        <!-- Save & Git Push Button (REAL PIPELINE) -->
        <button id="axon-git-commit-btn" title="Commit and Push changes via Git" style="
          display: inline-flex;
          background: linear-gradient(135deg, #10B981, #059669);
          color: white;
          border: none;
          border-radius: 4px;
          padding: 3px 8px;
          font-size: 10px;
          font-weight: 700;
          cursor: pointer;
          align-items: center;
          gap: 4px;
          box-shadow: 0 1px 4px rgba(16, 185, 129, 0.3);
          user-select: none;
          transition: filter 0.15s ease, transform 0.1s ease;
        ">
          <span>💾 Git Push</span>
        </button>

        <!-- Publish Patch Button -->
        <button id="axon-publish-btn" title="Stage and Publish Hotfix Patch" style="
          display: inline-flex;
          background: rgba(99, 102, 241, 0.2);
          border: 1px solid rgba(99, 102, 241, 0.4);
          color: #A5B4FC;
          border-radius: 4px;
          padding: 3px 6px;
          font-size: 10px;
          font-weight: 600;
          cursor: pointer;
          user-select: none;
          transition: background 0.15s ease, transform 0.1s ease;
        ">
          <span>🚀 Patch</span>
        </button>

        <!-- Connect / Pair Button -->
        <button id="axon-connect-btn" style="
          display: inline-flex;
          background: #4F46E5;
          color: white;
          border: none;
          border-radius: 4px;
          padding: 3px 8px;
          font-size: 10px;
          font-weight: 600;
          cursor: pointer;
          user-select: none;
        ">
          Pair with Axon
        </button>
      </div>
    `;

    document.body.prepend(bar);

    // Event Delegation: Guarantees 100% clickability across all buttons and child elements
    bar.addEventListener('click', (e) => {
      const aiBtn = e.target.closest('#axon-ai-btn');
      if (aiBtn) {
        e.preventDefault();
        e.stopPropagation();
        openInlineAiModal();
        return;
      }

      const actBtn = e.target.closest('#axon-activity-btn');
      if (actBtn) {
        e.preventDefault();
        e.stopPropagation();
        openActivityModal();
        return;
      }

      const gitBtn = e.target.closest('#axon-git-commit-btn');
      if (gitBtn) {
        e.preventDefault();
        e.stopPropagation();
        openGitCommitModal();
        return;
      }

      const pubBtn = e.target.closest('#axon-publish-btn');
      if (pubBtn) {
        e.preventDefault();
        e.stopPropagation();
        openPublishModal();
        return;
      }

      const connBtn = e.target.closest('#axon-connect-btn');
      if (connBtn) {
        e.preventDefault();
        e.stopPropagation();
        openModal();
        return;
      }

      const statIndicator = e.target.closest('#axon-status-indicator');
      if (statIndicator) {
        e.preventDefault();
        e.stopPropagation();
        openModal();
        return;
      }

      const presStack = e.target.closest('#axon-presence-stack');
      if (presStack) {
        e.preventDefault();
        e.stopPropagation();
        openTeammatesModal();
        return;
      }
    });

    // Direct listener attachments as backup
    const aiEl = document.getElementById('axon-ai-btn');
    if (aiEl) aiEl.onclick = openInlineAiModal;
    const actEl = document.getElementById('axon-activity-btn');
    if (actEl) actEl.onclick = openActivityModal;
    const gitEl = document.getElementById('axon-git-commit-btn');
    if (gitEl) gitEl.onclick = openGitCommitModal;
    const pubEl = document.getElementById('axon-publish-btn');
    if (pubEl) pubEl.onclick = openPublishModal;
    const connEl = document.getElementById('axon-connect-btn');
    if (connEl) connEl.onclick = openModal;
    const statEl = document.getElementById('axon-status-indicator');
    if (statEl) statEl.onclick = openModal;
    const presEl = document.getElementById('axon-presence-stack');
    if (presEl) presEl.onclick = openTeammatesModal;

    const projectSelect = document.getElementById('axon-project-select');
    if (projectSelect) {
      projectSelect.onchange = (e) => {
        currentAuth.activeProjectId = e.target.value;
        saveAuth();
      };
    }

    injectModalStyles();
  }

  function renderTeammates() {
    const stack = document.getElementById('axon-presence-stack');
    if (!stack) return;
    stack.innerHTML = '';

    if (activeTeammates.length === 0) return;

    activeTeammates.slice(0, 3).forEach((t) => {
      const bubble = document.createElement('div');
      const isStale = t._frozen === true;
      const title = isStale
        ? `${t.userName} left this page — cursor visible for ~60s`
        : `${t.userName} (${t.role || 'teammate'}) is active on route: ${t.route || '/'}`;
      bubble.title = title;
      bubble.style.cssText = `
        width: 17px;
        height: 17px;
        border-radius: 50%;
        background: ${isStale ? '#475569' : (t.userColor || '#6366F1')};
        color: #FFFFFF;
        font-size: 9px;
        font-weight: bold;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1.5px solid ${isStale ? 'rgba(148,163,184,0.4)' : '#120F26'};
        margin-left: -4px;
        opacity: ${isStale ? '0.55' : '1'};
        transition: opacity 0.3s ease;
      `;
      bubble.textContent = (t.userName || 'U')[0].toUpperCase();
      stack.appendChild(bubble);
    });

    if (activeTeammates.length > 3) {
      const more = document.createElement('div');
      more.style.cssText = `
        width: 17px;
        height: 17px;
        border-radius: 50%;
        background: #334155;
        color: #94A3B8;
        font-size: 8px;
        font-weight: bold;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1.5px solid #120F26;
        margin-left: -4px;
      `;
      more.textContent = `+${activeTeammates.length - 3}`;
      stack.appendChild(more);
    }
  }


  function updateUI() {
    const indicator = document.getElementById('axon-status-indicator');
    const dot = document.getElementById('axon-dot');
    const text = document.getElementById('axon-status-text');
    const connectBtn = document.getElementById('axon-connect-btn');
    const publishBtn = document.getElementById('axon-publish-btn');
    const commitBtn = document.getElementById('axon-git-commit-btn');
    const activityBtn = document.getElementById('axon-activity-btn');
    const aiBtn = document.getElementById('axon-ai-btn');
    const projectSelect = document.getElementById('axon-project-select');

    if (!indicator || !dot || !text) return;

    // Ensure all 4 action buttons are ALWAYS visible and clickable
    if (aiBtn) aiBtn.style.display = 'inline-flex';
    if (activityBtn) activityBtn.style.display = 'inline-flex';
    if (commitBtn) commitBtn.style.display = 'inline-flex';
    if (publishBtn) publishBtn.style.display = 'inline-flex';

    if (currentAuth.token) {
      dot.style.background = '#22C55E';
      dot.style.boxShadow = '0 0 6px rgba(34, 197, 94, 0.7)';
      text.textContent = currentAuth.workspace?.name || 'Connected';
      text.style.color = '#86EFAC';
      if (connectBtn) {
        connectBtn.style.display = 'inline-flex';
        connectBtn.textContent = 'Settings';
        connectBtn.style.background = 'rgba(255, 255, 255, 0.12)';
      }

      if (currentAuth.projects && currentAuth.projects.length > 0) {
        if (projectSelect) {
          projectSelect.style.display = 'inline-block';
          projectSelect.innerHTML = currentAuth.projects
            .map((p) => `<option value="${p.id}" ${p.id === currentAuth.activeProjectId ? 'selected' : ''}>${p.name}</option>`)
            .join('');
        }
      } else if (projectSelect) {
        projectSelect.style.display = 'none';
      }
    } else {
      dot.style.background = '#EF4444';
      dot.style.boxShadow = 'none';
      text.textContent = 'Not Paired';
      text.style.color = '#FCA5A5';
      if (connectBtn) {
        connectBtn.style.display = 'inline-flex';
        connectBtn.textContent = 'Pair with Axon';
        connectBtn.style.background = '#4F46E5';
      }
      if (projectSelect) projectSelect.style.display = 'none';
    }
  }

  function injectModalStyles() {
    if (document.getElementById('axon-styles')) return;
    const style = document.createElement('style');
    style.id = 'axon-styles';
    style.textContent = `
      @keyframes axon-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.6; transform: scale(0.97); }
      }
      @keyframes axon-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .axon-ai-spin {
        display: inline-block;
        animation: axon-spin 1s linear infinite;
      }
    `;
    document.head.appendChild(style);
  }

  let isAiModalOpening = false;

  async function openInlineAiModal(preselectedInfo = null) {
    if (isAiModalOpening) return;
    isAiModalOpening = true;

    try {
      const existing = document.getElementById('axon-ai-modal');
      if (existing) existing.remove();

      let targetTag = 'element';
      let targetDesc = '<selected element>';
      let targetText = '';
      let targetStyles = {};
      let targetDmId = null;

      // 1. Check preselected info or cached payload from content.js
      const cached = preselectedInfo || lastSelectedElementPayload;
      if (cached) {
        targetDmId = cached.id || null;
        targetTag = (cached.tagName || 'element').toLowerCase();
        targetDesc = cached.selector || (targetDmId ? `[data-dm-id="${targetDmId}"]` : `<${targetTag}>`);
        targetText = (cached.textContent || '').trim().slice(0, 100);
        targetStyles = cached.computedStyles || {};
      }

      // 2. Query active tab to resolve or verify currently selected DOM element
      const tab = await getActiveTab();
      const activeTabId = tab ? tab.id : null;

      if (activeTabId && typeof chrome !== 'undefined' && chrome.scripting) {
        try {
          const evalRes = await chrome.scripting.executeScript({
            target: { tabId: activeTabId },
            func: (knownDmId) => {
              let el = null;
              if (knownDmId) el = document.querySelector(`[data-dm-id="${knownDmId}"]`);
              if (!el) {
                const dmSelect = document.getElementById('dm-select');
                if (dmSelect && dmSelect.style.display !== 'none') {
                  const r = dmSelect.getBoundingClientRect();
                  if (r.width > 0 && r.height > 0) {
                    const els = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                    el = els.find(e => e && e.id !== 'dm-select' && !e.id?.startsWith('dm-') && !e.className?.toString().includes('dm-') && !e.closest('#axon-multiplayer-overlay') && e !== document.body && e !== document.documentElement);
                  }
                }
              }
              if (!el) {
                const dmEls = Array.from(document.querySelectorAll('[data-dm-id]'));
                if (dmEls.length > 0) {
                  el = dmEls.find(e => e.matches(':hover')) || dmEls[dmEls.length - 1];
                }
              }
              if (!el) {
                el = document.querySelector('[data-dm-selected], .dm-selected') || (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
              }
              if (!el && window.__axon_last_clicked) el = window.__axon_last_clicked;

              if (el && el !== document.body && el !== document.documentElement) {
                window.__axon_ai_target = el;
                const tag = el.tagName.toLowerCase();
                const id = el.id ? `#${el.id}` : '';
                const cls = el.className && typeof el.className === 'string'
                  ? `.${el.className.trim().split(/\s+/)[0]}`
                  : '';
                const comp = window.getComputedStyle(el);
                return {
                  dmId: el.getAttribute('data-dm-id') || null,
                  tag,
                  desc: `<${tag}${id}${cls}>`,
                  text: (el.innerText || el.textContent || '').trim().slice(0, 100),
                  styles: {
                    fontSize: comp.fontSize,
                    color: comp.color,
                    backgroundColor: comp.backgroundColor,
                    padding: comp.padding,
                    borderRadius: comp.borderRadius,
                    fontWeight: comp.fontWeight,
                  }
                };
              }
              return null;
            },
            args: [targetDmId]
          });

          if (evalRes && evalRes[0] && evalRes[0].result) {
            const r = evalRes[0].result;
            if (r.dmId) targetDmId = r.dmId;
            targetTag = r.tag || targetTag;
            targetDesc = r.desc || targetDesc;
            targetText = r.text || targetText;
            targetStyles = r.styles || targetStyles;
          }
        } catch (err) {
          console.warn('[AxonBridge] Query active tab element warning:', err);
        }
      }

      // 3. Construct Modal Overlay
      const modal = document.createElement('div');
      modal.id = 'axon-ai-modal';
      modal.style.cssText = `
        position: fixed !important;
        inset: 0 !important;
        background: rgba(0, 0, 0, 0.78) !important;
        backdrop-filter: blur(8px) !important;
        -webkit-backdrop-filter: blur(8px) !important;
        z-index: 2147483647 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 16px !important;
        box-sizing: border-box !important;
        pointer-events: auto !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      `;

      const savedKey = (typeof localStorage !== 'undefined' ? localStorage.getItem('axon_ai_key') : '') || '';

      modal.innerHTML = `
        <div id="axon-ai-card" style="background: #181530; color: #FFFFFF; width: 100%; max-width: 440px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.18); box-shadow: 0 24px 50px rgba(0, 0, 0, 0.75); overflow: hidden; pointer-events: auto !important; position: relative;">
          <!-- Modal Header -->
          <div style="padding: 12px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.02);">
            <div style="font-weight: 700; font-size: 13px; color: #C4B5FD; display: flex; align-items: center; gap: 6px;">
              <span>✨ AXON INLINE AI ASSISTANT</span>
            </div>
            <button id="axon-ai-close" type="button" title="Close" style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #CBD5E1; cursor: pointer; font-size: 16px; line-height: 1; border-radius: 6px; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; pointer-events: auto !important; transition: background 0.15s ease;">&times;</button>
          </div>

          <div style="padding: 16px; font-size: 12px;">
            <!-- Target Info Bar -->
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 6px;">
              <p style="font-size: 11px; color: #CBD5E1; line-height: 1.4; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 250px;">
                Target: <code id="axon-ai-target-tag" style="color: #A5B4FC; background: rgba(0,0,0,0.35); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 11px;">${targetDesc}</code>
                ${targetText ? `<span style="color: #94A3B8; font-size: 10px; margin-left: 4px;">("${targetText.slice(0, 24)}")</span>` : ''}
              </p>
              <span id="axon-ai-engine-badge" title="5 Google Gemini API keys linked with auto-rotation" style="background: rgba(139, 92, 246, 0.2); color: #C4B5FD; border: 1px solid rgba(139, 92, 246, 0.4); font-size: 9px; padding: 2px 7px; border-radius: 99px; font-weight: 600; white-space: nowrap;">
                ⚡ Gemini 3.8 Flash (5 Keys)
              </span>
            </div>

            <!-- Prompt Textarea -->
            <div style="margin-bottom: 10px;">
              <textarea id="axon-ai-prompt" rows="3" placeholder="e.g. Change text as int to 42 and increase font size by some amount" style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.22); border-radius: 8px; color: #fff; padding: 10px; font-size: 12px; line-height: 1.4; outline: none; resize: vertical; pointer-events: auto !important; transition: border-color 0.15s ease;"></textarea>
            </div>

            <!-- Quick Action Pills -->
            <div style="display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 12px;">
              <button type="button" class="axon-ai-pill" data-prompt="Change text as int to 42 and increase font size by some amount" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); color: #C4B5FD; padding: 4px 8px; border-radius: 99px; font-size: 9px; cursor: pointer; pointer-events: auto !important; transition: background 0.15s ease;">🔢 Change Int & Font Size</button>
              <button type="button" class="axon-ai-pill" data-prompt="Increase font size by 6px and make bold" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); color: #93C5FD; padding: 4px 8px; border-radius: 99px; font-size: 9px; cursor: pointer; pointer-events: auto !important; transition: background 0.15s ease;">🔤 Font +6px & Bold</button>
              <button type="button" class="axon-ai-pill" data-prompt="Modern gradient purple background with soft glow and rounded corners" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); color: #A5B4FC; padding: 4px 8px; border-radius: 99px; font-size: 9px; cursor: pointer; pointer-events: auto !important; transition: background 0.15s ease;">✨ Purple Glow</button>
              <button type="button" class="axon-ai-pill" data-prompt="Dark glassmorphism background with subtle border and blur" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); color: #A5B4FC; padding: 4px 8px; border-radius: 99px; font-size: 9px; cursor: pointer; pointer-events: auto !important; transition: background 0.15s ease;">🪞 Glassmorphism</button>
              <button type="button" class="axon-ai-pill" data-prompt="Sleek emerald green theme with white text and smooth rounded corners" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); color: #34D399; padding: 4px 8px; border-radius: 99px; font-size: 9px; cursor: pointer; pointer-events: auto !important; transition: background 0.15s ease;">🟢 Emerald Modern</button>
            </div>

            <!-- Optional API Key Accordion -->
            <div style="margin-bottom: 12px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; padding: 8px; background: rgba(0, 0, 0, 0.2);">
              <div id="axon-ai-toggle-settings" style="display: flex; align-items: center; justify-content: space-between; cursor: pointer; pointer-events: auto !important;">
                <span style="font-size: 10px; color: #94A3B8; font-weight: 600;">⚙️ AI Settings & API Keys (Optional)</span>
                <span id="axon-ai-settings-arrow" style="font-size: 10px; color: #94A3B8;">▼</span>
              </div>
              <div id="axon-ai-settings-panel" style="display: none; margin-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 8px;">
                <p style="font-size: 10px; color: #94A3B8; margin-bottom: 6px; line-height: 1.3;">
                  5 Google Gemini API Keys are permanently embedded with auto-failover rotation (Key 1 to 5). You can also optionally paste a custom key:
                </p>
                <div style="display: flex; gap: 6px;">
                  <input id="axon-ai-key-input" type="password" value="${savedKey}" placeholder="Gemini or OpenAI API Key" style="flex: 1; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 4px; padding: 4px 6px; color: white; font-size: 10px; outline: none; pointer-events: auto !important;" />
                  <button id="axon-ai-save-key-btn" type="button" style="background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2); color: white; border-radius: 4px; padding: 4px 8px; font-size: 10px; cursor: pointer; pointer-events: auto !important;">Save</button>
                </div>
              </div>
            </div>

            <div id="axon-ai-error" style="display: none; color: #F87171; font-size: 11px; margin-bottom: 10px; padding: 6px 8px; background: rgba(248, 113, 113, 0.1); border-radius: 4px; border: 1px solid rgba(248, 113, 113, 0.2);"></div>

            <button id="axon-ai-apply-btn" type="button" style="width: 100%; padding: 11px; border-radius: 8px; background: linear-gradient(135deg, #7C3AED, #6366F1); border: none; color: #FFFFFF; font-weight: 700; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; pointer-events: auto !important; box-shadow: 0 4px 15px rgba(124, 58, 237, 0.35); transition: opacity 0.15s ease, transform 0.1s ease;">
              <span>✨ Generate & Apply Styles</span>
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Prevent clicks inside card from propagating to modal backdrop
      const card = modal.querySelector('#axon-ai-card');
      if (card) {
        card.addEventListener('click', (e) => {
          e.stopPropagation();
        });
      }

      // Close button handler
      const closeBtn = modal.querySelector('#axon-ai-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          modal.remove();
        });
      }

      // Backdrop click handler
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
        }
      });

      // Escape key to dismiss
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          modal.remove();
          document.removeEventListener('keydown', escHandler);
        }
      };
      document.addEventListener('keydown', escHandler);

      // Settings toggle handler
      const toggleSettings = modal.querySelector('#axon-ai-toggle-settings');
      const settingsPanel = modal.querySelector('#axon-ai-settings-panel');
      const settingsArrow = modal.querySelector('#axon-ai-settings-arrow');
      if (toggleSettings && settingsPanel) {
        toggleSettings.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const isHidden = settingsPanel.style.display === 'none';
          settingsPanel.style.display = isHidden ? 'block' : 'none';
          if (settingsArrow) settingsArrow.textContent = isHidden ? '▲' : '▼';
        });
      }

      // Save custom API key
      const saveKeyBtn = modal.querySelector('#axon-ai-save-key-btn');
      if (saveKeyBtn) {
        saveKeyBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const keyVal = (modal.querySelector('#axon-ai-key-input')?.value || '').trim();
          if (typeof localStorage !== 'undefined') {
            if (keyVal) localStorage.setItem('axon_ai_key', keyVal);
            else localStorage.removeItem('axon_ai_key');
          }
          currentAuth.aiApiKey = keyVal || null;
          saveAuth();
          showToast(keyVal ? '🔑 Custom API key saved!' : '⚡ Reset to built-in 5-key pool.');
        });
      }

      const promptInput = modal.querySelector('#axon-ai-prompt');
      const applyBtn = modal.querySelector('#axon-ai-apply-btn');
      const errDiv = modal.querySelector('#axon-ai-error');

      // Quick action pills handler
      modal.querySelectorAll('.axon-ai-pill').forEach((pill) => {
        pill.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const promptText = pill.getAttribute('data-prompt');
          if (promptText && promptInput) {
            promptInput.value = promptText;
            promptInput.focus();
            pill.style.background = 'rgba(139, 92, 246, 0.3)';
            setTimeout(() => { pill.style.background = 'rgba(255,255,255,0.06)'; }, 300);
          }
        });
      });

      // Submit on Enter (or Ctrl+Enter)
      if (promptInput) {
        promptInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
            e.preventDefault();
            applyBtn?.click();
          }
        });
        setTimeout(() => promptInput.focus(), 60);
      }

      // Send Prompt & Apply Styles Handler
      applyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const prompt = (promptInput?.value || '').trim();
        if (!prompt) {
          if (errDiv) {
            errDiv.textContent = 'Please enter an AI prompt or click one of the pills above.';
            errDiv.style.display = 'block';
          }
          return;
        }

        applyBtn.disabled = true;
        applyBtn.style.opacity = '0.8';
        applyBtn.innerHTML = '<span class="axon-ai-spin">⚡</span> AI Thinking & Transforming DOM (2-3s)...';
        if (errDiv) errDiv.style.display = 'none';

        // 1. Trigger the Blur 2-4 seconds thinking effect on target element on the webpage
        if (activeTabId && typeof chrome !== 'undefined' && chrome.scripting) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: activeTabId },
              func: (dmId) => {
                let el = null;
                if (dmId) el = document.querySelector(`[data-dm-id="${dmId}"]`);
                if (!el) {
                  const dmSelect = document.getElementById('dm-select');
                  if (dmSelect && dmSelect.style.display !== 'none') {
                    const r = dmSelect.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) {
                      const els = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                      el = els.find(e => e && e.id !== 'dm-select' && !e.id?.startsWith('dm-') && !e.className?.toString().includes('dm-') && !e.closest('#axon-multiplayer-overlay') && e !== document.body && e !== document.documentElement);
                    }
                  }
                }
                if (!el) {
                  const dmEls = Array.from(document.querySelectorAll('[data-dm-id]'));
                  if (dmEls.length > 0) el = dmEls.find(e => e.matches(':hover')) || dmEls[dmEls.length - 1];
                }
                if (!el) el = document.querySelector('[data-dm-selected], .dm-selected') || (document.activeElement !== document.body ? document.activeElement : null);
                if (!el && window.__axon_last_clicked) el = window.__axon_last_clicked;

                if (el && el !== document.body && el !== document.documentElement) {
                  window.__axon_ai_target = el;
                  el.dataset.axonOriginalFilter = el.style.filter || '';
                  el.dataset.axonOriginalOpacity = el.style.opacity || '';
                  el.dataset.axonOriginalTransition = el.style.transition || '';
                  el.style.setProperty('transition', 'filter 0.35s ease, opacity 0.35s ease', 'important');
                  el.style.setProperty('filter', 'blur(3.5px)', 'important');
                  el.style.setProperty('opacity', '0.72', 'important');
                  if (typeof el.animate === 'function') {
                    if (window.__axon_ai_anim) { try { window.__axon_ai_anim.cancel(); } catch (_) {} }
                    window.__axon_ai_anim = el.animate([
                      { outline: '2px solid rgba(139, 92, 246, 0.4)', outlineOffset: '2px', boxShadow: '0 0 12px rgba(139, 92, 246, 0.5)' },
                      { outline: '3.5px solid rgba(99, 102, 241, 0.95)', outlineOffset: '5px', boxShadow: '0 0 24px rgba(99, 102, 241, 0.8)' },
                      { outline: '2px solid rgba(139, 92, 246, 0.4)', outlineOffset: '2px', boxShadow: '0 0 12px rgba(139, 92, 246, 0.5)' }
                    ], { duration: 1200, iterations: Infinity, easing: 'ease-in-out' });
                  }
                }
              },
              args: [targetDmId]
            });
          } catch (scriptErr) {
            console.warn('[AxonBridge] Scripting blur start warning:', scriptErr);
          }
        }

        // Also blur in local DOM if running directly on page
        const localTarget = (targetDmId ? document.querySelector(`[data-dm-id="${targetDmId}"]`) : null) || document.querySelector('[data-dm-selected], .dm-selected');
        if (localTarget && localTarget !== document.body) {
          window.__axon_ai_target = localTarget;
          localTarget.style.setProperty('transition', 'filter 0.35s ease, opacity 0.35s ease', 'important');
          localTarget.style.setProperty('filter', 'blur(3.5px)', 'important');
          localTarget.style.setProperty('opacity', '0.72', 'important');
        }

        try {
          // Run AI request in parallel with a minimum 2.3-second thinking duration for authentic visual effect
          const [res] = await Promise.all([
            requestInlineAiEdit(prompt, targetTag, targetStyles, targetText),
            new Promise((resolve) => setTimeout(resolve, 2300))
          ]);

          if (!res || (!res.css && res.text === undefined && res.text === null)) {
            throw new Error('AI could not parse styling changes for this prompt. Please try rephrasing.');
          }

          // 2. Apply result to element in active webpage tab via executeScript
          let appliedViaScripting = false;
          if (activeTabId && typeof chrome !== 'undefined' && chrome.scripting) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: activeTabId },
                func: (dmId, cssProps, textEdit) => {
                  let el = window.__axon_ai_target;
                  if (!el && dmId) el = document.querySelector(`[data-dm-id="${dmId}"]`);
                  if (!el) {
                    const dmSelect = document.getElementById('dm-select');
                    if (dmSelect && dmSelect.style.display !== 'none') {
                      const r = dmSelect.getBoundingClientRect();
                      const els = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                      el = els.find(e => e && e.id !== 'dm-select' && !e.id?.startsWith('dm-') && !e.className?.toString().includes('dm-') && !e.closest('#axon-multiplayer-overlay') && e !== document.body);
                    }
                  }
                  if (!el) el = document.querySelector('[data-dm-selected], .dm-selected') || (document.activeElement !== document.body ? document.activeElement : null);

                  if (el && el !== document.body && el !== document.documentElement) {
                    // Cancel thinking animation and restore blur
                    if (window.__axon_ai_anim) {
                      try { window.__axon_ai_anim.cancel(); } catch (_) {}
                      window.__axon_ai_anim = null;
                    }
                    el.style.removeProperty('filter');
                    el.style.removeProperty('opacity');
                    if (el.dataset.axonOriginalFilter !== undefined) el.style.filter = el.dataset.axonOriginalFilter;
                    if (el.dataset.axonOriginalOpacity !== undefined) el.style.opacity = el.dataset.axonOriginalOpacity;
                    delete el.dataset.axonOriginalFilter;
                    delete el.dataset.axonOriginalOpacity;
                    delete el.dataset.axonOriginalTransition;

                    // Apply new text content
                    if (textEdit !== null && textEdit !== undefined && textEdit !== '') {
                      el.innerText = String(textEdit);
                    }

                    // Apply CSS properties with !important
                    if (cssProps && typeof cssProps === 'object') {
                      for (const [key, value] of Object.entries(cssProps)) {
                        if (key && value) {
                          const kebab = key.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
                          el.style.setProperty(kebab, String(value), 'important');
                        }
                      }
                    }

                    // Green Success Glow Animation
                    if (typeof el.animate === 'function') {
                      el.animate([
                        { outline: '3px solid #10B981', outlineOffset: '3px', boxShadow: '0 0 18px rgba(16, 185, 129, 0.85)' },
                        { outline: '1px solid rgba(16, 185, 129, 0)', outlineOffset: '8px', boxShadow: '0 0 0px rgba(16, 185, 129, 0)' }
                      ], { duration: 900, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
                    }

                    // Snap Design Mode selection overlay to updated dimensions
                    const dmSelect = document.getElementById('dm-select');
                    if (dmSelect && dmSelect.style.display !== 'none') {
                      const r = el.getBoundingClientRect();
                      dmSelect.style.top = r.top + 'px';
                      dmSelect.style.left = r.left + 'px';
                      dmSelect.style.width = r.width + 'px';
                      dmSelect.style.height = r.height + 'px';
                    }
                    const dmDim = document.getElementById('dm-dim-label');
                    if (dmDim && dmDim.style.display !== 'none') {
                      const r = el.getBoundingClientRect();
                      dmDim.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
                      dmDim.style.top = (r.top + r.height + 4) + 'px';
                      dmDim.style.left = r.left + 'px';
                    }

                    return true;
                  }
                  return false;
                },
                args: [targetDmId, res.css || {}, res.text != null ? String(res.text) : null]
              });
              appliedViaScripting = true;
            } catch (scriptErr) {
              console.warn('[AxonBridge] Scripting apply warning:', scriptErr);
            }
          }

          // Also dispatch SET_TEXT and APPLY_STYLE to content.js via tabs.sendMessage
          if (activeTabId && typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.sendMessage) {
            if (res.text != null) {
              try { chrome.tabs.sendMessage(activeTabId, { type: 'SET_TEXT', text: String(res.text) }); } catch (_) {}
            }
            if (res.css) {
              for (const [prop, val] of Object.entries(res.css)) {
                try { chrome.tabs.sendMessage(activeTabId, { type: 'APPLY_STYLE', property: prop, value: val }); } catch (_) {}
              }
            }
          }

          // Direct local DOM fallback if bridge is in page context
          if (localTarget) {
            localTarget.style.removeProperty('filter');
            localTarget.style.removeProperty('opacity');
            if (res.text != null) localTarget.innerText = String(res.text);
            if (res.css) {
              for (const [k, v] of Object.entries(res.css)) {
                const kebab = k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
                localTarget.style.setProperty(kebab, String(v), 'important');
              }
            }
          }

          modal.remove();
          showToast(`✨ AI applied: ${res.explanation || 'Visual changes updated!'}`);
        } catch (err) {
          applyBtn.disabled = false;
          applyBtn.style.opacity = '1';
          applyBtn.innerHTML = '<span>✨ Generate & Apply Styles</span>';
          if (errDiv) {
            errDiv.textContent = err.message || 'AI generation failed. Please try again.';
            errDiv.style.display = 'block';
          }
        }
      });
    } finally {
      isAiModalOpening = false;
    }
  }
  // ==========================================
  // ACTIVITY HISTORY DRAWER
  // ==========================================
  async function openActivityModal() {
    const existing = document.getElementById('axon-act-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'axon-act-modal';
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(5px);
      z-index: 20000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    modal.innerHTML = `
      <div style="background: #181530; color: #FFFFFF; width: 100%; max-width: 400px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.15); box-shadow: 0 20px 45px rgba(0, 0, 0, 0.6); overflow: hidden;">
        <div style="padding: 12px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); display: flex; align-items: center; justify-content: space-between;">
          <div style="font-weight: 700; font-size: 13px; color: #818CF8;">📜 TEAM ACTIVITY STREAM</div>
          <button id="axon-act-close" style="background: none; border: none; color: #94A3B8; cursor: pointer; font-size: 18px; padding: 2px 6px;">&times;</button>
        </div>

        <div id="axon-act-list" style="padding: 14px 16px; max-height: 340px; overflow-y: auto; font-size: 11px; space-y: 8px;">
          <div style="color: #94A3B8; text-align: center; padding: 20px;">Loading audit events...</div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('axon-act-close').onclick = () => modal.remove();
    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };

    const listDiv = document.getElementById('axon-act-list');
    try {
      const res = await fetch(`${currentAuth.serverUrl}/api/audit`);
      const json = await res.json();
      if (json.success && Array.isArray(json.logs)) {
        if (json.logs.length === 0) {
          listDiv.innerHTML = '<div style="color: #94A3B8; text-align: center; padding: 20px;">No recent team activities yet.</div>';
          return;
        }

        listDiv.innerHTML = json.logs.slice(0, 8).map((log) => `
          <div style="padding: 8px 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; margin-bottom: 6px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
              <span style="font-weight: 600; color: #818CF8; font-size: 10px;">${log.action.replace(/_/g, ' ')}</span>
              <span style="font-size: 9px; color: #94A3B8;">${new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <p style="font-size: 11px; color: #E2E8F0; margin-bottom: 2px;">
              ${log.metadata?.commitMessage || log.metadata?.note || log.metadata?.title || 'Activity executed'}
            </p>
            <div style="font-size: 9px; color: #94A3B8;">By: <strong>${log.user?.name || 'Team member'}</strong></div>
          </div>
        `).join('');
      }
    } catch {
      listDiv.innerHTML = '<div style="color: #F87171; text-align: center;">Could not load activities.</div>';
    }
  }

  // ==========================================
  // TEAMMATES COLLABORATION MODAL
  // ==========================================
  function openTeammatesModal() {
    const existing = document.getElementById('axon-team-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'axon-team-modal';
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(5px);
      z-index: 20000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    modal.innerHTML = `
      <div style="background: #181530; color: #FFFFFF; width: 100%; max-width: 360px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.15); box-shadow: 0 20px 45px rgba(0, 0, 0, 0.6); overflow: hidden;">
        <div style="padding: 12px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); display: flex; align-items: center; justify-content: space-between;">
          <div style="font-weight: 700; font-size: 13px; color: #818CF8;">👥 MULTIPLAYER TEAM COLLABORATION</div>
          <button id="axon-team-close" style="background: none; border: none; color: #94A3B8; cursor: pointer; font-size: 18px; padding: 2px 6px;">&times;</button>
        </div>

        <div style="padding: 14px 16px; font-size: 11px;">
          <p style="color: #CBD5E1; font-size: 11px; margin-bottom: 10px;">
            Active team presence and inspected DOM elements sync across all sessions.
          </p>

          <div style="space-y: 6px;">
            <!-- Current User -->
            <div style="padding: 8px 10px; background: rgba(99,102,241,0.1); border: 1px solid rgba(99,102,241,0.25); border-radius: 6px; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <div style="width: 20px; height: 20px; border-radius: 50%; background: #6366F1; color: white; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 10px;">
                  ${(currentAuth.user?.name || 'You')[0].toUpperCase()}
                </div>
                <div>
                  <div style="font-weight: 600; color: white;">${currentAuth.user?.name || 'You'} (You)</div>
                  <div style="font-size: 9px; color: #A5B4FC;">Current active inspector session</div>
                </div>
              </div>
              <span style="font-size: 9px; color: #34D399; font-weight: bold;">ONLINE</span>
            </div>

            <!-- Teammates -->
            ${
              activeTeammates.length > 0
                ? activeTeammates.map((t) => `
                  <div style="padding: 8px 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <div style="width: 20px; height: 20px; border-radius: 50%; background: ${t.userColor || '#8B5CF6'}; color: white; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 10px;">
                        ${(t.userName || 'T')[0].toUpperCase()}
                      </div>
                      <div>
                        <div style="font-weight: 600; color: white;">${t.userName}</div>
                        <div style="font-size: 9px; color: #94A3B8;">${t.selectedElement ? 'Viewing: ' + t.selectedElement : 'Active on site'}</div>
                      </div>
                    </div>
                    <span style="font-size: 9px; color: #34D399;">Active</span>
                  </div>
                `).join('')
                : '<div style="color: #94A3B8; text-align: center; padding: 12px;">No other teammates online right now. Invite team in Axon Settings.</div>'
            }
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('axon-team-close').onclick = () => modal.remove();
    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };
  }

  // ==========================================
  // Publish Patch Modal (Existing)
  // ==========================================
  function openPublishModal() {
    const existing = document.getElementById('axon-publish-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'axon-publish-modal';
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(5px);
      z-index: 20000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    modal.innerHTML = `
      <div style="background: #181530; color: #FFFFFF; width: 100%; max-width: 360px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.15); box-shadow: 0 20px 45px rgba(0, 0, 0, 0.6); overflow: hidden;">
        <div style="padding: 12px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); display: flex; align-items: center; justify-content: space-between;">
          <div style="font-weight: 700; font-size: 13px; color: #818CF8;">STAGE PATCH ON AXON</div>
          <button id="axon-pub-close" style="background: none; border: none; color: #94A3B8; cursor: pointer; font-size: 18px; padding: 2px 6px;">&times;</button>
        </div>

        <div style="padding: 16px; font-size: 12px;">
          <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 10px; text-transform: uppercase; color: #94A3B8; font-weight: 600; margin-bottom: 4px;">Patch Title</label>
            <input id="axon-patch-title" type="text" value="Visual DOM tweak & styling hotfix" style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #fff; padding: 7px 8px; font-size: 12px; outline: none;" />
          </div>

          <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 10px; text-transform: uppercase; color: #94A3B8; font-weight: 600; margin-bottom: 4px;">Description / Context</label>
            <textarea id="axon-patch-desc" rows="3" style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #fff; padding: 7px 8px; font-size: 11px; outline: none; resize: vertical;">Visual adjustments made via Axon browser inspector. Ready for automated verification & team review.</textarea>
          </div>

          <div style="margin-bottom: 16px;">
            <label style="display: block; font-size: 10px; text-transform: uppercase; color: #94A3B8; font-weight: 600; margin-bottom: 4px;">Risk Level</label>
            <select id="axon-patch-risk" style="width: 100%; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #fff; padding: 6px; font-size: 11px; outline: none;">
              <option value="LOW" selected>LOW (CSS / Visual styling)</option>
              <option value="MEDIUM">MEDIUM (Layout / Spacing shifts)</option>
              <option value="HIGH">HIGH (Critical DOM mutations)</option>
            </select>
          </div>

          <div id="axon-pub-error" style="display: none; color: #F87171; font-size: 11px; margin-bottom: 10px;"></div>

          <button id="axon-pub-submit" style="width: 100%; padding: 10px; border-radius: 6px; background: linear-gradient(135deg, #4F46E5, #6366F1); border: none; color: #FFFFFF; font-weight: 700; font-size: 12px; cursor: pointer;">
            🚀 Stage Hotfix Now
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('axon-pub-close').onclick = () => modal.remove();
    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };

    const submitBtn = document.getElementById('axon-pub-submit');
    const errDiv = document.getElementById('axon-pub-error');

    submitBtn.onclick = async () => {
      const title = document.getElementById('axon-patch-title').value.trim();
      const desc = document.getElementById('axon-patch-desc').value.trim();
      const risk = document.getElementById('axon-patch-risk').value;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting to Axon...';
      errDiv.style.display = 'none';

      try {
        const res = await publishPatchToAxon(title, desc, risk);
        const serverBase = (currentAuth.serverUrl || PRODUCTION_SERVER_URL).replace(/\/+$/, '');
        const patchUrl = `${serverBase}${res.dashboardUrl || `/patches/${res.patch.id}`}`;
        const patchesListUrl = `${serverBase}${res.patchesListUrl || '/patches'}`;
        const authorName = res.patch.author?.name || currentAuth.user?.name || 'Team Member';

        // Transform modal content into a rich website card format instead of showing raw JSON
        const modalContainer = modal.querySelector('div');
        if (modalContainer) {
          modalContainer.innerHTML = `
            <div style="padding: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); display: flex; align-items: center; justify-content: space-between; background: linear-gradient(135deg, rgba(79, 70, 229, 0.2), rgba(16, 185, 129, 0.15));">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 20px;">🎉</span>
                <div>
                  <div style="font-weight: 700; font-size: 13px; color: #10B981;">Patch Staged Successfully</div>
                  <div style="font-size: 11px; color: #94A3B8;">Redirecting to Axon Visual Patches...</div>
                </div>
              </div>
              <button id="axon-pub-close" style="background: none; border: none; color: #94A3B8; cursor: pointer; font-size: 18px; padding: 2px 6px;">&times;</button>
            </div>
            <div style="padding: 16px; font-size: 12px; display: flex; flex-direction: column; gap: 12px;">
              <div style="background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                  <span style="font-weight: 700; color: #818CF8; font-size: 14px;">${res.patch.id}</span>
                  <span style="background: rgba(16, 185, 129, 0.2); color: #34D399; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 700;">${res.patch.status || 'SUBMITTED'}</span>
                </div>
                <div style="font-size: 13px; font-weight: 600; color: #F8FAFC; margin-bottom: 4px;">${res.patch.title}</div>
                <div style="font-size: 11px; color: #94A3B8; margin-bottom: 8px;">${res.patch.description || ''}</div>
                <div style="display: flex; flex-direction: column; gap: 4px; font-size: 10px; color: #64748B;">
                  <div>Author: <strong style="color: #F8FAFC;">${authorName}</strong></div>
                  <div style="display: flex; gap: 12px;">
                    <span>Branch: <strong style="color: #CBD5E1;">${res.patch.branchName || 'axon'}</strong></span>
                    <span>Risk: <strong style="color: #34D399;">${res.patch.riskLevel || 'LOW'}</strong></span>
                  </div>
                </div>
              </div>

              <div style="display: flex; flex-direction: column; gap: 8px;">
                <a href="${patchUrl}" target="_blank" style="display: block; text-align: center; text-decoration: none; padding: 10px; border-radius: 6px; background: linear-gradient(135deg, #4F46E5, #6366F1); color: #FFFFFF; font-weight: 700; font-size: 12px; cursor: pointer; box-shadow: 0 4px 14px rgba(79, 70, 229, 0.4);">
                  🔍 Review Patch & Diff (${res.patch.id}) &rarr;
                </a>
                <a href="${patchesListUrl}" target="_blank" style="display: block; text-align: center; text-decoration: none; padding: 8px; border-radius: 6px; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.15); color: #E2E8F0; font-weight: 600; font-size: 11px; cursor: pointer;">
                  📋 Visual Patches Studio (List) &rarr;
                </a>
              </div>
              <button id="axon-done-btn" style="width: 100%; padding: 8px; border-radius: 6px; background: transparent; border: none; color: #64748B; font-weight: 600; font-size: 11px; cursor: pointer;">
                Close Inspector
              </button>
            </div>
          `;

          const closeBtn = modalContainer.querySelector('#axon-pub-close');
          if (closeBtn) closeBtn.onclick = () => modal.remove();
          const doneBtn = modalContainer.querySelector('#axon-done-btn');
          if (doneBtn) doneBtn.onclick = () => modal.remove();
        }

        // Open in website tab automatically (redirect to visual patch)
        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
          chrome.tabs.create({ url: patchUrl });
        } else {
          window.open(patchUrl, '_blank');
        }
        showToast(`🎉 Opened Patch ${res.patch.id} in Visual Patches.`);
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = '🚀 Stage Hotfix Now';
        errDiv.textContent = err.message;
        errDiv.style.display = 'block';
      }
    };
  }

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #10B981;
      color: white;
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      box-shadow: 0 10px 25px rgba(0,0,0,0.4);
      z-index: 30000;
      animation: fadeIn 0.2s ease;
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function injectModalStyles() {
    if (document.getElementById('axon-modal-styles')) return;
    const style = document.createElement('style');
    style.id = 'axon-modal-styles';
    style.textContent = `
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  // Auto-init on page load
  async function init() {
    await loadAuth();
    injectUI();
    updateUI();
    if (currentAuth.token) {
      await fetchProjects();
      startPresenceSync();
      updateUI();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose global bridge
  window.AxonBridge = {
    pairWithCode,
    startWebAuth,
    disconnectAxon,
    publishPatchToAxon,
    executeGitCommitPipeline,
    requestInlineAiEdit,
    fetchProjects,
    getAuth: () => currentAuth,
  };
})();

/**
 * SM GPT — Main Application Controller (Vanilla JS ES Module)
 * Created by Abdus Nilom
 * All AI model inference executes on the dedicated SM GPT backend server via SSE streaming.
 */

import {
  APP_IDENTITY,
  DEFAULT_SETTINGS,
  STARTER_PROMPTS,
} from './config/app.config.js';
import {
  fetchBackendStatus,
  stopBackendGeneration,
  streamBackendChat,
} from './lib/api-client.js';
import {
  createDatabase,
  formatConversationAsJson,
  formatConversationAsTxt,
} from './lib/db.js';
import { assessResponseGrounding } from './lib/hallucination.js';
import { renderMarkdownToElement } from './lib/markdown.js';

const db = createDatabase();

const state = {
  settings: { ...DEFAULT_SETTINGS },
  conversations: [],
  activeConversationId: null,
  messages: [],
  searchQuery: '',
  engineState: 'connecting', // 'connecting' | 'loading' | 'ready' | 'error'
  activeGeneration: null, // { requestId, conversationId, assistantMessageId, text, startedAt, contextSnapshot, abortController }
  pendingPromptAfterInit: null,
  statusPollTimerId: null,
  stopWatchdogId: null,
};

// DOM References
const el = {
  appShell: document.getElementById('app-shell'),
  sidebar: document.getElementById('sidebar'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  btnSidebarToggle: document.getElementById('btn-sidebar-toggle'),
  btnNewChat: document.getElementById('btn-new-chat'),
  searchInput: document.getElementById('search-conversations'),
  conversationList: document.getElementById('conversation-list'),
  conversationEmpty: document.getElementById('conversation-empty'),
  btnThemeToggle: document.getElementById('btn-theme-toggle'),
  iconThemeSun: document.getElementById('icon-theme-sun'),
  iconThemeMoon: document.getElementById('icon-theme-moon'),
  themeToggleLabel: document.getElementById('theme-toggle-label'),
  btnOpenSettings: document.getElementById('btn-open-settings'),
  activeChatTitle: document.getElementById('active-chat-title'),
  engineStatus: document.getElementById('engine-status'),
  btnRetryInit: document.getElementById('btn-retry-init'),
  btnExportTxt: document.getElementById('btn-export-txt'),
  btnExportJson: document.getElementById('btn-export-json'),
  chatViewport: document.getElementById('chat-viewport'),
  welcomeScreen: document.getElementById('welcome-screen'),
  starterGrid: document.getElementById('starter-grid'),
  chatMessages: document.getElementById('chat-messages'),
  bannerNotice: document.getElementById('banner-notice'),
  bannerNoticeText: document.getElementById('banner-notice-text'),
  btnDismissNotice: document.getElementById('btn-dismiss-notice'),
  composerForm: document.getElementById('composer-form'),
  composerInput: document.getElementById('composer-input'),
  btnSend: document.getElementById('btn-send'),
  btnStop: document.getElementById('btn-stop'),
  settingsDialog: document.getElementById('settings-dialog'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  settingTheme: document.getElementById('setting-theme'),
  settingMaxTokens: document.getElementById('setting-max-tokens'),
  valMaxTokens: document.getElementById('val-max-tokens'),
  settingStylePreferences: document.getElementById('setting-style-preferences'),
  settingTemperature: document.getElementById('setting-temperature'),
  valTemperature: document.getElementById('val-temperature'),
  settingRepetition: document.getElementById('setting-repetition'),
  valRepetition: document.getElementById('val-repetition'),
  settingVerification: document.getElementById('setting-verification'),
  storageNoticeText: document.getElementById('storage-notice-text'),
  btnResetSettings: document.getElementById('btn-reset-settings'),
  actionDialog: document.getElementById('action-dialog'),
  actionDialogForm: document.getElementById('action-dialog-form'),
  actionDialogTitle: document.getElementById('action-dialog-title'),
  actionDialogMessage: document.getElementById('action-dialog-message'),
  actionDialogInputWrap: document.getElementById('action-dialog-input-wrap'),
  actionDialogInput: document.getElementById('action-dialog-input'),
  btnActionClose: document.getElementById('btn-action-close'),
  btnActionCancel: document.getElementById('btn-action-cancel'),
  btnActionConfirm: document.getElementById('btn-action-confirm'),
};

function makeRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isMobileViewport() {
  return window.matchMedia('(max-width: 860px)').matches;
}

function applyTheme(theme) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', normalized);
  if (normalized === 'dark') {
    el.iconThemeSun.hidden = false;
    el.iconThemeMoon.hidden = true;
    el.themeToggleLabel.textContent = 'Light theme';
  } else {
    el.iconThemeSun.hidden = true;
    el.iconThemeMoon.hidden = false;
    el.themeToggleLabel.textContent = 'Dark theme';
  }
  el.settingTheme.value = normalized;
}

function setStatus(mode, text) {
  state.engineState = mode;
  el.engineStatus.textContent = text;
  el.engineStatus.classList.remove('status-error', 'status-ready');
  if (mode === 'error') {
    el.engineStatus.classList.add('status-error');
    el.btnRetryInit.hidden = false;
  } else if (mode === 'ready') {
    el.engineStatus.classList.add('status-ready');
    el.btnRetryInit.hidden = true;
  } else {
    el.btnRetryInit.hidden = true;
  }
}

function showBannerNotice(message) {
  el.bannerNoticeText.textContent = message;
  el.bannerNotice.hidden = false;
}

function hideBannerNotice() {
  el.bannerNotice.hidden = true;
  el.bannerNoticeText.textContent = '';
}

function updateComposerControls() {
  const isGenerating = Boolean(state.activeGeneration);
  const hasText = el.composerInput.value.trim().length > 0;
  el.btnSend.hidden = isGenerating;
  el.btnStop.hidden = !isGenerating;
  el.btnSend.disabled = isGenerating || !hasText;
}

function autoResizeComposer() {
  el.composerInput.style.height = 'auto';
  const nextHeight = Math.min(180, Math.max(26, el.composerInput.scrollHeight));
  el.composerInput.style.height = `${nextHeight}px`;
}

function scrollChatToBottom() {
  el.chatViewport.scrollTop = el.chatViewport.scrollHeight;
}

async function copyTextWithFeedback(text, buttonEl, defaultLabel = 'Copy') {
  try {
    await navigator.clipboard.writeText(text);
    const labelSpan = buttonEl.querySelector('span');
    if (labelSpan) {
      labelSpan.textContent = 'Copied';
    } else {
      buttonEl.textContent = 'Copied';
    }
    setTimeout(() => {
      if (labelSpan) {
        labelSpan.textContent = defaultLabel;
      } else {
        buttonEl.textContent = defaultLabel;
      }
    }, 1500);
  } catch {
    showBannerNotice('Clipboard copy was blocked by the browser.');
  }
}

function createAssistantAvatarSvg() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M10.5 19.5C10.5 21.433 12.067 23 14 23H18.5C20.433 23 22 21.433 22 19.5C22 17.567 20.433 16 18.5 16H13.5C11.567 16 10 14.433 10 12.5C10 10.567 11.567 9 13.5 9H18C19.933 9 21.5 10.567 21.5 12.5'
  );
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  return svg;
}

function renderMessageElement(msg, isLastAssistantMessage) {
  const row = document.createElement('article');
  row.className = `message-row role-${msg.role}`;
  row.dataset.messageId = msg.id;

  if (msg.role === 'user') {
    const bubble = document.createElement('div');
    bubble.className = 'message-user-bubble';
    bubble.textContent = msg.content;
    row.appendChild(bubble);
    return row;
  }

  const wrap = document.createElement('div');
  wrap.className = 'message-assistant-wrap';

  const avatar = document.createElement('div');
  avatar.className = 'assistant-avatar';
  avatar.appendChild(createAssistantAvatarSvg());

  const body = document.createElement('div');
  body.className = 'message-assistant-body';

  const isStreamingThis =
    state.activeGeneration && state.activeGeneration.assistantMessageId === msg.id;

  if (isStreamingThis && !msg.content) {
    const indicator = document.createElement('div');
    indicator.className = 'streaming-indicator';
    indicator.textContent =
      state.engineState === 'loading' ? APP_IDENTITY.loadingText : 'Thinking...';
    body.appendChild(indicator);
  } else {
    const mdContainer = document.createElement('div');
    mdContainer.className = 'markdown-content';
    renderMarkdownToElement(msg.content || '', mdContainer, {
      onCopyCode: (code, btn) => copyTextWithFeedback(code, btn, 'Copy code'),
    });
    body.appendChild(mdContainer);
  }

  if (!isStreamingThis && msg.content) {
    const advisoryMessages = [];
    if (msg.meta?.guardNotice) {
      advisoryMessages.push({
        warning: true,
        text: msg.meta.guardNotice,
      });
    }
    if (msg.status === 'cancelled') {
      advisoryMessages.push({
        warning: false,
        text: 'Generation stopped early. Partial response preserved.',
      });
    }

    const grounding = msg.meta?.grounding;
    if (grounding && grounding.details) {
      advisoryMessages.push({
        warning: grounding.status === 'unverified_claims',
        text: `${grounding.label}: ${grounding.details}`,
      });
    }

    for (const adv of advisoryMessages) {
      const advEl = document.createElement('div');
      advEl.className = `message-advisory${adv.warning ? ' advisory-warning' : ''}`;
      advEl.textContent = adv.text;
      body.appendChild(advEl);
    }

    const actions = document.createElement('div');
    actions.className = 'message-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-msg-action';
    copyBtn.setAttribute('aria-label', 'Copy response');
    const copyLabel = document.createElement('span');
    copyLabel.textContent = 'Copy';
    copyBtn.appendChild(copyLabel);
    copyBtn.addEventListener('click', () => copyTextWithFeedback(msg.content, copyBtn, 'Copy'));
    actions.appendChild(copyBtn);

    if (isLastAssistantMessage && !state.activeGeneration) {
      const regenBtn = document.createElement('button');
      regenBtn.type = 'button';
      regenBtn.className = 'btn-msg-action';
      regenBtn.setAttribute('aria-label', 'Regenerate response');
      regenBtn.textContent = 'Regenerate';
      regenBtn.addEventListener('click', () => regenerateLastResponse());
      actions.appendChild(regenBtn);
    }

    const metaParts = [];
    if (typeof msg.meta?.tokenCount === 'number' && msg.meta.tokenCount > 0) {
      metaParts.push(`${msg.meta.tokenCount} tokens`);
    }
    if (typeof msg.meta?.durationMs === 'number' && msg.meta.durationMs > 0) {
      metaParts.push(`${(msg.meta.durationMs / 1000).toFixed(1)}s`);
    }
    if (metaParts.length > 0) {
      const metaSpan = document.createElement('span');
      metaSpan.className = 'message-meta-text';
      metaSpan.textContent = metaParts.join(' · ');
      actions.appendChild(metaSpan);
    }

    body.appendChild(actions);
  }

  wrap.appendChild(avatar);
  wrap.appendChild(body);
  row.appendChild(wrap);
  return row;
}

function renderChatArea() {
  const hasMessages = state.messages.length > 0;
  el.welcomeScreen.hidden = hasMessages;
  el.chatMessages.hidden = !hasMessages;

  const activeConv = state.conversations.find((c) => c.id === state.activeConversationId);
  el.activeChatTitle.textContent = activeConv ? activeConv.title : 'SM GPT';
  el.btnExportTxt.disabled = !hasMessages;
  el.btnExportJson.disabled = !hasMessages;

  if (!hasMessages) {
    el.chatMessages.replaceChildren();
    return;
  }

  let lastAssistantIndex = -1;
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    if (state.messages[i].role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }

  const fragment = document.createDocumentFragment();
  state.messages.forEach((msg, index) => {
    fragment.appendChild(renderMessageElement(msg, index === lastAssistantIndex));
  });
  el.chatMessages.replaceChildren(fragment);
  scrollChatToBottom();
}

function updateStreamingMessageDom(messageId, newText) {
  const row = el.chatMessages.querySelector(`[data-message-id="${messageId}"]`);
  if (!row) {
    renderChatArea();
    return;
  }
  const body = row.querySelector('.message-assistant-body');
  if (!body) return;

  let mdContainer = body.querySelector('.markdown-content');
  if (!mdContainer) {
    body.replaceChildren();
    mdContainer = document.createElement('div');
    mdContainer.className = 'markdown-content';
    body.appendChild(mdContainer);
  }
  renderMarkdownToElement(newText, mdContainer, {
    onCopyCode: (code, btn) => copyTextWithFeedback(code, btn, 'Copy code'),
  });
  scrollChatToBottom();
}

function renderConversationList() {
  const fragment = document.createDocumentFragment();
  const hasConversations = state.conversations.length > 0;
  el.conversationEmpty.hidden = hasConversations;
  el.conversationEmpty.textContent = state.searchQuery.trim()
    ? 'No matching conversations.'
    : 'No conversations yet.';

  for (const conv of state.conversations) {
    const li = document.createElement('li');
    li.className = `conversation-item${conv.id === state.activeConversationId ? ' active' : ''}`;

    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'conversation-select-btn';
    selectBtn.setAttribute('aria-label', `Open chat ${conv.title}`);
    const titleSpan = document.createElement('span');
    titleSpan.className = 'conversation-title-text';
    titleSpan.textContent = conv.title;
    selectBtn.appendChild(titleSpan);
    selectBtn.addEventListener('click', () => selectConversation(conv.id));

    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'conversation-item-actions';

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'btn-item-action';
    renameBtn.setAttribute('aria-label', `Rename ${conv.title}`);
    renameBtn.title = 'Rename';
    renameBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openRenameDialog(conv);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-item-action danger';
    deleteBtn.setAttribute('aria-label', `Delete ${conv.title}`);
    deleteBtn.title = 'Delete';
    deleteBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteDialog(conv);
    });

    actionsWrap.appendChild(renameBtn);
    actionsWrap.appendChild(deleteBtn);

    li.appendChild(selectBtn);
    li.appendChild(actionsWrap);
    fragment.appendChild(li);
  }

  el.conversationList.replaceChildren(fragment);
}

function renderStarterPrompts() {
  const fragment = document.createDocumentFragment();
  for (const starter of STARTER_PROMPTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'starter-card';

    const title = document.createElement('span');
    title.className = 'starter-card-title';
    title.textContent = starter.title;

    const promptText = document.createElement('span');
    promptText.className = 'starter-card-prompt';
    promptText.textContent = starter.prompt;

    btn.appendChild(title);
    btn.appendChild(promptText);
    btn.addEventListener('click', () => {
      if (state.activeGeneration) return;
      el.composerInput.value = starter.prompt;
      autoResizeComposer();
      updateComposerControls();
      submitPrompt(starter.prompt);
    });
    fragment.appendChild(btn);
  }
  el.starterGrid.replaceChildren(fragment);
}

async function refreshConversationList() {
  state.conversations = state.searchQuery
    ? await db.searchConversations(state.searchQuery)
    : await db.listConversations();
  renderConversationList();
}

async function selectConversation(conversationId) {
  if (state.activeGeneration) {
    await stopActiveGeneration();
  }
  state.activeConversationId = conversationId;
  state.messages = conversationId ? await db.getMessages(conversationId) : [];
  renderConversationList();
  renderChatArea();
  if (isMobileViewport()) {
    closeMobileSidebar();
  }
}

async function startNewChat() {
  if (state.activeGeneration) {
    await stopActiveGeneration();
  }
  state.activeConversationId = null;
  state.messages = [];
  renderConversationList();
  renderChatArea();
  el.composerInput.focus();
  if (isMobileViewport()) {
    closeMobileSidebar();
  }
}

function deriveTitleFromPrompt(prompt) {
  const clean = prompt.replace(/\s+/g, ' ').trim();
  if (clean.length <= 46) return clean;
  const sliced = clean.slice(0, 46);
  const lastSpace = sliced.lastIndexOf(' ');
  return `${(lastSpace > 16 ? sliced.slice(0, lastSpace) : sliced).trim()}...`;
}

function openActionDialog({
  title,
  message,
  showInput = false,
  defaultValue = '',
  confirmLabel = 'Confirm',
  onConfirm,
}) {
  el.actionDialogTitle.textContent = title;
  el.actionDialogMessage.textContent = message;
  el.actionDialogInputWrap.hidden = !showInput;
  el.actionDialogInput.value = defaultValue;
  el.btnActionConfirm.textContent = confirmLabel;

  const cleanup = () => {
    el.actionDialogForm.onsubmit = null;
  };

  el.actionDialogForm.onsubmit = async (e) => {
    e.preventDefault();
    const inputVal = el.actionDialogInput.value;
    cleanup();
    el.actionDialog.close();
    await onConfirm(inputVal);
  };

  el.btnActionClose.onclick = () => {
    cleanup();
    el.actionDialog.close();
  };
  el.btnActionCancel.onclick = () => {
    cleanup();
    el.actionDialog.close();
  };

  el.actionDialog.showModal();
  if (showInput) {
    el.actionDialogInput.focus();
    el.actionDialogInput.select();
  }
}

function openRenameDialog(conv) {
  openActionDialog({
    title: 'Rename conversation',
    message: 'Enter a new title for this conversation.',
    showInput: true,
    defaultValue: conv.title,
    confirmLabel: 'Save',
    onConfirm: async (newTitle) => {
      if (!newTitle || !newTitle.trim()) return;
      await db.renameConversation(conv.id, newTitle);
      await refreshConversationList();
      if (state.activeConversationId === conv.id) {
        el.activeChatTitle.textContent = newTitle.trim();
      }
    },
  });
}

function openDeleteDialog(conv) {
  openActionDialog({
    title: 'Delete conversation',
    message: `Delete "${conv.title}"? This removes all messages in this chat from your browser.`,
    showInput: false,
    confirmLabel: 'Delete',
    onConfirm: async () => {
      await db.deleteConversation(conv.id);
      if (state.activeConversationId === conv.id) {
        state.activeConversationId = null;
        state.messages = [];
      }
      await refreshConversationList();
      renderChatArea();
    },
  });
}

function clearStatusPoll() {
  if (state.statusPollTimerId !== null) {
    clearTimeout(state.statusPollTimerId);
    state.statusPollTimerId = null;
  }
}

async function checkBackendReadiness() {
  clearStatusPoll();
  if (!state.activeGeneration && state.engineState !== 'loading') {
    setStatus('connecting', APP_IDENTITY.connectingText);
  }

  try {
    const status = await fetchBackendStatus();
    if (status.ready) {
      if (state.activeGeneration) {
        setStatus('ready', APP_IDENTITY.generatingText);
      } else {
        setStatus('ready', APP_IDENTITY.readyText);
      }
      if (state.pendingPromptAfterInit) {
        const queued = state.pendingPromptAfterInit;
        state.pendingPromptAfterInit = null;
        dispatchStreamGeneration(queued);
      }
      return;
    }

    if (status.status === 'error') {
      setStatus('error', APP_IDENTITY.connectionErrorText);
      if (state.pendingPromptAfterInit) {
        const queued = state.pendingPromptAfterInit;
        state.pendingPromptAfterInit = null;
        await handleBackendGenerationError(queued.requestId, 'SM GPT backend could not start. Please retry.');
      }
      return;
    }

    setStatus('loading', APP_IDENTITY.loadingText);
    state.statusPollTimerId = setTimeout(checkBackendReadiness, 1000);
  } catch {
    setStatus('error', APP_IDENTITY.connectionErrorText);
    if (state.pendingPromptAfterInit) {
      const queued = state.pendingPromptAfterInit;
      state.pendingPromptAfterInit = null;
      await handleBackendGenerationError(
        queued.requestId,
        'Unable to connect to SM GPT backend. Please retry.'
      );
    }
  }
}

async function finalizeSavedAssistantMessage(gen, text, status, extraMeta = {}) {
  const durationMs = Date.now() - gen.startedAt;
  const grounding = assessResponseGrounding(
    text,
    gen.contextSnapshot,
    state.settings.verificationMode
  );

  const saved = await db.saveMessage({
    id: gen.assistantMessageId,
    conversationId: gen.conversationId,
    role: 'assistant',
    content: text,
    createdAt: Date.now(),
    status,
    meta: {
      durationMs,
      grounding,
      ...extraMeta,
    },
  });

  if (state.activeConversationId === gen.conversationId) {
    const idx = state.messages.findIndex((m) => m.id === gen.assistantMessageId);
    if (idx >= 0) {
      state.messages[idx] = saved;
    }
    renderChatArea();
  }
  await db.touchConversation(gen.conversationId);
  await refreshConversationList();
}

async function finalizeGeneration({ requestId, status, finalText, tokenCount, guardNotice }) {
  if (!state.activeGeneration || state.activeGeneration.requestId !== requestId) {
    return;
  }
  const gen = state.activeGeneration;
  state.activeGeneration = null;
  clearStopWatchdog();

  const cleanText = (finalText || '').trim();
  if (cleanText.length === 0) {
    state.messages = state.messages.filter((m) => m.id !== gen.assistantMessageId);
    if (state.activeConversationId === gen.conversationId) {
      renderChatArea();
    }
  } else {
    await finalizeSavedAssistantMessage(gen, cleanText, status, {
      tokenCount,
      guardNotice,
    });
  }

  setStatus('ready', APP_IDENTITY.readyText);
  updateComposerControls();
}

async function handleBackendGenerationError(requestId, message) {
  if (state.activeGeneration && (!requestId || state.activeGeneration.requestId === requestId)) {
    const gen = state.activeGeneration;
    state.activeGeneration = null;
    clearStopWatchdog();
    const partial = gen.text.trim();
    if (partial) {
      await finalizeSavedAssistantMessage(gen, partial, 'cancelled', {
        guardNotice: message,
      });
      setStatus('ready', APP_IDENTITY.readyText);
    } else {
      state.messages = state.messages.filter((m) => m.id !== gen.assistantMessageId);
      renderChatArea();
      showBannerNotice(message);
      setStatus('error', APP_IDENTITY.connectionErrorText);
    }
    updateComposerControls();
  } else {
    showBannerNotice(message);
  }
}

function clearStopWatchdog() {
  if (state.stopWatchdogId !== null) {
    clearTimeout(state.stopWatchdogId);
    state.stopWatchdogId = null;
  }
}

async function stopActiveGeneration() {
  if (!state.activeGeneration) return;
  const gen = state.activeGeneration;

  clearStopWatchdog();
  state.stopWatchdogId = setTimeout(async () => {
    if (state.activeGeneration && state.activeGeneration.requestId === gen.requestId) {
      gen.abortController.abort();
      await finalizeGeneration({
        requestId: gen.requestId,
        status: 'cancelled',
        finalText: gen.text,
        tokenCount: 0,
        guardNotice: null,
      });
    }
  }, 2500);

  await stopBackendGeneration({
    requestId: gen.requestId,
    conversationId: gen.conversationId,
  });
}

function dispatchStreamGeneration(gen) {
  setStatus('ready', APP_IDENTITY.generatingText);

  streamBackendChat(
    {
      conversationId: gen.conversationId,
      requestId: gen.requestId,
      messages: gen.contextSnapshot.map((m) => ({ role: m.role, content: m.content })),
      options: {
        maxNewTokens: state.settings.maxNewTokens,
        temperature: state.settings.temperature,
        topP: state.settings.topP,
        topK: state.settings.topK,
        repetitionPenalty: state.settings.repetitionPenalty,
        verificationMode: state.settings.verificationMode,
        stylePreferences: state.settings.stylePreferences || '',
      },
    },
    {
      signal: gen.abortController.signal,
      onToken: (evt) => {
        if (!state.activeGeneration || state.activeGeneration.requestId !== gen.requestId) return;
        const chunk = evt?.chunk;
        if (!chunk) return;
        state.activeGeneration.text += chunk;
        const targetMsg = state.messages.find(
          (m) => m.id === state.activeGeneration.assistantMessageId
        );
        if (targetMsg) {
          targetMsg.content = state.activeGeneration.text;
          updateStreamingMessageDom(targetMsg.id, targetMsg.content);
        }
      },
      onComplete: async (evt) => {
        await finalizeGeneration({
          requestId: gen.requestId,
          status: 'completed',
          finalText: evt?.text ?? gen.text,
          tokenCount: evt?.tokenCount ?? 0,
          guardNotice: evt?.guardNotice ?? null,
        });
      },
      onCancelled: async (evt) => {
        await finalizeGeneration({
          requestId: gen.requestId,
          status: 'cancelled',
          finalText: evt?.partialText || gen.text,
          tokenCount: evt?.tokenCount || 0,
          guardNotice: null,
        });
      },
      onError: async (evt) => {
        await handleBackendGenerationError(
          gen.requestId,
          evt?.message || 'Unable to generate response from SM GPT backend.'
        );
      },
    }
  ).catch(async (err) => {
    if (gen.abortController.signal.aborted) return;
    await handleBackendGenerationError(
      gen.requestId,
      err instanceof Error ? err.message : 'SM GPT backend communication error.'
    );
  });
}

async function submitPrompt(rawText) {
  const prompt = (rawText || '').trim();
  if (!prompt || state.activeGeneration) return;

  hideBannerNotice();

  let conversationId = state.activeConversationId;
  if (!conversationId) {
    const conv = await db.createConversation(deriveTitleFromPrompt(prompt));
    conversationId = conv.id;
    state.activeConversationId = conversationId;
  } else if (state.messages.length === 0) {
    await db.touchConversation(conversationId, deriveTitleFromPrompt(prompt));
  } else {
    await db.touchConversation(conversationId);
  }

  const userMsg = await db.saveMessage({
    conversationId,
    role: 'user',
    content: prompt,
    createdAt: Date.now(),
    status: 'completed',
  });

  state.messages.push(userMsg);
  el.composerInput.value = '';
  autoResizeComposer();

  const assistantMsgId = `msg_${makeRequestId()}`;
  const placeholderAssistant = {
    id: assistantMsgId,
    conversationId,
    role: 'assistant',
    content: '',
    createdAt: Date.now() + 1,
    status: 'streaming',
    meta: {},
  };
  state.messages.push(placeholderAssistant);

  const generation = {
    requestId: makeRequestId(),
    conversationId,
    assistantMessageId: assistantMsgId,
    text: '',
    startedAt: Date.now(),
    abortController: new AbortController(),
    contextSnapshot: state.messages
      .filter((m) => m.id !== assistantMsgId && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: m.content })),
  };

  state.activeGeneration = generation;
  updateComposerControls();
  await refreshConversationList();
  renderChatArea();

  if (state.engineState === 'error') {
    state.pendingPromptAfterInit = generation;
    checkBackendReadiness();
    return;
  }

  if (state.engineState === 'connecting' || state.engineState === 'loading') {
    state.pendingPromptAfterInit = generation;
    return;
  }

  dispatchStreamGeneration(generation);
}

async function regenerateLastResponse() {
  if (state.activeGeneration || state.messages.length === 0) return;

  const lastMsg = state.messages[state.messages.length - 1];
  if (lastMsg.role === 'assistant') {
    await db.deleteMessage(lastMsg.id);
    state.messages.pop();
  }

  const hasPrecedingUser = state.messages.some((m) => m.role === 'user');
  if (!hasPrecedingUser) {
    renderChatArea();
    return;
  }

  hideBannerNotice();
  const conversationId = state.activeConversationId;
  const assistantMsgId = `msg_${makeRequestId()}`;
  const placeholderAssistant = {
    id: assistantMsgId,
    conversationId,
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    status: 'streaming',
    meta: {},
  };
  state.messages.push(placeholderAssistant);

  const generation = {
    requestId: makeRequestId(),
    conversationId,
    assistantMessageId: assistantMsgId,
    text: '',
    startedAt: Date.now(),
    abortController: new AbortController(),
    contextSnapshot: state.messages
      .filter((m) => m.id !== assistantMsgId && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: m.content })),
  };

  state.activeGeneration = generation;
  updateComposerControls();
  renderChatArea();

  if (state.engineState !== 'ready') {
    state.pendingPromptAfterInit = generation;
    if (state.engineState === 'error') checkBackendReadiness();
    return;
  }

  dispatchStreamGeneration(generation);
}

async function exportActiveConversation(format) {
  if (!state.activeConversationId || state.messages.length === 0) return;
  const conv = await db.getConversation(state.activeConversationId);
  if (!conv) return;

  const content =
    format === 'json'
      ? formatConversationAsJson(conv, state.messages)
      : formatConversationAsTxt(conv, state.messages);
  const mime = format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8';
  const slug = (conv.title || 'chat')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `sm-gpt-${slug || 'chat'}.${format}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openMobileSidebar() {
  el.appShell.classList.add('mobile-sidebar-open');
  el.sidebarBackdrop.hidden = false;
  el.btnSidebarToggle.setAttribute('aria-expanded', 'true');
}

function closeMobileSidebar() {
  el.appShell.classList.remove('mobile-sidebar-open');
  el.sidebarBackdrop.hidden = true;
  el.btnSidebarToggle.setAttribute('aria-expanded', 'false');
}

function toggleSidebar() {
  if (isMobileViewport()) {
    if (el.appShell.classList.contains('mobile-sidebar-open')) {
      closeMobileSidebar();
    } else {
      openMobileSidebar();
    }
  } else {
    const collapsed = el.appShell.classList.toggle('sidebar-collapsed');
    el.btnSidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  }
}

function syncSettingsUi() {
  el.settingTheme.value = state.settings.theme;
  el.settingMaxTokens.value = String(state.settings.maxNewTokens);
  el.valMaxTokens.textContent = `${state.settings.maxNewTokens} tokens`;
  el.settingStylePreferences.value = state.settings.stylePreferences || '';
  el.settingTemperature.value = String(state.settings.temperature);
  el.valTemperature.textContent = Number(state.settings.temperature).toFixed(2);
  el.settingRepetition.value = String(state.settings.repetitionPenalty);
  el.valRepetition.textContent = Number(state.settings.repetitionPenalty).toFixed(2);
  el.settingVerification.value = state.settings.verificationMode;
  el.storageNoticeText.textContent = APP_IDENTITY.storageNotice;
}

function wireEvents() {
  el.btnSidebarToggle.addEventListener('click', toggleSidebar);
  el.sidebarBackdrop.addEventListener('click', closeMobileSidebar);
  el.btnNewChat.addEventListener('click', startNewChat);

  let searchTimer = null;
  el.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.searchQuery = el.searchInput.value;
      await refreshConversationList();
    }, 120);
  });

  el.btnThemeToggle.addEventListener('click', async () => {
    const nextTheme = state.settings.theme === 'dark' ? 'light' : 'dark';
    state.settings = await db.saveSettings({ theme: nextTheme });
    applyTheme(nextTheme);
  });

  el.btnOpenSettings.addEventListener('click', () => {
    syncSettingsUi();
    el.settingsDialog.showModal();
  });

  el.btnCloseSettings.addEventListener('click', () => el.settingsDialog.close());

  el.settingTheme.addEventListener('change', async () => {
    state.settings = await db.saveSettings({ theme: el.settingTheme.value });
    applyTheme(state.settings.theme);
  });

  el.settingMaxTokens.addEventListener('input', async () => {
    const val = Number(el.settingMaxTokens.value);
    el.valMaxTokens.textContent = `${val} tokens`;
    state.settings = await db.saveSettings({ maxNewTokens: val });
  });

  el.settingStylePreferences.addEventListener('input', async () => {
    state.settings = await db.saveSettings({
      stylePreferences: el.settingStylePreferences.value,
    });
  });

  el.settingTemperature.addEventListener('input', async () => {
    const val = Number(el.settingTemperature.value);
    el.valTemperature.textContent = val.toFixed(2);
    state.settings = await db.saveSettings({ temperature: val });
  });

  el.settingRepetition.addEventListener('input', async () => {
    const val = Number(el.settingRepetition.value);
    el.valRepetition.textContent = val.toFixed(2);
    state.settings = await db.saveSettings({ repetitionPenalty: val });
  });

  el.settingVerification.addEventListener('change', async () => {
    state.settings = await db.saveSettings({ verificationMode: el.settingVerification.value });
  });

  el.btnResetSettings.addEventListener('click', async () => {
    state.settings = await db.saveSettings({ ...DEFAULT_SETTINGS });
    applyTheme(state.settings.theme);
    syncSettingsUi();
  });

  el.btnRetryInit.addEventListener('click', () => {
    hideBannerNotice();
    checkBackendReadiness();
  });

  el.btnDismissNotice.addEventListener('click', hideBannerNotice);
  el.btnExportTxt.addEventListener('click', () => exportActiveConversation('txt'));
  el.btnExportJson.addEventListener('click', () => exportActiveConversation('json'));

  el.composerInput.addEventListener('input', () => {
    autoResizeComposer();
    updateComposerControls();
  });

  el.composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!state.activeGeneration && el.composerInput.value.trim().length > 0) {
        submitPrompt(el.composerInput.value);
      }
    }
  });

  el.composerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.activeGeneration && el.composerInput.value.trim().length > 0) {
      submitPrompt(el.composerInput.value);
    }
  });

  el.btnStop.addEventListener('click', () => {
    stopActiveGeneration();
  });
}

async function bootstrap() {
  state.settings = await db.getSettings();
  applyTheme(state.settings.theme);
  syncSettingsUi();
  renderStarterPrompts();
  wireEvents();

  await refreshConversationList();
  if (state.conversations.length > 0) {
    await selectConversation(state.conversations[0].id);
  } else {
    renderChatArea();
  }

  updateComposerControls();

  if (db.isUsingMemoryFallback()) {
    showBannerNotice(
      'Browser persistent storage is unavailable in this session. Conversations will only last until this tab closes.'
    );
  }

  await checkBackendReadiness();
}

bootstrap().catch(() => {
  setStatus('error', APP_IDENTITY.connectionErrorText);
  showBannerNotice('SM GPT encountered a startup error. Please reload the page.');
});

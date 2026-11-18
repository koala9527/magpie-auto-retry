(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const text = (node, value) => {
    const next = String(value);
    if (node.textContent !== next) node.textContent = next;
  };
  const within = (node, selector, value) => text(node.querySelector(selector), value);
  const TOKEN = document.querySelector('meta[name="auto-retry-token"]')?.content.trim();
  const hasToken = Boolean(TOKEN && TOKEN !== '__ADMIN_TOKEN__');
  const HOUR = 3_600_000;
  const PERIODS = { '24h': { hours: 24, label: '过去 24 小时' }, '7d': { hours: 168, label: '过去 7 天' }, '30d': { hours: 720, label: '过去 30 天' } };
  const DEFAULTS = Object.freeze({
    enabled: true, upstreamUrl: 'http://127.0.0.1:3425', initialDelayMs: 2000,
    maxDelayMs: 60000, jitter: true, attemptTimeoutMs: 120000,
    streamIdleTimeoutMs: 120000, heartbeatMs: 10000, maxConcurrentRequests: 32, historyDays: 30,
  });
  const RANGES = {
    initialDelayMs: [100, 60000, '初始退避', true], maxDelayMs: [100, 3600000, '最大退避', true],
    attemptTimeoutMs: [1000, 600000, '单次请求超时', true], streamIdleTimeoutMs: [1000, 600000, '流空闲超时', true],
    heartbeatMs: [1000, 30000, '等待心跳', true], maxConcurrentRequests: [1, 256, '最大并发请求', false], historyDays: [1, 90, '历史保留天数', false],
  };
  const SETTINGS_KEYS = Object.keys(DEFAULTS);
  const TOTAL_KEYS = ['requests', 'successes', 'failures', 'retries', 'recoveredRequests', 'failedRequests', 'cancelledRequests', 'interruptedStreams', 'activeRequests', 'waitingRequests', 'availableMs', 'unavailableMs', 'observedMs'];
  const PROVIDER_KEYS = ['requests', 'successes', 'failures', 'retries', 'recoveredRequests', 'availableMs', 'unavailableMs', 'observedMs', 'consecutiveFailures'];
  const counter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const calendar = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

  let period = '24h';
  let latest = null;
  let connected = false;
  let pollTimer;
  let requestController;
  let requestSerial = 0;
  let refreshing = false;
  let saving = false;
  let exporting = false;
  let resetting = false;
  let persistedSettings = null;
  let dirty = false;
  let editRevision = 0;
  const cancelling = new Map();
  const lists = { provider: new Map(), request: new Map(), incident: new Map(), event: new Map() };

  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const count = value => nonnegative(value) && Number.isSafeInteger(value);
  const timestamp = value => nonnegative(value) && Number.isSafeInteger(value) && value <= 8_640_000_000_000_000;
  const nullableTime = value => value === null || timestamp(value);
  const rate = value => value === null || (nonnegative(value) && value <= 100);
  const string = value => typeof value === 'string';

  function duration(ms) {
    if (!nonnegative(ms)) return '—';
    const seconds = Math.floor(ms / 1000);
    if (seconds === 0) return ms > 0 ? '不足 1 秒' : '0 秒';
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分${seconds % 60 ? `${seconds % 60} 秒` : ''}`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时${minutes % 60 ? `${minutes % 60} 分` : ''}`;
    return `${Math.floor(hours / 24)} 天${hours % 24 ? `${hours % 24} 小时` : ''}`;
  }

  const date = value => value === null || !timestamp(value) ? '未观测' : calendar.format(value);
  const availability = value => value.observedMs > 0 && value.availabilityPercent !== null
    ? `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value.availabilityPercent)}%` : '—';

  function apiError(message, code = '', fields = null) {
    const error = new Error(message);
    error.code = code;
    error.fields = fields;
    return error;
  }

  async function api(path, { method = 'GET', body, signal } = {}) {
    if (!hasToken) throw apiError('页面令牌缺失，请从 Magpie 或本机服务重新打开仪表台。', 'missing_token');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
    try {
      // Relative paths retain Magpie web's service prefix. Never forward the token across redirects.
      const response = await fetch(path, {
        method, signal: controller.signal, cache: 'no-store', credentials: 'same-origin',
        redirect: 'error',
        headers: { Accept: 'application/json', 'X-Auto-Retry-Token': TOKEN,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let data;
      try { data = await response.json(); }
      catch { throw apiError(`服务返回的数据不是有效 JSON（HTTP ${response.status}）。`, 'invalid_json'); }
      if (!response.ok) {
        const message = object(data?.error) && string(data.error.message)
          ? data.error.message.slice(0, 600) : `管理接口返回 HTTP ${response.status}。`;
        throw apiError(message, data?.error?.code, data?.error?.fields);
      }
      return data;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timedOut) throw apiError('管理接口响应超时（10 秒），尚未取得新的服务数据。', 'timeout');
      if (error.code) throw error;
      throw apiError('管理服务连接失败，请检查 Magpie Auto Retry 是否仍在运行。', 'connection_failed');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  function validSettings(settings) {
    return object(settings) && typeof settings.enabled === 'boolean' && typeof settings.jitter === 'boolean'
      && string(settings.upstreamUrl) && settings.upstreamUrl.trim().length > 0
      && Object.entries(RANGES).every(([key, [min, max]]) => Number.isSafeInteger(settings[key]) && settings[key] >= min && settings[key] <= max)
      && settings.maxDelayMs >= settings.initialDelayMs;
  }

  function validateSnapshot(state, requestedPeriod) {
    const invalid = () => { throw apiError('服务快照数据不完整或字段无效；未将其作为正常状态显示。', 'invalid_snapshot'); };
    if (!object(state) || !string(state.version) || !timestamp(state.generatedAt) || state.period !== requestedPeriod
      || !validSettings(state.settings) || !object(state.server) || !object(state.totals)
      || !['providers', 'activeRequests', 'incidents', 'events'].every(key => Array.isArray(state[key]))) invalid();
    if (!Number.isInteger(state.server.port) || state.server.port < 1 || state.server.port > 65535
      || !string(state.server.proxyUrl) || !string(state.server.upstreamUrl) || !string(state.server.storageStatus)
      || !timestamp(state.server.runningSince) || !nonnegative(state.server.uptimeMs)
      || !TOTAL_KEYS.every(key => nonnegative(state.totals[key])) || !rate(state.totals.availabilityPercent)) invalid();
    for (const key of ['providers', 'activeRequests', 'incidents', 'events']) {
      const ids = new Set();
      for (const entry of state[key]) {
        if (!object(entry) || !string(entry.id) || !entry.id || ids.has(entry.id)) invalid();
        ids.add(entry.id);
      }
    }
    for (const provider of state.providers) {
      if (!string(provider.name) || !string(provider.status) || !string(provider.attribution)
        || !PROVIDER_KEYS.every(key => nonnegative(provider[key])) || !rate(provider.availabilityPercent)
        || !nullableTime(provider.lastSuccessAt) || !nullableTime(provider.lastFailureAt)
        || !Array.isArray(provider.buckets)) invalid();
      for (const bucket of provider.buckets) {
        if (!object(bucket) || !timestamp(bucket.startAt) || !nonnegative(bucket.availableMs) || !nonnegative(bucket.unavailableMs)
          || !['requests', 'successes', 'failures', 'retries', 'recoveredRequests'].every(key => nonnegative(bucket[key]))) invalid();
      }
    }
    for (const request of state.activeRequests) {
      if (!string(request.providerId) || !string(request.model) || !timestamp(request.startedAt) || !count(request.attempt)
        || !nullableTime(request.nextRetryAt) || !string(request.status) || typeof request.hasOutput !== 'boolean') invalid();
    }
    for (const incident of state.incidents) {
      if (!string(incident.providerId) || !string(incident.providerName) || !timestamp(incident.startedAt)
        || !nullableTime(incident.endedAt) || !nonnegative(incident.durationMs) || !count(incident.failures) || !string(incident.reason)) invalid();
    }
    for (const event of state.events) {
      if (!timestamp(event.time) || !string(event.type) || !string(event.providerId)
        || (event.delayMs != null && !nonnegative(event.delayMs)) || (event.attempt != null && !count(event.attempt))
        || (event.status != null && !count(event.status)) || (event.code != null && !string(event.code))) invalid();
    }
    return state;
  }

  function notify(id, message, kind = 'success') {
    $(id).dataset.kind = kind;
    text($(id), message);
  }

  function updateControls() {
    $('refresh-button').disabled = refreshing || !hasToken;
    $('reconnect-button').disabled = refreshing || !hasToken;
    $('settings-fields').disabled = !persistedSettings;
    $('save-button').disabled = !connected || !persistedSettings || !dirty || saving;
    $('defaults-button').disabled = !persistedSettings || saving;
    $('export-button').disabled = !connected || exporting;
    $('reset-statistics').disabled = !connected || resetting;
    $('confirm-reset').disabled = !connected || resetting;
    $('copy-proxy').disabled = !connected || !latest?.server.proxyUrl;
    $('save-button').firstChild.textContent = saving ? '保存中…' : '保存设置';
    text($('export-button'), exporting ? '导出中…' : '导出 JSON');
    text($('confirm-reset'), resetting ? '重置中…' : '确认重置');
    $('dirty-state').dataset.dirty = String(dirty);
    text($('dirty-state'), !persistedSettings ? '等待读取设置' : dirty ? '有未保存更改' : '已与服务同步');
    for (const [id, node] of lists.request) {
      const button = node.querySelector('.request-cancel');
      button.disabled = !connected || cancelling.has(id);
      text(button, cancelling.get(id) === 'submitted' ? '等待取消确认' : cancelling.has(id) ? '取消中…' : '取消请求');
    }
  }

  function connectionError(error) {
    connected = false;
    $('connection-label').dataset.state = 'error';
    $('connection-dot').dataset.state = 'error';
    text($('connection-label'), latest ? '连接中断' : '未连接');
    text($('connection-error-title'), error.code === 'missing_token' ? '页面令牌缺失' : '连接失败');
    text($('connection-error-detail'), `${error.message}${latest
      ? ` 当前显示最近一次成功快照（${date(latest.generatedAt)}，${PERIODS[latest.period].label}），不是实时状态。`
      : ' 尚未取得服务数据；没有将未知状态记作正常空态。'}`);
    $('connection-banner').hidden = false;
    if (!latest) text($('providers-empty-detail'), '尚未取得服务数据；连接成功后才会显示真实提供商观测。');
    updateControls();
  }

  function setBadge(node, status, labels) {
    const known = Object.hasOwn(labels, status);
    node.className = `state-badge ${node.dataset.baseClass || ''} state-${known ? status : 'unknown'}`;
    text(node, known ? labels[status] : '状态未知');
  }

  // Keyed nodes survive polling, preserving focused buttons and form controls.
  function reconcile(kind, entries, update) {
    const nodes = lists[kind];
    const parent = $(`${kind}-list`);
    const present = new Set(entries.map(entry => entry.id));
    for (const [id, node] of nodes) {
      if (!present.has(id)) { node.remove(); nodes.delete(id); }
    }
    entries.forEach((entry, index) => {
      let node = nodes.get(entry.id);
      if (!node) {
        node = $(`${kind}-template`).content.firstElementChild.cloneNode(true);
        nodes.set(entry.id, node);
        if (kind === 'provider') bindBand(node);
        if (kind === 'request') node.querySelector('.request-cancel').addEventListener('click', () => cancelRequest(entry.id));
      }
      if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
      update(node, entry);
    });
  }

  function bindBand(node) {
    const band = node.querySelector('.hour-band');
    const detail = node.querySelector('.hour-detail');
    detail.setAttribute('aria-live', 'polite');
    const select = button => {
      if (!button || button.parentElement !== band) return;
      for (const cell of band.children) cell.tabIndex = cell === button ? 0 : -1;
      text(detail, button.title);
    };
    band.addEventListener('focusin', event => select(event.target));
    band.addEventListener('click', event => select(event.target));
    band.addEventListener('pointerover', event => {
      if (event.target.classList.contains('hour-cell')) text(detail, event.target.title);
    });
    band.addEventListener('keydown', event => {
      const cells = Array.from(band.children);
      const index = cells.indexOf(event.target);
      if (index < 0) return;
      const destinations = { ArrowLeft: index - 1, ArrowRight: index + 1, ArrowUp: index - 24, ArrowDown: index + 24, Home: 0, End: cells.length - 1 };
      if (!Object.hasOwn(destinations, event.key)) return;
      event.preventDefault();
      cells[Math.max(0, Math.min(cells.length - 1, destinations[event.key]))].focus();
    });
  }

  function renderBand(node, provider) {
    const band = node.querySelector('.hour-band');
    const hours = PERIODS[latest.period].hours;
    const start = Math.floor(latest.generatedAt / HOUR) * HOUR - (hours - 1) * HOUR;
    const buckets = new Map(provider.buckets.map(bucket => [Math.floor(bucket.startAt / HOUR) * HOUR, bucket]));
    band.dataset.period = latest.period;
    band.setAttribute('aria-label', `${provider.name}，${PERIODS[latest.period].label}小时观测；方向键查看，Home 和 End 跳到首尾。`);
    if (band.children.length !== hours) {
      const focused = band.contains(document.activeElement);
      const selected = Math.max(0, Array.from(band.children).indexOf(document.activeElement));
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < hours; index += 1) {
        const button = document.createElement('button');
        button.type = 'button'; button.tabIndex = index === Math.min(selected, hours - 1) ? 0 : -1;
        fragment.append(button);
      }
      band.replaceChildren(fragment);
      if (focused) band.children[Math.min(selected, hours - 1)].focus({ preventScroll: true });
    }
    Array.from(band.children).forEach((button, index) => {
      const time = start + index * HOUR;
      const bucket = buckets.get(time);
      const availableMs = bucket?.availableMs || 0;
      const unavailableMs = bucket?.unavailableMs || 0;
      const status = availableMs > 0 ? unavailableMs > 0 ? 'mixed' : 'healthy' : unavailableMs > 0 ? 'outage' : 'unknown';
      const label = { healthy: '可用', outage: '故障', mixed: '可用与故障混合', unknown: '未知，没有观测' }[status];
      button.className = `hour-cell hour-${status}`;
      button.title = `${date(time)} — ${date(time + HOUR)} · ${label} · 观测可用 ${duration(availableMs)} / 故障 ${duration(unavailableMs)} · 请求 ${counter.format(bucket?.requests || 0)} / 重试 ${counter.format(bucket?.retries || 0)}`;
      button.setAttribute('aria-label', button.title);
    });
    within(node, '.band-start', date(start));
    within(node, '.band-end', `${date(start + hours * HOUR)} 现在`);
    const detail = node.querySelector('.hour-detail');
    if (band.contains(document.activeElement)) text(detail, document.activeElement.title);
    else if (!detail.textContent) text(detail, '小时详情：移动指针或使用方向键查看观测；灰色斜纹表示未知。');
  }

  function renderProviders() {
    const entries = latest.providers;
    text($('provider-count'), counter.format(entries.length));
    $('providers-empty').hidden = entries.length > 0;
    text($('providers-empty-title'), '尚无提供商观测');
    text($('providers-empty-detail'), '把 Agent 的 API 基址指向下方地址。收到第一条真实请求后，提供商和小时观测将从这里开始；未观测不等于可用。');
    reconcile('provider', entries, (node, provider) => {
      within(node, '.provider-name', provider.name);
      within(node, '.provider-attribution', provider.attribution === 'requested-model' ? '按请求模型归属 · 路由别名不代表实际提供商' : provider.attribution === 'gateway' ? '网关提供商归属' : '归属来源未知');
      const badge = node.querySelector('.provider-status'); badge.dataset.baseClass = 'provider-status';
      setBadge(badge, provider.status, { healthy: '可用', outage: '故障中', unknown: '未知' });
      within(node, '.provider-availability', availability(provider));
      within(node, '.provider-failures', `${counter.format(provider.failures)} / ${counter.format(provider.retries)}`);
      within(node, '.provider-recovered', counter.format(provider.recoveredRequests));
      within(node, '.provider-last', `最近成功 ${date(provider.lastSuccessAt)} · 最近失败 ${date(provider.lastFailureAt)}${provider.lastErrorCode ? ` · ${provider.lastErrorCode}` : ''} · 观测 ${duration(provider.observedMs)}`);
      renderBand(node, provider);
    });
  }

  function providerName(id) { return latest.providers.find(provider => provider.id === id)?.name || id || '未归属提供商'; }

  function renderRequestTime(node, request) {
    within(node, '.request-age', `开始于 ${date(request.startedAt)} · 已持续 ${duration(Math.max(0, Date.now() - request.startedAt))}`);
    within(node, '.request-retry', request.nextRetryAt === null ? '' : request.nextRetryAt > Date.now()
      ? `距下次重试 ${Math.ceil((request.nextRetryAt - Date.now()) / 1000)} 秒` : '退避已到期，等待服务更新');
  }

  function renderRequests() {
    const entries = latest.activeRequests;
    text($('active-count'), counter.format(entries.length));
    text($('nav-request-count'), counter.format(entries.length));
    $('requests-empty').hidden = entries.length > 0;
    text($('requests-empty-title'), '当前没有活跃请求');
    text($('requests-empty-detail'), '服务尚未持有请求；有请求进行中或等待重试时，会在这里显示。');
    for (const id of cancelling.keys()) if (!entries.some(request => request.id === id)) cancelling.delete(id);
    reconcile('request', entries, (node, request) => {
      const badge = node.querySelector('.request-status'); badge.dataset.baseClass = 'request-status';
      setBadge(badge, request.status, { requesting: '请求中', waiting: '等待重试', streaming: '流式输出' });
      within(node, '.request-provider', providerName(request.providerId));
      within(node, '.request-id', `#${request.id.slice(0, 12)}`);
      within(node, '.request-model', request.model);
      within(node, '.request-attempt', `第 ${counter.format(request.attempt)} 次尝试`);
      within(node, '.request-output', request.hasOutput ? '已产生输出 · 不从头重放' : '尚未产生语义输出');
      const button = node.querySelector('.request-cancel');
      button.setAttribute('aria-label', `取消请求 ${request.model}`);
      renderRequestTime(node, request);
    });
  }

  function renderActivity() {
    text($('activity-period'), PERIODS[latest.period].label);
    text($('incident-count'), counter.format(latest.incidents.length));
    text($('event-count'), counter.format(latest.events.length));
    $('incidents-empty').hidden = latest.incidents.length > 0;
    $('events-empty').hidden = latest.events.length > 0;
    text($('incidents-empty-detail'), '这一时间范围内尚无故障区间。无观测不代表所有提供商都正常。');
    text($('events-empty-detail'), '这一时间范围内尚无事件。收到真实请求后开始记录。');
    reconcile('incident', latest.incidents, (node, incident) => {
      within(node, '.incident-provider', incident.providerName || providerName(incident.providerId));
      const badge = node.querySelector('.incident-status'); badge.dataset.baseClass = 'incident-status';
      setBadge(badge, incident.endedAt === null ? 'outage' : 'healthy', { outage: '进行中', healthy: '已恢复' });
      within(node, '.incident-reason', incident.reason);
      within(node, '.incident-time', `${date(incident.startedAt)} → ${incident.endedAt === null ? '尚未结束' : date(incident.endedAt)}`);
      within(node, '.incident-duration', `持续 ${duration(incident.durationMs)}`);
      within(node, '.incident-failures', `${counter.format(incident.failures)} 次失败`);
    });
    const types = { retry: '安排重试', failure: '尝试失败', recovered: '请求恢复', success: '请求成功',
      cancelled: '请求取消', cancel: '请求取消', terminated: '请求终止', failed: '请求终止',
      interrupted: '流式输出中断', interrupted_stream: '流式输出中断', outage: '故障开始', recovery: '观测恢复' };
    reconcile('event', latest.events, (node, event) => {
      within(node, '.event-type', Object.hasOwn(types, event.type) ? types[event.type] : `事件 · ${event.type}`);
      within(node, '.event-provider', providerName(event.providerId));
      const time = node.querySelector('.event-time'); text(time, date(event.time)); time.dateTime = new Date(event.time).toISOString();
      within(node, '.event-details', [event.code, event.status != null ? `HTTP ${event.status}` : '',
        event.attempt != null ? `第 ${event.attempt} 次` : '', event.delayMs != null ? `退避 ${duration(event.delayMs)}` : ''].filter(Boolean).join(' · '));
    });
  }

  function renderMetrics() {
    const totals = latest.totals;
    for (const node of document.querySelectorAll('[data-metric]')) {
      const key = node.dataset.metric;
      text(node, key === 'policy' ? '∞' : key === 'availabilityPercent' ? availability(totals)
        : key === 'availableMs' ? duration(totals.availableMs) : counter.format(totals[key]));
    }
    for (const node of document.querySelectorAll('[data-total]')) text(node, counter.format(totals[node.dataset.total]));
    text($('policy-detail'), latest.settings.enabled ? '已启用 · 无次数与总时长上限' : '已停用 · 无限重试策略未启用');
    text($('waiting-detail'), `${counter.format(totals.activeRequests)} 个活跃请求 · 当前值`);
    text($('failures-detail'), `${counter.format(totals.retries)} 次重试 · 所选时间范围`);
    text($('observed-detail'), `总观测 ${duration(totals.observedMs)}`);
    text($('availability-detail'), totals.observedMs > 0 ? `故障观测 ${duration(totals.unavailableMs)}` : '尚无观测 · 不记作 100%');
    text($('display-period'), PERIODS[latest.period].label);
    text($('snapshot-time'), `快照 ${clock.format(latest.generatedAt)} · 每 3 秒刷新`);
  }

  function renderService() {
    text($('sidebar-version'), `v${latest.version}`);
    $('proxy-url').value = latest.server.proxyUrl;
    text($('runtime-upstream'), latest.server.upstreamUrl);
    text($('service-uptime'), duration(latest.server.uptimeMs));
    const status = latest.server.storageStatus;
    $('storage-banner').hidden = status === 'ok';
    text($('storage-status'), status === 'ok' ? '已持久化' : status === 'memory-only' ? '仅内存 · 未持久化' : '存储状态未知');
    if (status !== 'ok') {
      text($('storage-title'), status === 'memory-only' ? '统计存储降级' : '存储状态未知');
      text($('storage-detail'), status === 'memory-only'
        ? '聚合统计仅保存在内存，服务重启后可能丢失。当前观测仍可查看；请检查本机数据目录的写入状态。'
        : `服务返回了未识别的存储状态「${status}」，尚未确认统计已持久化。`);
    }
  }

  function fillSettings(settings) {
    for (const key of SETTINGS_KEYS) {
      if (typeof DEFAULTS[key] === 'boolean') $(key).checked = settings[key];
      else $(key).value = RANGES[key]?.[3] ? settings[key] / 1000 : settings[key];
    }
  }

  function clearErrors() {
    for (const key of SETTINGS_KEYS) { $(key).removeAttribute('aria-invalid'); $(`${key}-error`).hidden = true; text($(`${key}-error`), ''); }
  }

  function syncNote() {
    const mismatch = latest && latest.period !== period;
    $('sync-note').hidden = !mismatch;
    if (mismatch) text($('sync-note'), `${refreshing ? '正在读取' : '尚未取得'}${PERIODS[period].label}；以下仍为${PERIODS[latest.period].label}的最近一次成功快照。`);
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    requestSerial += 1;
    requestController?.abort();
    requestController = null;
    refreshing = false;
  }

  async function refresh(manual = false) {
    clearTimeout(pollTimer);
    if (!hasToken) { connectionError(apiError('请从 Magpie 或本机服务重新打开页面以取得本次启动的令牌。', 'missing_token')); return; }
    if (document.hidden) return;
    const serial = ++requestSerial;
    requestController?.abort();
    const controller = new AbortController(); requestController = controller;
    refreshing = true; updateControls(); syncNote();
    $('provider-list').setAttribute('aria-busy', 'true');
    try {
      const state = validateSnapshot(await api(`api/state?period=${period}`, { signal: controller.signal }), period);
      if (serial !== requestSerial || controller.signal.aborted) return;
      const first = latest === null;
      latest = state; connected = true;
      $('connection-label').dataset.state = 'connected'; $('connection-dot').dataset.state = 'connected';
      text($('connection-label'), '管理服务已连接'); $('connection-banner').hidden = true;
      renderMetrics(); renderProviders(); renderRequests(); renderActivity(); renderService(); scheduleNavigation();
      if (!saving) {
        persistedSettings = { ...state.settings };
        if (!dirty) { fillSettings(persistedSettings); clearErrors(); }
      }
      if (first) notify('form-status', '设置已读取；修改后按保存才会生效。');
      renderPreview();
      if (manual) notify('action-status', '数据已刷新。');
    } catch (error) {
      if (serial === requestSerial && !controller.signal.aborted) connectionError(error);
    } finally {
      if (serial === requestSerial) {
        refreshing = false; requestController = null;
        $('provider-list').setAttribute('aria-busy', 'false');
        updateControls(); syncNote();
        if (!document.hidden && hasToken) pollTimer = setTimeout(() => refresh(), 3000);
      }
    }
  }

  function readForm() {
    const values = { enabled: $('enabled').checked, jitter: $('jitter').checked, upstreamUrl: $('upstreamUrl').value.trim() };
    const errors = {};
    for (const [key, [min, max, label, seconds]] of Object.entries(RANGES)) {
      const raw = $(key).value.trim();
      const value = raw === '' ? NaN : Number(raw) * (seconds ? 1000 : 1);
      const rounded = Math.round(value);
      if (!Number.isFinite(value) || !Number.isSafeInteger(rounded) || Math.abs(value - rounded) > .00001 || value < min || value > max) {
        errors[key] = `${label}须填写 ${seconds ? min / 1000 : min}–${seconds ? max / 1000 : max}${seconds ? ' 秒，最多三位小数' : '之间的整数'}。`;
      } else values[key] = rounded;
    }
    if (values.maxDelayMs < values.initialDelayMs) errors.maxDelayMs = '最大退避不得小于初始退避。';
    try {
      const url = new URL(values.upstreamUrl);
      if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) throw new Error();
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      if (latest && port === latest.server.port) errors.upstreamUrl = '上游端口不得与重试服务相同，以免请求回环。';
      values.upstreamUrl = url.origin;
    } catch { errors.upstreamUrl = '请输入本机 Magpie 的 HTTP(S) 地址，仅支持 127.0.0.1、localhost 或 [::1]，不含账号或查询参数，路径仅支持根地址或 /v1。'; }
    return { values, errors };
  }

  function showFieldErrors(errors) {
    clearErrors();
    for (const [key, message] of Object.entries(errors)) {
      if (!SETTINGS_KEYS.includes(key)) continue;
      $(key).setAttribute('aria-invalid', 'true');
      text($(`${key}-error`), string(message) ? message : '此字段未通过服务校验。');
      $(`${key}-error`).hidden = false;
    }
  }

  function renderPreview() {
    if (!persistedSettings) return;
    const { values, errors } = readForm();
    text($('policy-preview'), Object.keys(errors).length ? '参数尚未填写完整或未通过校验。修正后再保存；运行中的服务设置没有改变。'
      : !values.enabled ? '表单规则：自动重试停用。保存前不会改变服务；活跃请求以服务实际状态为准。'
        : `表单规则：临时失败后持续重试；先等 ${values.initialDelayMs / 1000} 秒，之后逐次加倍，普通等待每次最多 ${values.maxDelayMs / 1000} 秒。${values.jitter ? '等待时间有随机浮动' : '没有随机浮动'}；最多同时接待 ${values.maxConcurrentRequests} 个请求。${dirty ? ' 尚未保存。' : ''}`);
  }

  function setupTheme() {
    const query = new URLSearchParams(location.search);
    const theme = query.get('theme');
    const lang = query.get('lang');
    if (lang && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang)) document.documentElement.lang = lang;
    const media = matchMedia('(prefers-color-scheme: dark)');
    $('theme-select').value = theme === 'dark' || theme === 'light' ? theme : 'system';
    const apply = () => { document.documentElement.dataset.theme = $('theme-select').value === 'system' ? media.matches ? 'dark' : 'light' : $('theme-select').value; };
    apply(); media.addEventListener('change', apply);
    $('theme-select').addEventListener('change', () => {
      apply();
      const url = new URL(location.href);
      if ($('theme-select').value === 'system') url.searchParams.delete('theme');
      else url.searchParams.set('theme', $('theme-select').value);
      history.replaceState(null, '', url);
    });
  }

  $('settings-form').addEventListener('input', event => {
    if (!SETTINGS_KEYS.includes(event.target.id)) return;
    editRevision += 1; dirty = true;
    event.target.removeAttribute('aria-invalid');
    $(`${event.target.id}-error`).hidden = true;
    notify('form-status', saving ? '正在保存先前修改；新的编辑尚未保存。' : '有未保存更改，确认后按保存。');
    renderPreview(); updateControls();
  });

  $('defaults-button').addEventListener('click', () => {
    if (!persistedSettings || saving) return;
    fillSettings(DEFAULTS); clearErrors(); editRevision += 1; dirty = true;
    notify('form-status', '默认值已回填，尚未保存。确认后按保存设置。');
    renderPreview(); updateControls();
  });

  // Magpie's allow-scripts iframe cannot dispatch native form submissions.
  // Both the button and Enter invoke PATCH directly; no allow-forms permission is needed.
  $('save-button').type = 'button';
  $('save-button').addEventListener('click', saveSettings);
  $('settings-form').addEventListener('submit', event => { event.preventDefault(); saveSettings(); });
  $('settings-form').addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.matches('input:not([type="checkbox"])')) {
      event.preventDefault(); saveSettings();
    }
  });
  async function saveSettings() {
    if (!connected || !persistedSettings || !dirty || saving) return;
    const { values, errors } = readForm();
    showFieldErrors(errors);
    if (Object.keys(errors).length) {
      notify('form-status', '设置未保存，请检查标记的字段。', 'error');
      $(Object.keys(errors)[0]).focus();
      return;
    }
    const revision = editRevision;
    saving = true; stopPolling(); updateControls();
    notify('form-status', '正在保存设置…');
    try {
      const response = await api('api/settings', { method: 'PATCH', body: values });
      if (!validSettings(response?.settings)) throw apiError('保存接口返回的设置数据无效，尚未确认保存结果。', 'invalid_settings_response');
      persistedSettings = { ...response.settings };
      if (revision === editRevision) {
        dirty = false; fillSettings(persistedSettings); clearErrors();
        notify('form-status', '设置已保存，服务已确认新的运行参数。');
      } else {
        dirty = true;
        notify('form-status', '先前提交的设置已保存；保存期间的新编辑尚未保存。');
      }
    } catch (error) {
      dirty = true;
      if (object(error.fields) && revision === editRevision) {
        showFieldErrors(error.fields);
        const key = Object.keys(error.fields).find(field => SETTINGS_KEYS.includes(field));
        if (key) $(key).focus();
      }
      notify('form-status', `设置未确认保存：${error.message} 表单输入已保留。`, 'error');
      if (['connection_failed', 'timeout', 'missing_token'].includes(error.code)) connectionError(error);
    } finally {
      saving = false; renderPreview(); updateControls();
      refresh();
    }
  }

  async function cancelRequest(id) {
    if (!connected || cancelling.has(id)) return;
    const request = latest?.activeRequests.find(entry => entry.id === id);
    if (!request) return;
    cancelling.set(id, 'sending'); updateControls();
    try {
      const response = await api(`api/requests/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      if (response?.ok !== true) throw apiError('服务未确认取消结果。', 'invalid_cancel_response');
      cancelling.set(id, 'submitted');
      notify('action-status', `请求已取消：${request.model}。正在刷新当前请求状态。`);
      await refresh();
    } catch (error) {
      cancelling.delete(id);
      notify('action-status', `取消未确认：${error.message}`, 'error');
      if (['connection_failed', 'timeout'].includes(error.code)) connectionError(error);
      // A 404 is not a successful cancellation; refresh can still reveal an already ended request.
      if (error.code === 'REQUEST_NOT_FOUND') refresh();
    } finally { updateControls(); }
  }

  const exportDialog = $('export-dialog');
  const standalone = window.self === window.top;
  $('export-button').addEventListener('click', async () => {
    if (!connected || exporting) return;
    exporting = true; updateControls();
    try {
      const data = await api('api/export');
      if (!object(data) || data.error) throw apiError('导出接口返回的数据不是有效聚合记录。', 'invalid_export');
      $('export-json').value = JSON.stringify(data, null, 2);
      $('download-export').hidden = !standalone;
      notify('export-status', standalone
        ? 'JSON 已读取。下载会交由浏览器处理，页面不会确认文件已保存。'
        : 'JSON 已读取。Magpie 内嵌页面不发起下载；可全选后手动复制。');
      exportDialog.showModal();
      $('export-json').focus(); $('export-json').setSelectionRange(0, 0);
      notify('action-status', '聚合 JSON 已读取，内容可在导出弹窗中查看和复制。');
    } catch (error) { notify('action-status', `导出失败：${error.message}`, 'error'); }
    finally { exporting = false; updateControls(); }
  });
  $('select-export').addEventListener('click', () => {
    $('export-json').focus(); $('export-json').select();
    notify('export-status', 'JSON 已全选；按 Ctrl+C / Command+C，或长按复制。');
  });
  $('download-export').addEventListener('click', () => {
    if (!standalone || !exportDialog.open) return;
    notify('export-status', '正在发起下载；文件是否保存，请以浏览器的下载提示为准。');
    const blob = new Blob([$('export-json').value], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `magpie-auto-retry-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('dismiss-export').addEventListener('click', () => exportDialog.close());
  exportDialog.addEventListener('close', () => $('export-button').focus({ preventScroll: true }));

  const resetDialog = $('reset-dialog');
  $('reset-statistics').addEventListener('click', () => {
    if (!connected || resetting) return;
    text($('reset-status'), '');
    resetDialog.showModal(); $('dismiss-reset').focus();
  });
  $('dismiss-reset').addEventListener('click', () => { if (!resetting) resetDialog.close(); });
  resetDialog.addEventListener('cancel', event => { if (resetting) event.preventDefault(); });
  resetDialog.addEventListener('close', () => $('reset-statistics').focus({ preventScroll: true }));
  $('confirm-reset').addEventListener('click', async () => {
    if (!connected || resetting || !resetDialog.open) return;
    resetting = true; $('dismiss-reset').disabled = true;
    stopPolling(); updateControls(); notify('reset-status', '正在请求重置统计…');
    try {
      const response = await api('api/statistics/reset', { method: 'POST', body: { confirm: true } });
      if (response?.ok !== true) throw apiError('服务未确认统计重置结果。', 'invalid_reset_response');
      notify('action-status', '统计已重置。仍然活跃的请求保留；正在读取新的观测记录。');
      resetting = false; updateControls(); resetDialog.close();
    } catch (error) { notify('reset-status', `重置未确认：${error.message} 现有快照已保留。`, 'error'); }
    finally {
      resetting = false; $('dismiss-reset').disabled = false; updateControls();
      if (!resetDialog.open) refresh();
      else if (!document.hidden) pollTimer = setTimeout(() => refresh(), 3000);
    }
  });

  $('copy-proxy').addEventListener('click', async () => {
    if (!connected || !latest?.server.proxyUrl) return;
    try {
      await navigator.clipboard.writeText(latest.server.proxyUrl);
      notify('action-status', 'Agent API 基址已复制。模型名和 Magpie key 保持原样。');
    } catch {
      $('proxy-url').focus(); $('proxy-url').select();
      notify('action-status', '剪贴板写入未完成，地址已选中；请使用 Ctrl+C 或 Command+C 复制。', 'error');
    }
  });

  for (const button of document.querySelectorAll('[data-period]')) button.addEventListener('click', () => {
    if (period === button.dataset.period) return;
    period = button.dataset.period;
    for (const choice of document.querySelectorAll('[data-period]')) choice.setAttribute('aria-pressed', String(choice === button));
    refresh();
  });
  $('refresh-button').addEventListener('click', () => refresh(true));
  $('reconnect-button').addEventListener('click', () => refresh());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopPolling(); updateControls(); }
    else refresh();
  });
  window.addEventListener('pagehide', stopPolling);
  setInterval(() => {
    if (!document.hidden && connected && latest) for (const request of latest.activeRequests) {
      const node = lists.request.get(request.id); if (node) renderRequestTime(node, request);
    }
  }, 1000);
  const navLinks = Array.from(document.querySelectorAll('.main-nav a'));
  const navSections = navLinks.map(link => $(link.hash.slice(1)));
  let navigationQueued = false;
  let navigationTarget = null;
  for (const link of navLinks) link.addEventListener('click', () => {
    navigationTarget = $(link.hash.slice(1));
    scheduleNavigation();
  });
  function scheduleNavigation() {
    if (navigationQueued) return;
    navigationQueued = true;
    requestAnimationFrame(() => {
      navigationQueued = false;
      let current = navSections[0];
      if (window.scrollY > 24) {
        const readingLine = Math.min(360, innerHeight * .4);
        let nearestTop = -Infinity;
        for (const section of navSections) {
          const top = section.getBoundingClientRect().top;
          if (top <= readingLine && top >= nearestTop) { current = section; nearestTop = top; }
        }
        // Side-by-side sections may share a top edge; respect the clicked column
        // while it remains visible, then resume geometric scroll tracking.
        const targetRect = navigationTarget?.getBoundingClientRect();
        if (targetRect && targetRect.top < innerHeight && targetRect.bottom > 0) current = navigationTarget;
        else navigationTarget = null;
      } else {
        navigationTarget = null;
      }
      for (const link of navLinks) {
        if (link.hash === `#${current.id}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    });
  }
  window.addEventListener('scroll', scheduleNavigation, { passive: true });
  window.addEventListener('resize', scheduleNavigation, { passive: true });
  setupTheme(); updateControls(); scheduleNavigation(); refresh();
})();

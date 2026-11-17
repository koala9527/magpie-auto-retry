import { randomUUID } from 'node:crypto';

const HOUR = 3600000;
const FRESHNESS = 300000;
const COUNTERS = ['requests', 'successes', 'failures', 'retries', 'recoveredRequests', 'failedRequests', 'cancelledRequests', 'interruptedStreams'];
const emptyCounts = () => Object.fromEntries(COUNTERS.map(k => [k, 0]));
const label = (value, fallback) => typeof value === 'string' && value ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) : fallback;
const finite = v => Number.isFinite(v) && v >= 0 ? v : 0;
const records = v => Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [];

export class Statistics {
  constructor({ now = Date.now, saved, historyDays = 30 } = {}) {
    this.now = now;
    this.historyDays = historyDays;
    this.providers = new Map();
    this.active = new Map();
    this.events = [];
    this.incidents = [];
    if (saved?.schemaVersion === 1 && Array.isArray(saved.providers)) {
      for (const entry of records(saved.providers).slice(0, 512)) {
        const p = this.provider(entry.id, entry.name, entry.attribution);
        p.buckets = records(entry.buckets).slice(-90 * 24).map(b => ({
          ...emptyCounts(), startAt: finite(b.startAt), availableMs: finite(b.availableMs), unavailableMs: finite(b.unavailableMs),
          ...Object.fromEntries(COUNTERS.map(k => [k, finite(b[k])])),
        }));
        p.lastSuccessAt = typeof entry.lastSuccessAt === 'number' ? entry.lastSuccessAt : null;
        p.lastFailureAt = typeof entry.lastFailureAt === 'number' ? entry.lastFailureAt : null;
        p.lastErrorCode = label(entry.lastErrorCode, null);
      }
      this.events = records(saved.events).slice(-200).map(e => this.cleanEvent(e));
      this.incidents = records(saved.incidents).slice(-1000).map(i => ({
        id: label(i.id, randomUUID()), providerId: label(i.providerId, 'unknown'), providerName: label(i.providerName, 'Unknown'),
        startedAt: finite(i.startedAt), endedAt: typeof i.endedAt === 'number' ? i.endedAt : null,
        failures: finite(i.failures), reason: label(i.reason, 'provider_error'),
      }));
    }
    this.prune();
  }

  provider(id, name, attribution = 'requested-model') {
    id = label(id, 'unknown');
    if (!this.providers.has(id) && this.providers.size >= 511) id = 'other-routes';
    if (!this.providers.has(id)) this.providers.set(id, {
      id, name: label(name, id), attribution: attribution === 'gateway' ? 'gateway' : 'requested-model',
      status: 'unknown', lastObservationAt: null, cursor: null, lastSuccessAt: null, lastFailureAt: null,
      lastErrorCode: null, consecutiveFailures: 0, buckets: [],
    });
    return this.providers.get(id);
  }

  bucket(p, time = this.now()) {
    const startAt = Math.floor(time / HOUR) * HOUR;
    let b = p.buckets.find(b => b.startAt === startAt);
    if (!b) { b = { ...emptyCounts(), startAt, availableMs: 0, unavailableMs: 0 }; p.buckets.push(b); }
    return b;
  }

  accountTime(p, time) {
    if (p.cursor === null || p.lastObservationAt === null) return;
    const end = Math.max(p.cursor, Math.min(time, p.lastObservationAt + FRESHNESS));
    while (p.cursor < end) {
      const b = this.bucket(p, p.cursor);
      const until = Math.min(end, b.startAt + HOUR);
      b[p.status === 'healthy' ? 'availableMs' : 'unavailableMs'] += until - p.cursor;
      p.cursor = until;
    }
  }

  start({ providerId, model = '' } = {}) {
    const id = randomUUID();
    const p = this.provider(providerId);
    const time = this.now();
    this.bucket(p, time).requests++;
    this.active.set(id, { id, providerId: p.id, model: label(model, ''), startedAt: time, attempt: 0,
      nextRetryAt: null, status: 'requesting', hasOutput: false, failures: 0 });
    return id;
  }

  attribute(id, metadata) {
    const r = this.active.get(id);
    if (!r || !metadata || typeof metadata.id !== 'string') return;
    const p = this.provider(metadata.id, metadata.name, 'gateway');
    p.name = label(metadata.name, p.name);
    p.attribution = 'gateway';
    if (p.id !== r.providerId) {
      const previous = this.provider(r.providerId);
      const original = this.bucket(previous, r.startedAt);
      if (original.requests > 0) { original.requests--; this.bucket(p, r.startedAt).requests++; }
      r.providerId = p.id;
    }
  }

  activity(id, patch) {
    const r = this.active.get(id);
    if (r) Object.assign(r, patch);
  }

  failure(id, failure) {
    const r = this.active.get(id);
    if (!r) return;
    const time = this.now();
    const p = this.provider(r.providerId);
    this.accountTime(p, time);
    this.bucket(p, time).failures++;
    p.lastFailureAt = time;
    p.lastErrorCode = failure.code;
    p.consecutiveFailures++;
    p.status = 'outage';
    p.cursor = p.lastObservationAt = time;
    r.failures++;
    let incident = this.incidents.find(i => i.providerId === p.id && i.endedAt === null);
    if (!incident) {
      incident = { id: randomUUID(), providerId: p.id, providerName: p.name, startedAt: time, endedAt: null, failures: 0, reason: failure.code };
      this.incidents.push(incident);
    }
    incident.failures++;
  }

  retry(id, delayMs, failure = {}) {
    const r = this.active.get(id);
    if (!r) return;
    this.bucket(this.provider(r.providerId)).retries++;
    r.status = 'waiting';
    r.nextRetryAt = this.now() + delayMs;
    this.event(r, 'retry', { delayMs, ...failure });
  }

  success(id) {
    const r = this.active.get(id);
    if (!r) return;
    const p = this.provider(r.providerId);
    const time = this.now();
    this.accountTime(p, time);
    const b = this.bucket(p, time);
    b.successes++;
    if (r.failures > 0) { b.recoveredRequests++; this.event(r, 'recovered'); }
    for (const i of this.incidents) if (i.providerId === p.id && i.endedAt === null) i.endedAt = time;
    p.status = 'healthy';
    p.cursor = p.lastObservationAt = p.lastSuccessAt = time;
    p.consecutiveFailures = 0;
    this.active.delete(id);
  }

  finish(id, type = 'failed', failure = {}) {
    const r = this.active.get(id);
    if (!r) return;
    const b = this.bucket(this.provider(r.providerId));
    b[type === 'cancelled' ? 'cancelledRequests' : 'failedRequests']++;
    if (type === 'interrupted') b.interruptedStreams++;
    this.event(r, type, failure);
    this.active.delete(id);
  }

  cancel(id) { this.finish(id, 'cancelled'); }

  cleanEvent(e) {
    return { id: label(e.id, randomUUID()), time: finite(e.time), type: label(e.type, 'failed'), providerId: label(e.providerId, 'unknown'),
      attempt: finite(e.attempt), status: finite(e.status), delayMs: finite(e.delayMs), code: label(e.code, null) };
  }

  event(r, type, detail = {}) {
    this.events.push(this.cleanEvent({ id: randomUUID(), time: this.now(), providerId: r.providerId, attempt: r.attempt, type, ...detail }));
    this.events = this.events.slice(-200);
  }

  prune() {
    const cutoff = this.now() - this.historyDays * 86400000;
    for (const p of this.providers.values()) p.buckets = p.buckets.filter(b => b.startAt + HOUR > cutoff);
    this.events = this.events.filter(e => e.time >= cutoff).slice(-200);
    this.incidents = this.incidents.filter(i => (i.endedAt ?? this.now()) >= cutoff).slice(-1000);
  }

  snapshot(period = '24h') {
    const now = this.now();
    const windowMs = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[period] ?? 86400000;
    const cutoff = now - windowMs;
    for (const p of this.providers.values()) this.accountTime(p, now);
    this.prune();
    const providers = [...this.providers.values()].map(p => {
      const buckets = p.buckets.filter(b => b.startAt + HOUR > cutoff).sort((a, b) => a.startAt - b.startAt);
      const counts = { ...emptyCounts(), availableMs: 0, unavailableMs: 0 };
      for (const b of buckets) for (const k of Object.keys(counts)) counts[k] += b[k];
      const observedMs = counts.availableMs + counts.unavailableMs;
      return { id: p.id, name: p.name, attribution: p.attribution,
        status: p.lastObservationAt === null || now - p.lastObservationAt > FRESHNESS ? 'unknown' : p.status,
        lastSuccessAt: p.lastSuccessAt, lastFailureAt: p.lastFailureAt, lastErrorCode: p.lastErrorCode,
        consecutiveFailures: p.consecutiveFailures, ...counts, observedMs,
        availabilityPercent: observedMs > 0 ? counts.availableMs / observedMs * 100 : null, buckets };
    }).filter(p => p.requests || p.failures || p.observedMs || [...this.active.values()].some(r => r.providerId === p.id));
    const totals = { ...emptyCounts(), availableMs: 0, unavailableMs: 0 };
    for (const p of providers) for (const key of Object.keys(totals)) totals[key] += p[key];
    totals.observedMs = totals.availableMs + totals.unavailableMs;
    totals.availabilityPercent = totals.observedMs ? totals.availableMs / totals.observedMs * 100 : null;
    totals.activeRequests = this.active.size;
    totals.waitingRequests = [...this.active.values()].filter(r => r.status === 'waiting').length;
    return { period, generatedAt: now, totals, providers,
      activeRequests: [...this.active.values()].map(({ failures, ...r }) => r),
      incidents: this.incidents.filter(i => (i.endedAt ?? now) >= cutoff).map(i => ({ ...i, durationMs: Math.max(0, (i.endedAt ?? now) - i.startedAt) })).reverse(),
      events: this.events.filter(e => e.time >= cutoff).slice().reverse() };
  }

  serialize() {
    this.snapshot();
    return { schemaVersion: 1, providers: [...this.providers.values()].map(p => ({
      id: p.id, name: p.name, attribution: p.attribution, buckets: p.buckets,
      lastSuccessAt: p.lastSuccessAt, lastFailureAt: p.lastFailureAt, lastErrorCode: p.lastErrorCode,
    })), events: this.events, incidents: this.incidents };
  }

  reset() {
    this.providers.clear(); this.events = []; this.incidents = [];
    for (const r of this.active.values()) { r.failures = 0; this.bucket(this.provider(r.providerId), r.startedAt).requests++; }
  }
}

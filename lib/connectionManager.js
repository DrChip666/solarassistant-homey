'use strict';

const SolarAssistantClient = require('./solarAssistantClient');

const keyOf = (address) => String(address || '').trim().toLowerCase();

/** A missing password (null/undefined) and an empty one are the same thing. */
const credsOf = (config) => ({
  password: config.password === null || config.password === undefined ? '' : String(config.password),
  token: config.token ? String(config.token) : undefined,
});

/**
 * One Homey device's attachment to a SolarAssistant unit. Several devices (overview,
 * solar, battery, grid) can be attached to the same unit and then share a single
 * connection, instead of each opening its own websocket and polling the unit.
 */
class Lease {

  constructor(manager, handlers) {
    this.manager = manager;
    this.handlers = handlers || {};
    this.config = null;
    this.unit = null;
  }

  /** Apply changed settings (address, password, poll interval). Unchanged values do nothing. */
  update(config) {
    this.manager._update(this, config);
  }

  /** Detach from the unit. The connection is closed when the last device lets go. */
  release() {
    this.manager._detach(this);
  }

  /** Ask the unit for fresh values right now. */
  poll() {
    return this.unit ? this.unit.client.pollOnce() : Promise.resolve();
  }

  /** Write a setting to the inverter. */
  writeMetric(topic, value) {
    if (!this.unit) return Promise.reject(new Error('Not connected to a SolarAssistant unit'));
    return this.unit.client.writeMetric(topic, value);
  }

}

/**
 * Keeps one SolarAssistantClient per unit (keyed by address) and fans its messages
 * out to every device attached to that unit.
 *
 * A device attaches with acquire(config, handlers):
 *   config   { address, password, token?, pollSeconds?, preferredWsPath?, topics? }
 *            topics: single topics (beyond the totals) the device wants live
 *   handlers { onMetrics(metrics), onAlive(), onUnreachable(err), onWsPath(path) }
 *
 * The latest value of every topic is cached, because websocket messages only carry
 * changes. A device that attaches later (or after a restart) is replayed the cache,
 * so it has values straight away.
 */
class ConnectionManager {

  constructor({ homey, log, error } = {}) {
    this.homey = homey;
    this.log = log || (() => {});
    this.error = error || this.log;
    this.units = new Map();
    this._destroyed = false;
  }

  acquire(config, handlers) {
    if (!keyOf(config && config.address)) {
      throw new Error('Missing SolarAssistant address');
    }
    const lease = new Lease(this, handlers);
    this._attach(lease, config);
    return lease;
  }

  destroy() {
    this._destroyed = true;
    for (const unit of this.units.values()) {
      if (unit.client) unit.client.destroy();
      unit.leases.clear();
    }
    this.units.clear();
  }

  // --- Attaching and detaching ---------------------------------------------

  _attach(lease, config) {
    lease.config = { ...config };

    let unit = this.units.get(keyOf(config.address));
    const created = !unit;
    if (created) unit = this._createUnit(config);

    unit.leases.add(lease);
    lease.unit = unit;
    this._refreshPollSeconds(unit);
    this._refreshTopics(unit);

    // A brand-new unit has nothing to replay: the first device simply hears what happens next.
    if (!created) this._replay(unit, lease);
  }

  _detach(lease) {
    const unit = lease.unit;
    if (!unit) return;

    unit.leases.delete(lease);
    lease.unit = null;

    if (unit.leases.size === 0) {
      if (unit.client) unit.client.destroy();
      unit.client = null;
      if (this.units.get(keyOf(unit.address)) === unit) this.units.delete(keyOf(unit.address));
    } else {
      this._refreshPollSeconds(unit);
      this._refreshTopics(unit);
    }
  }

  _update(lease, config) {
    const unit = lease.unit;
    if (!unit || this._destroyed) return;

    if (keyOf(config.address) !== keyOf(unit.address)) {
      // The device now points at another unit: move it over.
      this._detach(lease);
      if (keyOf(config.address)) this._attach(lease, config);
      return;
    }

    lease.config = { ...config };

    const creds = credsOf(config);
    const credentialsChanged = creds.password !== unit.creds.password || creds.token !== unit.creds.token;
    if (credentialsChanged) {
      // Every device on this unit shares the new credentials from now on.
      unit.creds = creds;
      unit.cache.clear();
      unit.reachable = null;
      this._startClient(unit);
    }

    this._refreshPollSeconds(unit);
    this._refreshTopics(unit);
  }

  _createUnit(config) {
    const unit = {
      address: String(config.address).trim(),
      creds: credsOf(config),
      wsPath: config.preferredWsPath || null,
      pollSeconds: Math.max(5, Number(config.pollSeconds) || 5),
      topics: [],
      leases: new Set(),
      cache: new Map(), // topic -> { topic, value }
      reachable: null, // null = not known yet
      client: null,
    };
    this.units.set(keyOf(unit.address), unit);
    this._startClient(unit);
    return unit;
  }

  /** The unit polls as often as its most demanding device asks for. */
  _refreshPollSeconds(unit) {
    let seconds = Infinity;
    for (const lease of unit.leases) {
      seconds = Math.min(seconds, Math.max(5, Number(lease.config && lease.config.pollSeconds) || 5));
    }
    if (!Number.isFinite(seconds)) seconds = 5;
    unit.pollSeconds = seconds;
    if (unit.client) unit.client.setPollSeconds(seconds);
  }

  /** The unit streams every single topic that any of its devices asks for. */
  _refreshTopics(unit) {
    const topics = new Set();
    for (const lease of unit.leases) {
      for (const topic of (lease.config && lease.config.topics) || []) topics.add(topic);
    }
    unit.topics = [...topics];
    if (unit.client) unit.client.setTopics(unit.topics);
  }

  // --- The connection itself -----------------------------------------------

  _startClient(unit) {
    if (unit.client) unit.client.destroy();

    const client = new SolarAssistantClient({
      address: unit.address,
      password: unit.creds.password,
      token: unit.creds.token,
      preferredWsPath: unit.wsPath,
      topics: unit.topics,
      homey: this.homey,
      log: (...args) => this.log(...args),
    });
    unit.client = client;

    const current = () => unit.client === client && !this._destroyed;

    client.on('metrics', (metrics) => {
      if (!current() || !Array.isArray(metrics)) return;
      for (const metric of metrics) {
        if (metric && metric.topic) unit.cache.set(metric.topic, { topic: metric.topic, value: metric.value });
      }
      this._fanOut(unit, 'onMetrics', metrics);
    });

    client.on('alive', () => {
      if (!current()) return;
      unit.reachable = true;
      this._fanOut(unit, 'onAlive');
    });

    client.on('wspath', (path) => {
      if (!current()) return;
      unit.wsPath = path;
      this._fanOut(unit, 'onWsPath', path);
    });

    client.on('error', (err) => {
      if (!current()) return;
      this.error(`SolarAssistant error (${unit.address}):`, err && err.message ? err.message : err);
    });

    this._boot(unit, client);
  }

  async _boot(unit, client) {
    try {
      await client.testConnection();
    } catch (err) {
      if (unit.client !== client || this._destroyed) return;
      unit.reachable = false;
      this.error(`Could not connect to SolarAssistant (${unit.address}):`, err.message);
      this._fanOut(unit, 'onUnreachable', err);
    }

    if (unit.client !== client || this._destroyed) return;
    // Polling and the websocket keep retrying, even if the first attempt failed.
    await client.start(unit.pollSeconds);
  }

  // --- Delivering to devices -----------------------------------------------

  _fanOut(unit, name, ...args) {
    for (const lease of [...unit.leases]) this._call(lease, name, args);
  }

  _call(lease, name, args) {
    const fn = lease.handlers[name];
    if (typeof fn !== 'function') return;
    try {
      const result = fn(...args);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => this.error(`SolarAssistant handler ${name} failed:`, err.message));
      }
    } catch (err) {
      this.error(`SolarAssistant handler ${name} failed:`, err.message);
    }
  }

  /** Give a newly attached device what the unit already knows. Deferred so acquire() returns first. */
  _replay(unit, lease) {
    Promise.resolve().then(() => {
      if (lease.unit !== unit || this._destroyed) return;
      if (unit.cache.size > 0) this._call(lease, 'onMetrics', [[...unit.cache.values()]]);
      if (unit.reachable === true) this._call(lease, 'onAlive', []);
      else if (unit.reachable === false) this._call(lease, 'onUnreachable', [new Error('SolarAssistant unit is not reachable')]);
    });
  }

}

module.exports = ConnectionManager;

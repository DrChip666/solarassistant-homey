'use strict';

const EventEmitter = require('events');

/**
 * Simple client for SolarAssistant's local device API, built entirely on
 * Node's built-in fetch and WebSocket (no external npm dependencies, to keep
 * the app's memory footprint low on Homey).
 *
 * Timers are created through the Homey instance (this.homey.setTimeout /
 * setInterval) so they are tracked and cleaned up consistently with the rest
 * of the app's lifecycle.
 *
 * See: https://solar-assistant.io/help/integration/rest-api
 *      https://solar-assistant.io/help/integration/websocket-api
 *
 * Events:
 *  - 'metrics' (array of {topic, value, ...})
 *  - 'connected'    (websocket connected)
 *  - 'disconnected' (websocket closed)
 *  - 'error'        (Error)
 */
class SolarAssistantClient extends EventEmitter {

  constructor({ address, password, token, homey, log }) {
    super();
    this.address = address;
    this.password = password;
    this.token = token;
    this.homey = homey;
    this.log = log || (() => {});

    this.ws = null;
    this.wsShouldReconnect = false;
    this.wsReconnectTimer = null;
    this.pollTimer = null;
  }

  // --- Timer helpers: prefer Homey's managed timers, fall back to globals ---
  _setTimeout(fn, ms) {
    return this.homey ? this.homey.setTimeout(fn, ms) : setTimeout(fn, ms);
  }

  _clearTimeout(handle) {
    if (this.homey) this.homey.clearTimeout(handle);
    else clearTimeout(handle);
  }

  _setInterval(fn, ms) {
    return this.homey ? this.homey.setInterval(fn, ms) : setInterval(fn, ms);
  }

  _clearInterval(handle) {
    if (this.homey) this.homey.clearInterval(handle);
    else clearInterval(handle);
  }

  get baseUrl() {
    return `http://${this.address}`;
  }

  _authHeaders() {
    if (this.token) return { Authorization: `Bearer ${this.token}` };
    const basic = Buffer.from(`admin:${this.password || ''}`).toString('base64');
    return { Authorization: `Basic ${basic}` };
  }

  async _get(path, params) {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const res = await fetch(url, {
      headers: this._authHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`SolarAssistant responded with status ${res.status}`);
    }
    return res.json();
  }

  async _post(path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`SolarAssistant responded with status ${res.status}`);
    }
    return res.json().catch(() => null);
  }

  /** Test the connection. Throws an error if it fails. */
  async testConnection() {
    const data = await this._get('/api/v1/metrics');
    if (!Array.isArray(data)) {
      throw new Error('Unexpected response from the SolarAssistant device');
    }
    return true;
  }

  /** Fetch a snapshot of all (or filtered) metrics. */
  async fetchMetrics(topic) {
    return this._get('/api/v1/metrics', topic ? { topic } : undefined);
  }

  /** Write a setting to the inverter. */
  async writeMetric(topic, value) {
    return this._post('/api/v1/metrics', { topic, value });
  }

  /** Start periodic polling via REST (fallback for the websocket). */
  startPolling(intervalSeconds = 5) {
    this.stopPolling();
    const seconds = Math.max(5, Number(intervalSeconds) || 5);

    const poll = async () => {
      try {
        const metrics = await this.fetchMetrics();
        this.emit('metrics', metrics);
      } catch (err) {
        this.emit('error', err);
      }
    };

    poll();
    this.pollTimer = this._setInterval(poll, seconds * 1000);
  }

  stopPolling() {
    if (this.pollTimer) {
      this._clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Connect via websocket for live updates. Fails silently; listen for 'error'/'disconnected'. */
  connectWebSocket() {
    this.wsShouldReconnect = true;
    this._openWebSocket();
  }

  _openWebSocket() {
    try {
      const query = this.token
        ? `token=${encodeURIComponent(this.token)}`
        : `password=${encodeURIComponent(this.password || '')}`;
      const url = `ws://${this.address}/api/socket/websocket?${query}`;

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.log('SolarAssistant websocket connected');
        try {
          this.ws.send(JSON.stringify({ topic: 'metrics', event: 'join', payload: {}, ref: '1' }));
        } catch (err) {
          this.emit('error', err);
        }
        this.emit('connected');
      };

      this.ws.onmessage = (messageEvent) => {
        try {
          const msg = JSON.parse(messageEvent.data.toString());
          const { event, payload } = msg;

          if (event === 'data' && payload && Array.isArray(payload.metrics)) {
            this.emit('metrics', payload.metrics);
          } else if (event === 'set_result' && payload && payload.result === 'error') {
            this.emit('error', new Error(`SolarAssistant rejected the command: ${payload.message || payload.topic}`));
          }
          // 'definition' events are intentionally ignored - we already know the topics we use.
        } catch (err) {
          this.emit('error', err);
        }
      };

      this.ws.onclose = () => {
        this.emit('disconnected');
        this._scheduleReconnect();
      };

      this.ws.onerror = (errorEvent) => {
        this.emit('error', errorEvent.error || new Error('SolarAssistant websocket error'));
      };
    } catch (err) {
      this.emit('error', err);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (!this.wsShouldReconnect) return;
    if (this.wsReconnectTimer) return;
    this.wsReconnectTimer = this._setTimeout(() => {
      this.wsReconnectTimer = null;
      if (this.wsShouldReconnect) this._openWebSocket();
    }, 30000);
  }

  disconnectWebSocket() {
    this.wsShouldReconnect = false;
    if (this.wsReconnectTimer) {
      this._clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try { this.ws.close(); } catch (err) { /* ignore */ }
      this.ws = null;
    }
  }

  /** Fully clean up (called on onDeleted / reconnect). */
  destroy() {
    this.stopPolling();
    this.disconnectWebSocket();
    this.removeAllListeners();
  }

}

module.exports = SolarAssistantClient;

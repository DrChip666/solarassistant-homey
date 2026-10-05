'use strict';

const EventEmitter = require('events');

/**
 * Client for SolarAssistant's local device API, built entirely on Node's
 * built-in fetch and WebSocket (no external npm dependencies, to keep the
 * app's memory footprint low on Homey).
 *
 * Data flow
 *  1. A full REST snapshot is fetched on start, because websocket messages only
 *     carry the values that changed.
 *  2. Fast REST polling runs until the websocket delivers its first data message.
 *  3. While the websocket is delivering, REST polling stops and only a slow
 *     "safety net" snapshot is taken (SAFETY_POLL_MS).
 *  4. If the websocket falls silent or closes, fast polling resumes and the
 *     websocket is re-established with a growing pause between attempts.
 *
 * A REST snapshot never overwrites a value the live stream has updated after the
 * REST request was sent, so a slow response cannot bring back an older number.
 *
 * Timers are created through the Homey instance (homey.setTimeout / setInterval)
 * so they are tracked and cleaned up consistently with the rest of the app.
 *
 * See: https://solar-assistant.io/help/integration/rest-api
 *      https://solar-assistant.io/help/integration/websocket-api
 *
 * Events:
 *  - 'metrics' (array of {topic, value, ...})  new values (live or REST)
 *  - 'alive'                                    a message or REST response was received
 *  - 'wspath' (string)                          the websocket path that delivered data
 *  - 'error'  (Error)
 */

// The documentation describes /api/socket/websocket, but newer firmware serves the
// local websocket on /api/websocket. Both are tried; the one that works is remembered.
const WS_PATHS = ['/api/websocket', '/api/socket/websocket'];

// Ask only for what the app uses instead of everything the unit knows (hundreds of topics).
const WS_TOPIC_FILTER = [{ topic: 'total/*' }];

const WS_CONNECT_TIMEOUT_MS = 10 * 1000; // built-in WebSocket exposes no HTTP status, so time out
const WS_SILENCE_TIMEOUT_MS = 30 * 1000; // no data for this long = treat the connection as dead
const WS_HEARTBEAT_MS = 30 * 1000;       // Phoenix servers close sockets that stay quiet for ~60 s
const WS_BACKOFF_MIN_MS = 10 * 1000;
const WS_BACKOFF_MAX_MS = 60 * 1000;
const SAFETY_POLL_MS = 60 * 1000;
const WS_OPEN = 1;

class SolarAssistantClient extends EventEmitter {

  constructor({ address, password, token, preferredWsPath, homey, log }) {
    super();
    this.address = address;
    this.password = password;
    this.token = token;
    this.homey = homey;
    this.log = log || (() => {});

    // Put the path that worked last time first.
    this.wsPaths = WS_PATHS.includes(preferredWsPath)
      ? [preferredWsPath, ...WS_PATHS.filter((p) => p !== preferredWsPath)]
      : WS_PATHS.slice();
    this.activeWsPath = WS_PATHS.includes(preferredWsPath) ? preferredWsPath : null;
    this.wsPathIndex = 0;
    this.wsBackoffMs = WS_BACKOFF_MIN_MS;
    this.wsGotData = false;
    this.live = false;

    this.ws = null;
    this.wsConnectTimer = null;
    this.wsSilenceTimer = null;
    this.wsHeartbeatTimer = null;
    this.wsReconnectTimer = null;
    this.pollTimer = null;
    this.safetyTimer = null;

    this.pollSeconds = 5;
    this.lastLiveAt = {}; // topic -> time of the last live (websocket) update
    this.running = false;
    this._polling = false;
    this._destroyed = false;
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

  /** Emit unless the client has been destroyed (an 'error' event without listeners would throw). */
  _emit(event, ...args) {
    if (this._destroyed) return;
    this.emit(event, ...args);
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

  // --- Lifecycle -----------------------------------------------------------

  /**
   * Fetch a first full snapshot, then start fast polling and the websocket.
   * @param {number} pollSeconds How often to poll while live updates are unavailable (min 5).
   */
  async start(pollSeconds) {
    if (this._destroyed) return;
    this.pollSeconds = Math.max(5, Number(pollSeconds) || 5);
    this.running = true;

    await this.pollOnce();
    if (!this.running) return;

    this._startFastPolling();
    this._connectWebSocket();
  }

  /** Fully clean up (called on onDeleted / reconnect). */
  destroy() {
    this._destroyed = true;
    this.running = false;
    this._stopFastPolling();
    this._stopSafetyPolling();
    this._teardownSocket();
    if (this.wsReconnectTimer) {
      this._clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    this.removeAllListeners();
  }

  // --- REST polling --------------------------------------------------------

  /**
   * One REST snapshot. Values the live stream updated after the request was sent
   * are skipped, so a slow response can never bring back an older number.
   */
  async pollOnce() {
    if (this._polling || this._destroyed) return;
    this._polling = true;
    const sentAt = Date.now();

    try {
      const metrics = await this.fetchMetrics();
      if (!Array.isArray(metrics)) {
        throw new Error('Unexpected response from the SolarAssistant device');
      }
      const fresh = metrics.filter((m) => !(this.lastLiveAt[m.topic] > sentAt));
      this._emit('metrics', fresh);
      this._emit('alive');
    } catch (err) {
      this._emit('error', err);
    } finally {
      this._polling = false;
    }
  }

  _startFastPolling() {
    if (this.pollTimer || this._destroyed) return;
    this.pollTimer = this._setInterval(() => this.pollOnce(), this.pollSeconds * 1000);
  }

  _stopFastPolling() {
    if (!this.pollTimer) return;
    this._clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  _startSafetyPolling() {
    if (this.safetyTimer || this._destroyed) return;
    this.safetyTimer = this._setInterval(() => this.pollOnce(), SAFETY_POLL_MS);
  }

  _stopSafetyPolling() {
    if (!this.safetyTimer) return;
    this._clearInterval(this.safetyTimer);
    this.safetyTimer = null;
  }

  /** The websocket is delivering: drop to the slow safety-net snapshot. */
  _enterLive() {
    if (this.live) return;
    this.live = true;
    this._stopFastPolling();
    this._startSafetyPolling();
  }

  /** The websocket stopped delivering: go back to fast polling. */
  _leaveLive() {
    if (!this.live) return;
    this.live = false;
    this._stopSafetyPolling();
    if (this.running) this._startFastPolling();
  }

  // --- Websocket -----------------------------------------------------------

  _connectWebSocket() {
    if (!this.running || this._destroyed || this.ws) return;

    const path = this.wsPaths[this.wsPathIndex % this.wsPaths.length];
    const query = this.token
      ? `token=${encodeURIComponent(this.token)}`
      : `password=${encodeURIComponent(this.password || '')}`;

    let ws;
    try {
      ws = new WebSocket(`ws://${this.address}${path}?${query}`);
    } catch (err) {
      this.log('SolarAssistant websocket could not be created:', err.message);
      this._wsFailed();
      return;
    }

    this.ws = ws;
    this.wsGotData = false;

    this.wsConnectTimer = this._setTimeout(() => {
      this.wsConnectTimer = null;
      if (this.ws !== ws) return;
      this.log(`SolarAssistant websocket did not open on ${path}`);
      this._wsFailed();
    }, WS_CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (this.wsConnectTimer) {
        this._clearTimeout(this.wsConnectTimer);
        this.wsConnectTimer = null;
      }
      this.log(`SolarAssistant websocket open on ${path}`);
      try {
        ws.send(JSON.stringify({
          topic: 'metrics',
          event: 'join',
          payload: { topics: WS_TOPIC_FILTER },
          ref: '1',
        }));
      } catch (err) {
        this.log('SolarAssistant websocket join failed:', err.message);
        this._wsFailed();
        return;
      }
      this._armSilenceTimer();
      this._startHeartbeat();
    };

    ws.onmessage = (messageEvent) => {
      if (this.ws !== ws) return;

      let msg;
      try {
        const raw = typeof messageEvent.data === 'string' ? messageEvent.data : String(messageEvent.data);
        msg = JSON.parse(raw);
      } catch (err) {
        return; // not JSON - ignore
      }
      if (!msg || typeof msg !== 'object') return;

      const { event, payload } = msg;

      if (event === 'data' && payload && Array.isArray(payload.metrics)) {
        this._armSilenceTimer();

        const now = Date.now();
        for (const metric of payload.metrics) {
          if (metric && metric.topic) this.lastLiveAt[metric.topic] = now;
        }

        if (!this.wsGotData) {
          this.wsGotData = true;
          this.wsBackoffMs = WS_BACKOFF_MIN_MS;
          this.log(`SolarAssistant live updates active (${path})`);
          this._enterLive();
          if (this.activeWsPath !== path) {
            this.activeWsPath = path;
            this._emit('wspath', path);
          }
        }

        this._emit('metrics', payload.metrics);
        this._emit('alive');
      } else if (event === 'definition') {
        this._armSilenceTimer(); // the server is answering the join
      } else if (event === 'set_result' && payload && payload.result === 'error') {
        this._emit('error', new Error(`SolarAssistant rejected the command: ${payload.message || payload.topic}`));
      } else if (event === 'phx_reply' && msg.topic === 'metrics' && payload && payload.status === 'error') {
        this.log('SolarAssistant websocket join was rejected');
        this._wsFailed();
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.log('SolarAssistant websocket closed');
      this._wsFailed();
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.log(`SolarAssistant websocket error on ${path}`);
      this._wsFailed();
    };
  }

  /** The connection failed or went quiet: tear it down, resume polling, and try again. */
  _wsFailed() {
    const hadData = this.wsGotData;
    this._teardownSocket();
    this._leaveLive();
    if (!this.running || this._destroyed) return;

    let delay;
    if (hadData) {
      // A connection that worked was lost: retry the same path after a short pause.
      delay = this.wsBackoffMs;
    } else {
      // Try the next path straight away. When every path has failed, wait (with a
      // growing pause) before the next round.
      this.wsPathIndex += 1;
      if (this.wsPathIndex % this.wsPaths.length === 0) {
        delay = this.wsBackoffMs;
        this.wsBackoffMs = Math.min(this.wsBackoffMs * 2, WS_BACKOFF_MAX_MS);
      } else {
        delay = 0;
      }
    }

    this.wsReconnectTimer = this._setTimeout(() => {
      this.wsReconnectTimer = null;
      this._connectWebSocket();
    }, delay);
  }

  _armSilenceTimer() {
    if (this.wsSilenceTimer) this._clearTimeout(this.wsSilenceTimer);
    this.wsSilenceTimer = this._setTimeout(() => {
      this.wsSilenceTimer = null;
      this.log('SolarAssistant websocket has been silent, reconnecting');
      this._wsFailed();
    }, WS_SILENCE_TIMEOUT_MS);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.wsHeartbeatTimer = this._setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === WS_OPEN) {
          this.ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 'hb' }));
        }
      } catch (err) {
        // A broken socket is picked up by the close/silence handling.
      }
    }, WS_HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (!this.wsHeartbeatTimer) return;
    this._clearInterval(this.wsHeartbeatTimer);
    this.wsHeartbeatTimer = null;
  }

  _teardownSocket() {
    if (this.wsConnectTimer) {
      this._clearTimeout(this.wsConnectTimer);
      this.wsConnectTimer = null;
    }
    if (this.wsSilenceTimer) {
      this._clearTimeout(this.wsSilenceTimer);
      this.wsSilenceTimer = null;
    }
    this._stopHeartbeat();

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(); } catch (err) { /* ignore */ }
    }
  }

}

module.exports = SolarAssistantClient;

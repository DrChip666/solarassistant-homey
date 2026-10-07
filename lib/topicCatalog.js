'use strict';

/**
 * Turns what a SolarAssistant unit can deliver into Homey devices, one per topic.
 *
 * Every metric from /api/v1/metrics looks like:
 *   { name, unit, value, device, group, topic, number }
 * e.g. { name: 'Cell voltage - Highest', unit: 'V', value: 3.212, device: 'batteries',
 *        group: 'Status', topic: 'battery_1/cell_voltage_-_highest', number: 0 }
 *
 * Only the groups Status (live values) and Info (fixed details) are offered. Settings are
 * the inverter's configuration and are left out - the app does not write to the inverter
 * from these devices.
 */

const GROUPS = new Set(['Status', 'Info']);

// Capabilities Homey already knows, so icons and Flow cards look right.
// Power (W) and energy (kWh) are deliberately NOT mapped to measure_power / meter_power:
// Homey Energy reads those, and a single "PV power" value would then be counted as a
// consumer next to the Solar, Battery and Grid devices.
//
// The general number capability is called measure_sa_value on purpose: Homey only lets a
// device tile show the value of capabilities whose id starts with measure_ or meter_.
const STANDARD_CAPABILITY = {
  '°C': 'measure_temperature',
  '℃': 'measure_temperature',
  V: 'measure_voltage',
  A: 'measure_current',
};

// Decimals to show, by unit. Anything else: none for whole numbers, two for the rest.
const DECIMALS = { W: 0, VA: 0, Wh: 0, kWh: 2, '%': 1, Hz: 2, Ah: 1, 'øre/kWh': 1, 'W/m²': 0, 'km/h': 1, h: 1 };

// Units that describe text (a clock time), not a number.
const TEXT_UNITS = new Set(['hhmm']);

const CATEGORY_ORDER = ['totals', 'inverters', 'batteries', 'grid', 'weather'];

/** Is this metric one we offer? */
function isOffered(metric) {
  return Boolean(metric)
    && typeof metric.topic === 'string' && metric.topic.length > 0
    && typeof metric.name === 'string' && metric.name.length > 0
    && GROUPS.has(metric.group);
}

/** Which capability shows this metric, and how. */
function describe(metric, title) {
  const unit = metric.unit ? String(metric.unit) : '';
  const { value } = metric;

  if (typeof value === 'boolean' || (value === null && unit === 'Enabled')) {
    return { capability: 'sa_flag', kind: 'boolean', options: { title } };
  }

  const isNumber = typeof value === 'number' || (value === null && unit !== '' && !TEXT_UNITS.has(unit));
  if (!isNumber) {
    return { capability: 'sa_text', kind: 'string', options: { title } };
  }

  const standard = STANDARD_CAPABILITY[unit];
  if (standard) {
    const options = { title };
    // Homey shows two decimals for voltage and current. Small values (cell voltages,
    // imbalance, phase currents) need more, large ones fewer.
    if (typeof value === 'number' && (unit === 'V' || unit === 'A')) {
      const small = Math.abs(value) < 10;
      options.decimals = unit === 'V' ? (small ? 3 : 1) : (small ? 2 : 1);
    }
    return { capability: standard, kind: 'number', options };
  }

  const options = { title };
  if (unit) options.units = { en: unit };
  if (Object.prototype.hasOwnProperty.call(DECIMALS, unit)) options.decimals = DECIMALS[unit];
  else options.decimals = Number.isInteger(value) ? 0 : 2;
  return { capability: 'measure_sa_value', kind: 'number', options };
}

/** "Battery 1", "Inverter 1", "Total", ... */
function categoryLabel(metric, t) {
  const n = Number.isInteger(metric.number) ? metric.number + 1 : null;
  switch (metric.device) {
    case 'totals': return t('topic.total');
    case 'inverters': return n === null ? t('topic.inverter') : `${t('topic.inverter')} ${n}`;
    case 'batteries': return n === null ? t('topic.battery') : `${t('topic.battery')} ${n}`;
    case 'grid': return t('topic.grid');
    case 'weather': return t('topic.weather');
    default: {
      const name = String(metric.device || 'Other');
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      return n === null ? label : `${label} ${n}`;
    }
  }
}

function sortKey(metric) {
  const category = CATEGORY_ORDER.indexOf(metric.device);
  return [
    category === -1 ? CATEGORY_ORDER.length : category,
    Number.isInteger(metric.number) ? metric.number : 0,
    metric.group === 'Status' ? 0 : 1,
  ];
}

function compare(a, b) {
  const ka = sortKey(a); const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return a.name.localeCompare(b.name, 'en', { numeric: true });
}

/**
 * One device per offered metric, in the shape Homey's pairing list wants.
 *
 * @param {object[]} metrics The unit's /api/v1/metrics answer.
 * @param {{address: string, password: string, id: string}} unit
 * @param {{prefix?: string, t: function}} options
 *   prefix  added to every name, to tell units apart when there are several
 *   t       translation function (key -> text)
 */
function buildTopicDevices(metrics, unit, { prefix = '', t = (key) => key } = {}) {
  const seen = new Set();

  return (Array.isArray(metrics) ? metrics : [])
    .filter(isOffered)
    .filter((metric) => (seen.has(metric.topic) ? false : seen.add(metric.topic)))
    .sort(compare)
    .map((metric) => {
      const described = describe(metric, { en: metric.name });
      return {
        name: `${prefix}${categoryLabel(metric, t)} · ${metric.name}`,
        data: { id: `${unit.id}|${metric.topic}`, unitId: unit.id, topic: metric.topic },
        settings: { address: unit.address, poll_interval: 5 },
        store: { password: unit.password, kind: described.kind },
        class: 'sensor',
        capabilities: [described.capability],
        capabilitiesOptions: { [described.capability]: described.options },
      };
    });
}

module.exports = { buildTopicDevices, describe, isOffered, categoryLabel };

'use strict';

const Homey = require('homey');
const SolarAssistantClient = require('../../lib/solarAssistantClient');

class SolarAssistantDriver extends Homey.Driver {

  async onInit() {
    this.gridDirectionTrigger = this.homey.flow.getDeviceTriggerCard('grid_direction_changed');

    this.homey.flow.getConditionCard('battery_soc_above')
      .registerRunListener(async (args) => {
        const soc = args.device.getCapabilityValue('measure_battery');
        return typeof soc === 'number' && soc > args.percentage;
      });

    this.homey.flow.getActionCard('send_command')
      .registerRunListener(async (args) => {
        await args.device.sendCommand(args.topic, args.value);
      });

    this.homey.flow.getActionCard('set_output_source_priority')
      .registerRunListener(async (args) => {
        await args.device.sendCommand('inverter_1/output_source_priority', args.priority);
      });
  }

  /** Called by device.js when the grid direction switches between import and export. */
  triggerGridDirectionChanged(device, tokens) {
    this.gridDirectionTrigger.trigger(device, tokens)
      .catch((err) => this.error('Failed to trigger grid_direction_changed:', err.message));
  }

  async onPair(session) {
    let address = '';
    let password = '';

    session.setHandler('login', async (data) => {
      address = String(data.username || '').trim();
      password = data.password || '';

      if (!address) {
        throw new Error(this.homey.__('pair.missing_address'));
      }

      const client = new SolarAssistantClient({
        address,
        password,
        homey: this.homey,
        log: this.log.bind(this),
      });

      try {
        await client.testConnection();
        return true;
      } catch (err) {
        this.error('Login during pairing failed:', err.message);
        throw new Error(this.homey.__('pair.connection_failed'));
      } finally {
        client.destroy();
      }
    });

    session.setHandler('list_devices', async () => {
      return [
        {
          name: `SolarAssistant (${address})`,
          data: {
            id: address.replace(/[^a-zA-Z0-9]/g, '_') || `site_${Date.now()}`,
          },
          settings: {
            address,
            password,
            poll_interval: 5,
          },
        },
      ];
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async (data) => {
      const address = String(data.username || '').trim();
      const password = data.password || '';

      if (!address) {
        throw new Error(this.homey.__('pair.missing_address'));
      }

      const client = new SolarAssistantClient({
        address,
        password,
        homey: this.homey,
        log: this.log.bind(this),
      });

      try {
        await client.testConnection();
      } catch (err) {
        this.error('Login during repair failed:', err.message);
        throw new Error(this.homey.__('pair.connection_failed'));
      } finally {
        client.destroy();
      }

      await device.setSettings({ address, password });
      return true;
    });
  }

}

module.exports = SolarAssistantDriver;

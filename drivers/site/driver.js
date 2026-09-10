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
  }

  /** Called by device.js when the grid direction switches between import and export. */
  triggerGridDirectionChanged(device, tokens) {
    this.gridDirectionTrigger.trigger(device, tokens)
      .catch((err) => this.error('Failed to trigger grid_direction_changed:', err.message));
  }

  async onPair(session) {
    // Devices confirmed to be a real SolarAssistant unit during this pairing session.
    let foundDevices = [];

    session.setHandler('login', async (data) => {
      const manualAddress = String(data.username || '').trim();
      const password = data.password || '';
      foundDevices = [];

      if (manualAddress) {
        // Manual override: the user filled in an IP address themselves.
        const client = new SolarAssistantClient({
          address: manualAddress,
          password,
          homey: this.homey,
          log: this.log.bind(this),
        });

        try {
          await client.testConnection();
        } catch (err) {
          this.error('Manual login failed:', err.message);
          throw new Error(this.homey.__('pair.connection_failed'));
        } finally {
          client.destroy();
        }

        foundDevices.push({
          name: `SolarAssistant (${manualAddress})`,
          data: {
            id: manualAddress.replace(/[^a-zA-Z0-9]/g, '_') || `site_${Date.now()}`,
          },
          settings: {
            address: manualAddress,
            poll_interval: 5,
          },
          store: {
            password,
          },
        });

        return true;
      }

      // Auto-detect: test every discovered Raspberry Pi on the network with the given password.
      const discoveryStrategy = this.getDiscoveryStrategy();
      const discoveryResults = Object.values(discoveryStrategy.getDiscoveryResults());

      for (const result of discoveryResults) {
        const client = new SolarAssistantClient({
          address: result.address,
          password,
          homey: this.homey,
          log: this.log.bind(this),
        });

        try {
          await client.testConnection();
          foundDevices.push({
            name: `SolarAssistant (${result.address})`,
            data: {
              id: result.id,
            },
            settings: {
              address: result.address,
              poll_interval: 5,
            },
            store: {
              password,
            },
          });
        } catch (err) {
          // Not a SolarAssistant device, or the password did not match - skip it silently.
        } finally {
          client.destroy();
        }
      }

      if (foundDevices.length === 0) {
        throw new Error(this.homey.__('pair.no_devices_found'));
      }

      return true;
    });

    session.setHandler('list_devices', async () => foundDevices);
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

      await device.setStoreValue('password', password);
      await device.setSettings({ address });
      return true;
    });
  }

}

module.exports = SolarAssistantDriver;

const { execSync, exec } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');

const DATA_DIR = process.env.DATA_DIR || '/data';
const CONFIG_PATH = path.join(DATA_DIR, 'wg0.conf');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const WG_CONF = '/etc/wireguard/wg0.conf';

const LAN_SUBNETS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
const IPTABLES_COMMENT = 'umbrella-vpn';

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch (err) {
    const stderr = err.stderr?.toString().trim() || '';
    const stdout = err.stdout?.toString().trim() || '';
    throw new Error(stderr || stdout || err.message);
  }
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return { autoConnect: false, killSwitch: false };
  }
}

function saveSettings(settings) {
  const current = loadSettings();
  const merged = { ...current, ...settings };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function hasConfig() {
  return fs.existsSync(CONFIG_PATH);
}

function saveConfig(configText) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, configText);
}

function getConfig() {
  if (!hasConfig()) return null;
  return fs.readFileSync(CONFIG_PATH, 'utf8');
}

function isConnected() {
  try {
    run('wg show wg0');
    return true;
  } catch {
    return false;
  }
}

function patchConfigForLan(configText) {
  // ProtonVPN configs use AllowedIPs = 0.0.0.0/0 which captures everything.
  // We don't modify AllowedIPs here — instead we add explicit routes for LAN
  // subnets *after* wg-quick sets up the interface, so LAN traffic bypasses
  // the tunnel via higher-priority routes.
  return configText;
}

function installLanRoutes() {
  // Detect the default gateway *before* wg-quick may have changed it.
  // wg-quick with AllowedIPs = 0.0.0.0/0 replaces the default route,
  // but the original gateway is still reachable via the main table.
  // We look for the original default route or fall back to a common pattern.
  let gateway, device;
  try {
    // After wg-quick, the original default route is moved to table 51820
    const mainRoute = run(
      'ip route show default table main 2>/dev/null || ip route show default',
    );
    const match = mainRoute.match(/default via (\S+) dev (\S+)/);
    if (match) {
      gateway = match[1];
      device = match[2];
    }
  } catch {
    // ignore
  }

  if (!gateway) {
    // Fallback: scan all tables for the original default route
    try {
      const allRoutes = run(
        "ip route show table all | grep 'default via' | grep -v wg0 | head -1",
      );
      const match = allRoutes.match(/default via (\S+) dev (\S+)/);
      if (match) {
        gateway = match[1];
        device = match[2];
      }
    } catch {
      // ignore
    }
  }

  if (!gateway) return;

  for (const subnet of LAN_SUBNETS) {
    try {
      run(
        `ip route add ${subnet} via ${gateway} dev ${device} 2>/dev/null || true`,
      );
    } catch {
      // route may already exist
    }
  }
}

function enableKillSwitch() {
  try {
    // Drop all forwarded/output traffic that isn't going through wg0 or to LAN
    const rules = [
      `iptables -C OUTPUT -o wg0 -j ACCEPT -m comment --comment "${IPTABLES_COMMENT}" 2>/dev/null || iptables -I OUTPUT 1 -o wg0 -j ACCEPT -m comment --comment "${IPTABLES_COMMENT}"`,
      `iptables -C OUTPUT -o lo -j ACCEPT -m comment --comment "${IPTABLES_COMMENT}" 2>/dev/null || iptables -I OUTPUT 1 -o lo -j ACCEPT -m comment --comment "${IPTABLES_COMMENT}"`,
    ];

    for (const subnet of LAN_SUBNETS) {
      rules.push(
        `iptables -C OUTPUT -d ${subnet} -j ACCEPT -m comment --comment "${IPTABLES_COMMENT}" 2>/dev/null || iptables -I OUTPUT 1 -d ${subnet} -j ACCEPT -m comment --comment "${IPTABLES_COMMENT}"`,
      );
    }

    // Allow established connections (so current SSH/web sessions survive)
    rules.push(
      `iptables -C OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT -m comment --comment "${IPTABLES_COMMENT}" 2>/dev/null || iptables -I OUTPUT 1 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT -m comment --comment "${IPTABLES_COMMENT}"`,
    );

    // Allow traffic to the WireGuard endpoint (the VPN server itself)
    const config = getConfig();
    if (config) {
      const endpointMatch = config.match(/Endpoint\s*=\s*(\S+?):\d+/);
      if (endpointMatch) {
        rules.push(
          `iptables -C OUTPUT -d ${endpointMatch[1]} -j ACCEPT -m comment --comment "${IPTABLES_COMMENT}" 2>/dev/null || iptables -I OUTPUT 1 -d ${endpointMatch[1]} -j ACCEPT -m comment --comment "${IPTABLES_COMMENT}"`,
        );
      }
    }

    // Final drop rule for everything else (appended, lowest priority)
    rules.push(
      `iptables -C OUTPUT -j DROP -m comment --comment "${IPTABLES_COMMENT}-drop" 2>/dev/null || iptables -A OUTPUT -j DROP -m comment --comment "${IPTABLES_COMMENT}-drop"`,
    );

    for (const rule of rules) {
      run(rule);
    }
  } catch (err) {
    console.error('Failed to enable kill switch:', err.message);
  }
}

function disableKillSwitch() {
  try {
    // Remove all our iptables rules
    let cleaned = true;
    while (cleaned) {
      cleaned = false;
      try {
        const rules = run('iptables -S OUTPUT');
        for (const line of rules.split('\n')) {
          if (line.includes(IPTABLES_COMMENT)) {
            const deleteRule = line.replace('-A OUTPUT', '-D OUTPUT');
            run(`iptables ${deleteRule}`);
            cleaned = true;
            break; // restart scan since indices shift
          }
        }
      } catch {
        break;
      }
    }
  } catch (err) {
    console.error('Failed to disable kill switch:', err.message);
  }
}

async function connect() {
  if (isConnected()) {
    return { success: true, message: 'Already connected' };
  }

  if (!hasConfig()) {
    return { success: false, message: 'No WireGuard configuration found' };
  }

  const configText = fs.readFileSync(CONFIG_PATH, 'utf8');
  const patched = patchConfigForLan(configText);
  fs.mkdirSync('/etc/wireguard', { recursive: true });
  fs.writeFileSync(WG_CONF, patched);

  try {
    run('wg-quick up wg0');
  } catch (err) {
    return { success: false, message: `wg-quick failed: ${err.message}` };
  }

  installLanRoutes();

  const settings = loadSettings();
  if (settings.killSwitch) {
    enableKillSwitch();
  }

  return { success: true, message: 'Connected' };
}

async function disconnect() {
  disableKillSwitch();

  if (!isConnected()) {
    return { success: true, message: 'Already disconnected' };
  }

  try {
    run('wg-quick down wg0');
  } catch (err) {
    return { success: false, message: `wg-quick down failed: ${err.message}` };
  }

  return { success: true, message: 'Disconnected' };
}

function getPublicIp() {
  return new Promise((resolve) => {
    const req = https.get(
      'https://api.ipify.org?format=json',
      { timeout: 5000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).ip);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function getInterfaceStats() {
  try {
    const dump = run('wg show wg0 dump');
    const lines = dump.split('\n');
    if (lines.length < 2) return null;

    const iface = lines[0].split('\t');
    const peer = lines[1].split('\t');

    return {
      publicKey: iface[1],
      listenPort: iface[2],
      peerPublicKey: peer[0],
      endpoint: peer[2],
      allowedIps: peer[3],
      latestHandshake: peer[4] ? Number.parseInt(peer[4], 10) : 0,
      transferRx: peer[5] ? Number.parseInt(peer[5], 10) : 0,
      transferTx: peer[6] ? Number.parseInt(peer[6], 10) : 0,
    };
  } catch {
    return null;
  }
}

async function getStatus() {
  const connected = isConnected();
  const settings = loadSettings();
  const stats = connected ? getInterfaceStats() : null;
  const publicIp = connected ? await getPublicIp() : null;

  return {
    connected,
    hasConfig: hasConfig(),
    publicIp,
    stats,
    settings,
  };
}

module.exports = {
  connect,
  disconnect,
  getStatus,
  saveConfig,
  getConfig,
  hasConfig,
  loadSettings,
  saveSettings,
  enableKillSwitch,
  disableKillSwitch,
  isConnected,
};

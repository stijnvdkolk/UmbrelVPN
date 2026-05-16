const express = require('express');
const path = require('node:path');
const vpn = require('./vpn');

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3080', 10);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

function sendError(res, err) {
  const status = err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
}

app.get('/api/status', async (_req, res) => {
  try {
    res.json(await vpn.getStatus());
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/config', (req, res) => {
  const { config } = req.body;
  if (!config || typeof config !== 'string') {
    return res.status(400).json({ error: 'Missing config field' });
  }

  if (!config.includes('[Interface]') || !config.includes('[Peer]')) {
    return res.status(400).json({
      error:
        'Invalid WireGuard configuration — must contain [Interface] and [Peer] sections',
    });
  }

  try {
    vpn.saveConfig(config);
    res.json({ message: 'Configuration saved' });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/connect', async (_req, res) => {
  try {
    res.json(await vpn.connect());
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/disconnect', async (_req, res) => {
  try {
    res.json(await vpn.disconnect());
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/settings', (_req, res) => {
  try {
    res.json(vpn.loadSettings());
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const updated = vpn.saveSettings(req.body);

    if (req.body.killSwitch === true && vpn.isConnected()) {
      vpn.enableKillSwitch();
    } else if (req.body.killSwitch === false) {
      vpn.disableKillSwitch();
    }

    res.json(updated);
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/*splat', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Umbrella VPN listening on port ${PORT}`);

  const settings = vpn.loadSettings();
  if (settings.autoConnect && vpn.hasConfig() && !vpn.isConnected()) {
    console.log('Auto-connect enabled — bringing up WireGuard...');
    try {
      const result = await vpn.connect();
      console.log('Auto-connect:', result.message);
    } catch (err) {
      console.error('Auto-connect failed:', err.message);
    }
  }
});

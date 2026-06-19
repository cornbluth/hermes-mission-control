const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 3005;
const DASHBOARD_DIR = '/home/jlucivero/hermes-dashboard';
const HERMES_HOME = '/home/jlucivero/.hermes';
const PROFILE = 'forge-hermes';

// ── API: Get PM2 process status ──
function getPm2Status() {
  try {
    const raw = execSync('pm2 jlist 2>/dev/null', { timeout: 5000 }).toString();
    const processes = JSON.parse(raw);
    return processes
      .filter(p => p.pm2_env?.status === 'online')
      .map(p => ({
        name: p.name,
        pid: p.pid,
        status: p.pm2_env.status,
        cpu: p.monit?.cpu || 0,
        memory: p.monit?.memory || 0,
        uptime: p.pm2_env.pm_uptime || 0,
        restarts: p.pm2_env.restart_time || 0,
      }));
  } catch {
    return [];
  }
}

// ── API: Get recent agent log entries ──
function getAgentLogs(lines = 20) {
  try {
    const logPath = path.join(HERMES_HOME, 'profiles', PROFILE, 'logs', 'agent.log');
    const raw = execSync(`tail -100 "${logPath}" 2>/dev/null`, { timeout: 5000 }).toString();
    const entries = [];
    for (const line of raw.split('\n')) {
      // Parse key events
      const toolMatch = line.match(/tool (\w+) completed/);
      const apiMatch = line.match(/API call #(\d+)/);
      const errorMatch = line.match(/ERROR|error|failed/i);
      const gatewayMatch = line.match(/gateway\.platforms\.telegram/);
      const approvalMatch = line.match(/Telegram button resolved/);
      const tsMatch = line.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
      
      if (toolMatch || apiMatch || gatewayMatch || approvalMatch) {
        const time = tsMatch ? tsMatch[2] : '';
        let text = '';
        let type = 'info';
        
        if (toolMatch) {
          text = `tool ${toolMatch[1]} executed`;
          type = 'tool';
        } else if (approvalMatch) {
          text = 'Telegram approval received from Jack';
          type = 'approval';
        } else if (gatewayMatch) {
          text = 'gateway event';
          type = 'gateway';
        } else if (apiMatch) {
          text = `API call #${apiMatch[1]}`;
          type = 'api';
        }
        
        if (text) entries.push({ time, text, type });
      }
    }
    return entries.slice(-lines);
  } catch {
    return [];
  }
}

// ── API: Get gateway state ──
function getGatewayState() {
  try {
    const statePath = path.join(HERMES_HOME, 'profiles', PROFILE, 'gateway_state.json');
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { gateway_state: 'unknown', active_agents: 0 };
  }
}

// ── API: Get session info from logs ──
function getSessionInfo() {
  try {
    const logPath = path.join(HERMES_HOME, 'profiles', PROFILE, 'logs', 'agent.log');
    const raw = execSync(`tail -200 "${logPath}" 2>/dev/null`, { timeout: 5000 }).toString();
    let apiCalls = 0;
    let lastLatency = 0;
    let cacheHit = 0;
    let totalCache = 0;
    let lastModel = '';
    
    for (const line of raw.split('\n')) {
      const apiMatch = line.match(/API call #(\d+)/);
      const latMatch = line.match(/latency=([\d.]+)s/);
      const cacheMatch = line.match(/cache=(\d+)\/(\d+)/);
      const modelMatch = line.match(/model=([\w\-\/\.]+)/);
      
      if (apiMatch) apiCalls = parseInt(apiMatch[1]);
      if (latMatch) lastLatency = parseFloat(latMatch[1]);
      if (cacheMatch) {
        cacheHit = parseInt(cacheMatch[1]);
        totalCache = parseInt(cacheMatch[2]);
      }
      if (modelMatch) lastModel = modelMatch[1];
    }
    
    return {
      apiCalls,
      lastLatency: lastLatency.toFixed(1),
      cacheEfficiency: totalCache > 0 ? Math.round((cacheHit / totalCache) * 100) : 0,
      model: lastModel,
    };
  } catch {
    return { apiCalls: 0, lastLatency: 0, cacheEfficiency: 0, model: 'unknown' };
  }
}

// ── API: Get memory entries ──
function getMemoryEntries() {
  try {
    const memDir = path.join(HERMES_HOME, 'profiles', PROFILE, 'memories');
    if (!fs.existsSync(memDir)) return [];
    const files = fs.readdirSync(memDir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(memDir, f), 'utf8'));
        return { file: f, ...data };
      } catch {
        return { file: f };
      }
    }).slice(0, 10);
  } catch {
    return [];
  }
}

// ── API: Get cron jobs ──
function getCronJobs() {
  try {
    const raw = execSync('pm2 env 35 2>/dev/null | grep -i "cron"', { timeout: 5000 }).toString();
    return raw.split('\n').filter(l => l.trim());
  } catch {
    return [];
  }
}

// ── MIME types ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ── Server ──
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // ── API Routes ──
  if (pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      processes: getPm2Status(),
      gateway: getGatewayState(),
      session: getSessionInfo(),
      timestamp: new Date().toISOString(),
    }));
  }

  if (pathname === '/api/logs') {
    const lines = parseInt(url.searchParams.get('lines')) || 20;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ logs: getAgentLogs(lines) }));
  }

  if (pathname === '/api/memory') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ entries: getMemoryEntries() }));
  }

  // ── Static files ──
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(DASHBOARD_DIR, filePath);

  // Security: prevent path traversal
  if (!filePath.startsWith(DASHBOARD_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hermes Mission Control serving on port ${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  API status: http://localhost:${PORT}/api/status`);
});

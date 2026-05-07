export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const configStatus = {
      github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      admin: !!env.ADMIN_PASSWORD,
      readme: !!env.README_URL,
      deploy: !!env.DEPLOY_README_URL,
      pluginStore: !!env.PLUGIN_STORE,
      submissionStore: !!env.SUBMISSION_STORE,
      pluginFiles: !!env.PLUGIN_FILES,
      statsStore: !!env.STATS_STORE,
      ratingsStore: !!env.RATINGS_STORE,
      database: !!env.DB
    };
    const allConfigured = Object.values(configStatus).every(v => v === true);

    const githubHeaders = { 'User-Agent': 'CRYSNOVA-LIVE/1.0', 'Accept': 'application/vnd.github.v3+json' };

    async function getGitHubUser(accessToken) {
      const res = await fetch('https://api.github.com/user', { headers: { ...githubHeaders, 'Authorization': 'Bearer ' + accessToken } });
      if (!res.ok) throw new Error('Failed to fetch GitHub user');
      return res.json();
    }

    function isAdmin(request) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
      return authHeader.slice(7) === env.ADMIN_PASSWORD;
    }

    async function getGitHubStats() {
      if (env.CRYSNOVA_CACHE) {
        const cached = await env.CRYSNOVA_CACHE.get('github-stats');
        if (cached) return JSON.parse(cached);
      }
      const res = await fetch('https://api.github.com/repos/crysnovax/CRYSNOVA_AI', { headers: githubHeaders });
      const data = await res.json();
      const stats = { stars: data.stargazers_count || 0, forks: data.forks_count || 0 };
      if (env.CRYSNOVA_CACHE) await env.CRYSNOVA_CACHE.put('github-stats', JSON.stringify(stats), { expirationTtl: 300 });
      return stats;
    }

    async function renderMarkdown(rawUrl) {
      const rawRes = await fetch(rawUrl, { headers: githubHeaders });
      if (!rawRes.ok) throw new Error('Failed to fetch: ' + rawRes.status);
      const raw = await rawRes.text();
      const mdRes = await fetch('https://api.github.com/markdown', { method: 'POST', headers: { ...githubHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: raw, mode: 'gfm' }) });
      return mdRes.text();
    }

    async function fetchRawText(rawUrl) {
      const res = await fetch(rawUrl, { headers: githubHeaders });
      return res.text();
    }

    async function sendNotification(subject, body) {
      if (!env.RESEND_API_KEY || !env.DB) return;
      try {
        const { results } = await env.DB.prepare('SELECT email FROM subscribers').all();
        const emails = results.map(r => r.email);
        if (!emails.length) return;
        await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'CRYSNOVA LIVE <notify@panel.crysnovax.link>', to: emails, subject, html: body }) });
      } catch (e) {}
    }

    // API Routes
    if (path === '/api/config-status') return new Response(JSON.stringify(configStatus), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (path === '/api/stats') { const stats = await getGitHubStats(); return new Response(JSON.stringify(stats), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }
    if (path === '/api/readme' && env.README_URL) { try { return new Response(await renderMarkdown(env.README_URL), { headers: { ...corsHeaders, 'Content-Type': 'text/html' } }); } catch { return new Response('Error', { status: 500 }); } }
    if (path === '/api/deploy-script' && env.DEPLOY_README_URL) { try { return new Response(await fetchRawText(env.DEPLOY_README_URL), { headers: { ...corsHeaders, 'Content-Type': 'text/plain' } }); } catch { return new Response('Error', { status: 500 }); } }

    if (path === '/api/plugins') {
      const pluginsJson = await env.PLUGIN_STORE.get('plugins');
      let plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
      for (let p of plugins) {
        const count = await env.STATS_STORE.get('downloads:' + p.id) || '0';
        p.downloads = parseInt(count);
        const list = await env.RATINGS_STORE.list({ prefix: 'rating:' + p.id + ':' });
        let sum = 0, cnt = 0;
        for (const k of list.keys) { const v = await env.RATINGS_STORE.get(k.name); if (v) { sum += parseInt(v); cnt++; } }
        p.rating = cnt > 0 ? (sum / cnt).toFixed(1) : '0.0';
        p.ratingCount = cnt;
      }
      return new Response(JSON.stringify(plugins), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (path === '/api/subscribe' && method === 'POST') {
      const { email } = await request.json();
      if (!email || !email.includes('@')) return new Response(JSON.stringify({ error: 'Valid email required' }), { status: 400, headers: corsHeaders });
      try {
        await env.DB.prepare('INSERT OR REPLACE INTO subscribers (email, subscribed_at) VALUES (?, ?)').bind(email, Date.now()).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders }); }
    }

    if (path === '/api/stats/install' && method === 'POST') {
      const { pluginId } = await request.json();
      if (!pluginId) return new Response(JSON.stringify({ error: 'Missing pluginId' }), { status: 400 });
      const key = 'downloads:' + pluginId;
      const current = await env.STATS_STORE.get(key);
      const count = current ? parseInt(current) + 1 : 1;
      await env.STATS_STORE.put(key, count.toString());
      return new Response(JSON.stringify({ success: true, count }), { headers: corsHeaders });
    }

    if (path === '/api/ratings' && method === 'POST') {
      const { pluginId, rating, accessToken } = await request.json();
      if (!pluginId || !rating || !accessToken) return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400 });
      try {
        const user = await getGitHubUser(accessToken);
        const key = 'rating:' + pluginId + ':' + user.login;
        await env.RATINGS_STORE.put(key, rating.toString());
        const list = await env.RATINGS_STORE.list({ prefix: 'rating:' + pluginId + ':' });
        let sum = 0, cnt = 0;
        for (const k of list.keys) { const v = await env.RATINGS_STORE.get(k.name); if (v) { sum += parseInt(v); cnt++; } }
        return new Response(JSON.stringify({ success: true, average: (cnt > 0 ? (sum / cnt).toFixed(1) : '0.0'), count: cnt }), { headers: corsHeaders });
      } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
    }

    if (path === '/api/submit-plugin' && method === 'POST') {
      const { accessToken, name, description, code, category } = await request.json();
      if (!accessToken || !name || !description || !code) return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400, headers: corsHeaders });
      try {
        const user = await getGitHubUser(accessToken);
        const submissionId = crypto.randomUUID();
        await env.SUBMISSION_STORE.put(submissionId, JSON.stringify({ id: submissionId, name, description, code, category: category || 'utility', author: user.login, authorName: user.name || user.login, authorAvatar: user.avatar_url, submittedAt: Date.now(), status: 'pending' }));
        await sendNotification('New Plugin: ' + name, '<p><strong>' + name + '</strong> by ' + user.login + '</p><p>' + description + '</p>');
        return new Response(JSON.stringify({ success: true, id: submissionId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders }); }
    }

    // Admin API
    if (path.startsWith('/api/admin')) {
      if (!isAdmin(request)) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'WWW-Authenticate': 'Basic' } });
      if (path === '/api/admin/submissions' && method === 'GET') {
        const list = await env.SUBMISSION_STORE.list();
        const submissions = [];
        for (const key of list.keys) { const data = await env.SUBMISSION_STORE.get(key.name); if (data) submissions.push(JSON.parse(data)); }
        return new Response(JSON.stringify(submissions), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (path === '/api/admin/submissions' && method === 'DELETE') { const { id } = await request.json(); if (id) await env.SUBMISSION_STORE.delete(id); return new Response(JSON.stringify({ success: true }), { headers: corsHeaders }); }
      if (path === '/api/admin/approve' && method === 'POST') {
        const { id } = await request.json();
        if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400 });
        const submissionData = await env.SUBMISSION_STORE.get(id);
        if (!submissionData) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        const submission = JSON.parse(submissionData);
        const filename = 'plugins/' + submission.author + '-' + submission.name.replace(/[^a-zA-Z0-9]/g, '_') + '-' + Date.now() + '.js';
        await env.PLUGIN_FILES.put(filename, submission.code);
        let rawUrl = 'https://cdn.crysnovax.link/' + filename;
        try {
          const formData = new FormData();
          formData.append('file', new Blob([submission.code], { type: 'text/plain' }), 'paste.txt');
          const uploadRes = await fetch(env.CDN_URL + '/upload', { method: 'POST', body: formData });
          const uploadData = await uploadRes.json();
          if (uploadData.url) rawUrl = uploadData.url.replace(/\/(upload|file)\//, '/files/').replace(/\.html?$/, '.txt');
        } catch (err) {}
        const pluginsJson = await env.PLUGIN_STORE.get('plugins');
        const plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
        plugins.push({ id: crypto.randomUUID(), name: submission.name, description: submission.description, author: submission.author, authorName: submission.authorName, code: submission.code, category: submission.category || 'utility', filename, url: rawUrl, customUrl: '', verified: true, approvedAt: Date.now() });
        await env.PLUGIN_STORE.put('plugins', JSON.stringify(plugins));
        await env.SUBMISSION_STORE.delete(id);
        return new Response(JSON.stringify({ success: true, url: rawUrl }), { headers: corsHeaders });
      }
      if (path === '/api/admin/plugins' && method === 'GET') { const p = await env.PLUGIN_STORE.get('plugins'); return new Response(p || '[]', { headers: { ...corsHeaders } }); }
      if (path === '/api/admin/plugins' && method === 'PUT') {
        const { id, name, description, code, customUrl, category } = await request.json();
        const pluginsJson = await env.PLUGIN_STORE.get('plugins');
        let plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
        const idx = plugins.findIndex(p => p.id === id);
        if (idx === -1) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        if (name) plugins[idx].name = name;
        if (description) plugins[idx].description = description;
        if (customUrl !== undefined) plugins[idx].customUrl = customUrl;
        if (category) plugins[idx].category = category;
        if (code) { plugins[idx].code = code; if (plugins[idx].filename) await env.PLUGIN_FILES.put(plugins[idx].filename, code); }
        await env.PLUGIN_STORE.put('plugins', JSON.stringify(plugins));
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
      if (path === '/api/admin/plugins' && method === 'DELETE') {
        const { id } = await request.json();
        const pluginsJson = await env.PLUGIN_STORE.get('plugins');
        let plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
        const plugin = plugins.find(p => p.id === id);
        if (plugin?.filename) await env.PLUGIN_FILES.delete(plugin.filename).catch(() => {});
        plugins = plugins.filter(p => p.id !== id);
        await env.PLUGIN_STORE.put('plugins', JSON.stringify(plugins));
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
    }

    // OAuth callback
    if (path === '/auth/github/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('Missing code', { status: 400 });
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }) });
      const tokenData = await tokenRes.json();
      if (tokenData.error) return new Response(tokenData.error_description, { status: 400 });
      return new Response('<!DOCTYPE html><html><head><script>window.opener.postMessage({ type: "github-oauth", accessToken: "' + tokenData.access_token + '" }, "*");window.close();</script></head><body>Authenticated!</body></html>', { headers: { 'Content-Type': 'text/html' } });
    }

    // Raw files
    if (path.startsWith('/raw/')) {
      const content = await env.PLUGIN_FILES.get(path.slice(5));
      if (!content) return new Response('Not found', { status: 404 });
      return new Response(content, { headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } });
    }

    // Plugin detail page
    if (path.startsWith('/plugin/')) {
      const pluginId = path.slice(8);
      const pluginsJson = await env.PLUGIN_STORE.get('plugins');
      const plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
      const plugin = plugins.find(p => p.id === pluginId);
      if (!plugin) return new Response('Not found', { status: 404 });
      return new Response(pluginDetailHTML(plugin, env), { headers: { 'Content-Type': 'text/html' } });
    }

    // Main frontend
    return new Response(mainHTML(env, path, await getGitHubStats(), configStatus, allConfigured), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }
};

function pluginDetailHTML(plugin, env) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${plugin.name} - CRYSNOVA</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"><style>${baseStyles()}</style></head><body><div class="bg-grid"></div><div class="orb orb-1"></div><div class="orb orb-2"></div><div class="container"><div class="header"><h1>${plugin.name}</h1><p style="color:var(--text2)">${plugin.description}</p></div><div class="card"><div class="stats"><div class="stat-item"><div class="stat-number">${plugin.rating || '0'}</div><div>⭐ Rating</div></div><div class="stat-item"><div class="stat-number">${plugin.downloads || '0'}</div><div>⬇️ Installs</div></div></div><p style="margin:1rem 0">👤 ${plugin.authorName || plugin.author}</p><div class="code-block"><code>.plugin ${plugin.customUrl || plugin.url}</code></div><button class="btn btn-primary" onclick="copyText('.plugin ${plugin.customUrl || plugin.url}')">📋 Copy Install Command</button></div><div class="card"><h3>📜 Source Code</h3><pre style="background:var(--surface2);padding:1rem;border-radius:12px;overflow:auto;max-height:400px"><code>${escapeHtml(plugin.code)}</code></pre></div><a href="/plugins" class="btn btn-secondary">← Back to Plugins</a></div></body></html>`;
}

function escapeHtml(text) { return text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }

function escapeJs(s) { return String(s).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n').replace(/\r/g,'\\r'); }

function baseStyles() {
  return `
    :root{--bg:#0a0a0f;--surface:#111118;--surface2:#16161f;--border:#1e1e2e;--primary:#6366f1;--primary-glow:rgba(99,102,241,0.3);--accent:#818cf8;--text:#e2e2f0;--text2:#a0a0b8;--text3:#6b6b80;--danger:#ef4444;--success:#10b981;--warning:#f59e0b;--cyan:#06b6d4;--radius:12px;--radius-lg:20px}
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;min-height:100vh;overflow-x:hidden}
    .bg-grid{position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;opacity:0.03;background-image:linear-gradient(rgba(99,102,241,0.3) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,0.3) 1px,transparent 1px);background-size:60px 60px;animation:gridMove 20s linear infinite}
    @keyframes gridMove{0%{transform:translate(0,0)}100%{transform:translate(60px,60px)}}
    .orb{position:fixed;border-radius:50%;filter:blur(120px);opacity:0.12;z-index:0;pointer-events:none}
    .orb-1{width:500px;height:500px;background:var(--primary);top:-150px;right:-150px;animation:orbFloat 15s ease-in-out infinite}
    .orb-2{width:350px;height:350px;background:var(--cyan);bottom:-100px;left:-100px;animation:orbFloat 18s ease-in-out infinite reverse}
    @keyframes orbFloat{0%,100%{transform:translate(0,0)scale(1)}33%{transform:translate(40px,-30px)scale(1.1)}66%{transform:translate(-30px,40px)scale(0.9)}}
    .container{max-width:1100px;margin:0 auto;padding:2rem;position:relative;z-index:1}
    .header{text-align:center;margin-bottom:2.5rem;padding:2rem;background:rgba(17,17,24,0.6);backdrop-filter:blur(20px);border:1px solid var(--border);border-radius:var(--radius-lg)}
    h1{font-size:2.5rem;font-weight:800;background:linear-gradient(135deg,var(--primary),var(--accent),var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-size:200%200%;animation:shimmer 4s ease-in-out infinite;letter-spacing:-0.02em}
    @keyframes shimmer{0%,100%{background-position:0%50%}50%{background-position:100%50%}}
    .nav{display:flex;justify-content:center;gap:8px;margin-bottom:2rem;flex-wrap:wrap;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:6px}
    .nav a{color:var(--text2);text-decoration:none;padding:0.7rem 1.4rem;border-radius:10px;font-size:0.9rem;font-weight:500;transition:all 0.3s}
    .nav a:hover,.nav a.active{background:var(--primary);color:#fff}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:2rem;margin-bottom:1.5rem;transition:all 0.3s}
    .card:hover{border-color:rgba(99,102,241,0.4);box-shadow:0 0 40px rgba(99,102,241,0.05)}
    .stats{display:flex;gap:2rem;justify-content:center;flex-wrap:wrap}
    .stat-item{text-align:center}
    .stat-number{font-size:2.5rem;font-weight:800;color:var(--primary)}
    .btn{display:inline-flex;align-items:center;gap:8px;padding:0.8rem 1.8rem;border-radius:var(--radius);font-size:0.9rem;font-weight:600;cursor:pointer;transition:all 0.3s;border:none;text-decoration:none;font-family:'Inter',sans-serif}
    .btn-primary{background:linear-gradient(135deg,var(--primary),var(--accent));color:#fff}
    .btn-primary:hover{box-shadow:0 0 30px var(--primary-glow);transform:translateY(-2px)}
    .btn-secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border)}
    .btn-secondary:hover{border-color:var(--primary)}
    .btn-success{background:var(--success);color:#fff}.btn-danger{background:var(--danger);color:#fff}.btn-warning{background:var(--warning);color:#000}
    .plugin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
    .plugin-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:1.5rem;transition:all 0.3s}
    .plugin-card:hover{border-color:var(--primary);transform:translateY(-3px);box-shadow:0 20px 40px rgba(0,0,0,0.3)}
    .code-block{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;font-family:'JetBrains Mono',monospace;font-size:0.85rem;overflow-x:auto;margin:0.5rem 0}
    input,textarea,select{width:100%;padding:0.9rem;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:'Inter',sans-serif;font-size:0.9rem;outline:none;margin-bottom:0.8rem}
    input:focus,textarea:focus,select:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(99,102,241,0.1)}
    .social-section{display:flex;justify-content:center;gap:16px;flex-wrap:wrap;margin:2rem 0}
    .social-btn{display:flex;align-items:center;gap:8px;padding:0.7rem 1.4rem;border-radius:50px;text-decoration:none;font-weight:500;font-size:0.9rem;transition:all 0.3s;color:var(--text)}
    .social-btn.wa{background:rgba(37,211,102,0.1);border:1px solid rgba(37,211,102,0.3)}
    .social-btn.wa:hover{background:rgba(37,211,102,0.2)}
    .social-btn.yt{background:rgba(255,0,0,0.1);border:1px solid rgba(255,0,0,0.3)}
    .social-btn.gh{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.2)}
    .footer{text-align:center;color:var(--text3);margin-top:3rem;padding-top:2rem;border-top:1px solid var(--border)}
    .modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:100}
    .modal-content{background:var(--surface);padding:2rem;border-radius:var(--radius-lg);max-width:500px;width:90%;border:1px solid var(--border)}
    .toast{position:fixed;bottom:2rem;right:2rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.5rem;z-index:1000;animation:slideIn 0.3s ease}
    @keyframes slideIn{from{transform:translateY(100px);opacity:0}to{transform:translateY(0);opacity:1}}
    @media(max-width:768px){h1{font-size:1.8rem}.container{padding:1rem}}
  `;
}

function mainHTML(env, path, stats, configStatus, allConfigured) {
  const isHome = path === '/' || path === '';
  const isDeploy = path === '/deploy';
  const isPlugins = path === '/plugins';
  const isSubmit = path === '/submit';
  const isAdmin = path === '/admin';
  const isDocs = path === '/docs';

  const pageTitle = isHome ? 'CRYSN⚉VA LIVE' : isDeploy ? 'DEPLOY' : isPlugins ? 'PLUGINS' : isSubmit ? 'SUBMIT' : isAdmin ? 'ADMIN' : 'DOCS';
  const pageIcon = isHome ? '❄️' : isDeploy ? '🚀' : isPlugins ? '🔌' : isSubmit ? '📤' : isAdmin ? '🛡️' : '📚';

  const dots = {
    info: configStatus.readme ? '🟢' : '🔴',
    deploy: configStatus.deploy ? '🟢' : '🔴',
    plugins: (configStatus.pluginStore && configStatus.pluginFiles) ? '🟢' : '🔴',
    submit: configStatus.github ? '🟢' : '🔴',
    admin: configStatus.admin ? '🟢' : '🔴'
  };

  let pageContent = '';

  if (isHome) {
    pageContent = `
      <div class="card"><h2>📊 GitHub Stats</h2><div class="stats"><div class="stat-item"><div class="stat-number" id="stars">${stats.stars}</div><div>⭐ Stars</div></div><div class="stat-item"><div class="stat-number" id="forks">${stats.forks}</div><div>🍴 Forks</div></div></div></div>
      <div class="card"><h2>📖 README</h2><div id="readme-container" style="max-height:70vh;overflow-y:auto;padding:1rem">Loading...</div></div>
      <div class="card"><h2>📬 Subscribe</h2><input type="email" id="subscribe-email" placeholder="Your email"><button class="btn btn-primary" onclick="subscribeEmail()">Subscribe</button><p id="subscribe-status" style="margin-top:0.5rem"></p></div>
      <div class="card"><h2>📧 Contact</h2><div class="code-block"><code>crysnovax@gmail.com</code></div><button class="btn btn-secondary" onclick="copyText('crysnovax@gmail.com')">📋 Copy</button></div>
    `;
  } else if (isDeploy) {
    pageContent = `
      <div class="card"><h2>🚀 One-Click Deploy</h2><p style="color:var(--text2);margin-bottom:1rem">Copy the script below and run it in your terminal.</p><div style="position:relative"><button class="btn btn-primary" onclick="copyCode()" style="margin-bottom:1rem">📋 Copy Script</button><div class="code-block"><pre><code id="deploy-script">Loading...</code></pre></div></div></div>
    `;
  } else if (isPlugins) {
    pageContent = `
      <div class="card"><h2>🔌 Plugin Marketplace</h2><input type="text" id="plugin-search" placeholder="🔍 Search plugins..."><select id="category-filter"><option value="">All Categories</option><option value="fun">🎮 Fun</option><option value="utility">🔧 Utility</option><option value="ai">🤖 AI</option><option value="admin">🛡️ Admin</option><option value="downloader">📥 Downloader</option></select><div id="plugin-list" class="plugin-grid">Loading...</div></div>
    `;
  } else if (isSubmit) {
    pageContent = `
      <div class="card"><h2>📤 Submit Plugin</h2><div id="submit-status"></div><div id="login-prompt"><button class="btn btn-primary" onclick="loginWithGitHub()">🔐 Login with GitHub</button></div><div id="submit-form" style="display:none"><input type="text" id="plugin-name" placeholder="Plugin Name"><textarea id="plugin-desc" placeholder="Description" rows="3"></textarea><textarea id="plugin-code" placeholder="JavaScript Code" rows="10" style="font-family:monospace"></textarea><select id="plugin-category"><option value="">Category</option><option value="fun">🎮 Fun</option><option value="utility">🔧 Utility</option><option value="ai">🤖 AI</option><option value="admin">🛡️ Admin</option><option value="downloader">📥 Downloader</option></select><button class="btn btn-primary" onclick="submitPlugin()">Submit for Review</button></div></div>
    `;
  } else if (isAdmin) {
    pageContent = `
      <div class="card"><h2>🛡️ Admin Panel</h2><div id="admin-login"><input type="password" id="admin-password" placeholder="Admin Password"><button class="btn btn-primary" onclick="adminLogin()">Login</button><p id="login-error" style="color:var(--danger)"></p></div><div id="admin-panel" style="display:none"><h3>⏳ Pending Submissions</h3><div id="submissions-list">Loading...</div><hr style="border-color:var(--border);margin:2rem 0"><h3>📦 Approved Plugins</h3><div id="approved-plugins-list">Loading...</div></div></div>
      <div id="editModal" class="modal" style="display:none"><div class="modal-content"><h3>✏️ Edit Plugin</h3><input type="hidden" id="edit-plugin-id"><label>Name</label><input type="text" id="edit-plugin-name"><label>Description</label><textarea id="edit-plugin-desc" rows="2"></textarea><label>Code</label><textarea id="edit-plugin-code" rows="8" style="font-family:monospace"></textarea><label>Custom URL</label><input type="text" id="edit-plugin-url"><label>Category</label><select id="edit-plugin-category"><option value="fun">🎮 Fun</option><option value="utility">🔧 Utility</option><option value="ai">🤖 AI</option><option value="admin">🛡️ Admin</option><option value="downloader">📥 Downloader</option></select><div style="display:flex;gap:10px;justify-content:flex-end;margin-top:1rem"><button class="btn btn-danger" onclick="closeEditModal()">Cancel</button><button class="btn btn-success" onclick="savePluginEdit()">Save</button></div></div></div>
    `;
  } else if (isDocs) {
    pageContent = `
      <div class="card"><h2>📚 API Docs</h2><h3>Public</h3><div class="code-block"><code>GET /api/plugins</code> - List plugins<br><code>GET /api/stats</code> - GitHub stats<br><code>POST /api/subscribe</code> - Subscribe<br><code>POST /api/ratings</code> - Rate plugin</div><h3 style="margin-top:1rem">Admin</h3><div class="code-block"><code>GET /api/admin/submissions</code><br><code>POST /api/admin/approve</code><br><code>PUT /api/admin/plugins</code><br><code>DELETE /api/admin/plugins</code></div></div>
    `;
  }

  const socials = `
    <a href="https://whatsapp.com/channel/0029Vb6pe77K0IBn48HLKb38" target="_blank" class="social-btn wa">📱 Channel</a>
    <a href="https://chat.whatsapp.com/Besbj8VIle1GwxKKZv1lax" target="_blank" class="social-btn wa">👥 Group</a>
    <a href="https://youtube.com/@crysnovax" target="_blank" class="social-btn yt">▶️ YouTube</a>
    <a href="https://github.com/crysnovax" target="_blank" class="social-btn gh">💻 GitHub</a>
  `;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${pageIcon} ${pageTitle} - CRYSNOVA</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"><style>${baseStyles()}</style></head><body><div class="bg-grid"></div><div class="orb orb-1"></div><div class="orb orb-2"></div><div class="container"><div class="header"><h1>${pageIcon} ${pageTitle}</h1><p style="color:var(--text2);margin-top:0.5rem">The AI Powerhouse Behind the Bot</p></div>${allConfigured ? '' : '<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:12px;padding:1rem;margin-bottom:1.5rem;text-align:center;color:var(--danger)">⚠️ Some services not configured</div>'}<div class="nav"><a href="/" class="${isHome?'active':''}">${dots.info} Info</a><a href="/deploy" class="${isDeploy?'active':''}">${dots.deploy} Deploy</a><a href="/plugins" class="${isPlugins?'active':''}">${dots.plugins} Plugins</a><a href="/submit" class="${isSubmit?'active':''}">${dots.submit} Submit</a><a href="/admin" class="${isAdmin?'active':''}">${dots.admin} Admin</a><a href="/docs" class="${isDocs?'active':''}">📚 Docs</a></div>${pageContent}<div class="social-section">${socials}</div><div class="footer"><p style="font-weight:700;font-size:1.2rem;background:linear-gradient(135deg,var(--primary),var(--accent));-webkit-background-clip:text;-webkit-text-fill-color:transparent">CRYSNOVA AI</p><p style="font-size:0.8rem;margin-top:0.3rem">Live Documentation • Real-time from GitHub</p></div></div><script>${scripts(env)}</script></body></html>`;
}

function scripts(env) {
  return `
    const GITHUB_CLIENT_ID="${env.GITHUB_CLIENT_ID||''}";
    let adminToken=sessionStorage.getItem("admin_token");
    let githubAccessToken=sessionStorage.getItem("github_token");
    let deployScriptContent="";
    function copyText(t){navigator.clipboard.writeText(t);showToast('📋 Copied!')}
    function showToast(m){var e=document.querySelector('.toast');if(e)e.remove();var t=document.createElement('div');t.className='toast';t.textContent=m;document.body.appendChild(t);setTimeout(function(){t.remove()},3000)}
    async function loadReadme(){var c=document.getElementById("readme-container");if(!c)return;try{var r=await fetch("/api/readme");c.innerHTML=await r.text()}catch(e){c.innerHTML="Failed to load"}}
    async function loadDeployScript(){var c=document.getElementById("deploy-script");if(!c)return;try{var r=await fetch("/api/deploy-script");deployScriptContent=await r.text();c.textContent=deployScriptContent}catch(e){c.textContent="Failed"}}
    async function refreshStats(){try{var r=await fetch("/api/stats");var d=await r.json();document.getElementById("stars").innerText=d.stars;document.getElementById("forks").innerText=d.forks}catch(e){}}
    function copyCode(){if(deployScriptContent){navigator.clipboard.writeText(deployScriptContent);showToast('📋 Copied!')}}
    async function recordInstall(id){await fetch("/api/stats/install",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pluginId:id})})}
    async function loadPlugins(){var c=document.getElementById("plugin-list");if(!c)return;var s=document.getElementById("plugin-search")?.value.toLowerCase()||"";var cat=document.getElementById("category-filter")?.value||"";try{var r=await fetch("/api/plugins");var p=await r.json();p=p.filter(function(x){return x.name.toLowerCase().indexOf(s)!==-1&&(!cat||x.category===cat)});if(!p.length){c.innerHTML="<p>No plugins found</p>";return}var h="";p.forEach(function(x){var url=x.customUrl||x.url;h+='<div class="plugin-card"><h3>'+x.name+' <span style="color:#fbbf24">⭐ '+x.rating+'</span></h3><p>'+x.description+'</p><p>⬇️ '+x.downloads+' installs</p><div class="code-block"><code>.plugin '+url+'</code></div><button class="btn btn-primary" onclick="copyText(\\'.plugin '+url+'\\');recordInstall(\\''+x.id+'\\')">📋 Copy</button> <button class="btn btn-secondary" onclick="location.href=\\'/plugin/'+x.id+'\\'">🔍 Details</button> <button class="btn btn-secondary" onclick="ratePlugin(\\''+x.id+'\\')">⭐ Rate</button></div>'});c.innerHTML=h}catch(e){c.innerHTML="Failed"}}
    if(document.getElementById("plugin-search")){document.getElementById("plugin-search").addEventListener("input",loadPlugins);document.getElementById("category-filter").addEventListener("change",loadPlugins)}
    function loginWithGitHub(){var w=600,h=600;var l=(screen.width-w)/2,t=(screen.height-h)/2;window.open("https://github.com/login/oauth/authorize?client_id="+GITHUB_CLIENT_ID+"&redirect_uri="+encodeURIComponent("https://panel.crysnovax.link/auth/github/callback")+"&scope=read:user","GitHub","width="+w+",height="+h+",left="+l+",top="+t)}
    window.addEventListener("message",function(e){if(e.data.type==="github-oauth"&&e.data.accessToken){githubAccessToken=e.data.accessToken;sessionStorage.setItem("github_token",githubAccessToken);document.getElementById("login-prompt").style.display="none";document.getElementById("submit-form").style.display="block"}})
    async function submitPlugin(){var n=document.getElementById("plugin-name").value.trim();var d=document.getElementById("plugin-desc").value.trim();var c=document.getElementById("plugin-code").value.trim();var cat=document.getElementById("plugin-category").value;if(!n||!d||!c){showToast("All fields required");return}var s=document.getElementById("submit-status");s.innerHTML="Submitting...";try{var r=await fetch("/api/submit-plugin",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accessToken:githubAccessToken,name:n,description:d,code:c,category:cat})});var data=await r.json();s.innerHTML=data.success?'<p style="color:var(--success)">✓ Submitted!</p>':'<p style="color:var(--danger)">✘ Failed</p>'}catch(e){s.innerHTML="Error"}}
    async function subscribeEmail(){var email=document.getElementById("subscribe-email").value.trim();var s=document.getElementById("subscribe-status");if(!email){s.innerHTML='<p style="color:var(--danger)">Enter email</p>';return}try{var r=await fetch("/api/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:email})});var d=await r.json();s.innerHTML=d.success?'<p style="color:var(--success)">✓ Subscribed!</p>':'<p style="color:var(--danger)">Failed</p>'}catch(e){s.innerHTML="Error"}}
    async function ratePlugin(id){if(!githubAccessToken){showToast("Login first");return}var rating=prompt("Rate 1-5:");if(!rating||isNaN(rating)||rating<1||rating>5)return;try{var r=await fetch("/api/ratings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pluginId:id,rating:parseInt(rating),accessToken:githubAccessToken})});var d=await r.json();if(d.success){showToast("Rated! Avg: "+d.average);loadPlugins()}}catch(e){showToast("Error")}}
    function adminLogin(){adminToken=document.getElementById("admin-password").value;sessionStorage.setItem("admin_token",adminToken);loadAdminPanel()}
    async function loadAdminPanel(){if(!adminToken)return;try{var r=await fetch("/api/admin/submissions",{headers:{"Authorization":"Bearer "+adminToken}});if(!r.ok){document.getElementById("login-error").innerText="Invalid";return}document.getElementById("admin-login").style.display="none";document.getElementById("admin-panel").style.display="block";loadSubmissions();loadApprovedPlugins()}catch(e){}}
    async function loadSubmissions(){var l=document.getElementById("submissions-list");if(!l)return;try{var r=await fetch("/api/admin/submissions",{headers:{"Authorization":"Bearer "+adminToken}});var s=await r.json();if(!s.length){l.innerHTML="<p>No pending</p>";return}var h="";s.forEach(function(x){h+='<div style="border:1px solid var(--border);border-radius:12px;padding:1rem;margin-bottom:1rem"><h4>'+x.name+' by '+x.author+'</h4><p>'+x.description+'</p><details><summary>Code</summary><pre>'+x.code.replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c]})+'</pre></details><div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-success" onclick="approvePlugin(\\''+x.id+'\\')">✓ Accept</button><button class="btn btn-danger" onclick="rejectPlugin(\\''+x.id+'\\')">✗ Reject</button></div></div>'});l.innerHTML=h}catch(e){}}
    async function loadApprovedPlugins(){var c=document.getElementById("approved-plugins-list");if(!c)return;try{var r=await fetch("/api/admin/plugins",{headers:{"Authorization":"Bearer "+adminToken}});var p=await r.json();if(!p.length){c.innerHTML="<p>None</p>";return}var h="";p.forEach(function(x){var url=x.customUrl||x.url;h+='<div style="border:1px solid var(--border);border-radius:12px;padding:1rem;margin-bottom:1rem"><h4>'+x.name+' by '+x.author+'</h4><p><code>.plugin '+url+'</code></p><div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-warning" onclick="editPlugin(\\''+x.id+'\\',\\''+x.name.replace(/'/g,"\\\\'")+'\\',\\''+(x.description||'').replace(/'/g,"\\\\'")+'\\',\\''+(x.code||'').replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'").replace(/\\n/g,'\\\\n')+'\\',\\''+(x.customUrl||'').replace(/'/g,"\\\\'")+'\\',\\''+(x.category||'utility')+'\\')">✏️ Edit</button><button class="btn btn-danger" onclick="deletePlugin(\\''+x.id+'\\')">🗑️ Delete</button></div></div>'});c.innerHTML=h}catch(e){}}
    async function approvePlugin(id){await fetch("/api/admin/approve",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+adminToken},body:JSON.stringify({id})});showToast("Approved!");loadSubmissions();loadApprovedPlugins();if(typeof loadPlugins==="function")loadPlugins()}
    async function rejectPlugin(id){if(!confirm("Reject?"))return;await fetch("/api/admin/submissions",{method:"DELETE",headers:{"Content-Type":"application/json","Authorization":"Bearer "+adminToken},body:JSON.stringify({id})});showToast("Rejected");loadSubmissions()}
    function editPlugin(id,name,desc,code,customUrl,category){document.getElementById("edit-plugin-id").value=id;document.getElementById("edit-plugin-name").value=name;document.getElementById("edit-plugin-desc").value=desc;document.getElementById("edit-plugin-code").value=code;document.getElementById("edit-plugin-url").value=customUrl;document.getElementById("edit-plugin-category").value=category||"utility";document.getElementById("editModal").style.display="flex"}
    function closeEditModal(){document.getElementById("editModal").style.display="none"}
    async function savePluginEdit(){var id=document.getElementById("edit-plugin-id").value;var name=document.getElementById("edit-plugin-name").value.trim();var desc=document.getElementById("edit-plugin-desc").value.trim();var code=document.getElementById("edit-plugin-code").value.trim();var url=document.getElementById("edit-plugin-url").value.trim();var cat=document.getElementById("edit-plugin-category").value;var r=await fetch("/api/admin/plugins",{method:"PUT",headers:{"Content-Type":"application/json","Authorization":"Bearer "+adminToken},body:JSON.stringify({id,name,description:desc,code,customUrl:url,category:cat})});var d=await r.json();if(d.success){showToast("Updated!");closeEditModal();loadApprovedPlugins();if(typeof loadPlugins==="function")loadPlugins()}}
    async function deletePlugin(id){if(!confirm("Delete?"))return;var r=await fetch("/api/admin/plugins",{method:"DELETE",headers:{"Content-Type":"application/json","Authorization":"Bearer "+adminToken},body:JSON.stringify({id})});var d=await r.json();if(d.success){showToast("Deleted!");loadApprovedPlugins();if(typeof loadPlugins==="function")loadPlugins()}}
    if(location.pathname==="/"||location.pathname===""){loadReadme();refreshStats();setInterval(refreshStats,300000)}
    else if(location.pathname==="/deploy"){loadDeployScript()}
    else if(location.pathname==="/plugins"){loadPlugins()}
    else if(location.pathname==="/submit"){if(githubAccessToken){document.getElementById("login-prompt").style.display="none";document.getElementById("submit-form").style.display="block"}}
    else if(location.pathname==="/admin"){if(adminToken)loadAdminPanel()}
  `;
}
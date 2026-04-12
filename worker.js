// worker.js – CRYSNOVA LIVE Final Production Build
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
      pluginFiles: !!env.PLUGIN_FILES
    };
    const allConfigured = Object.values(configStatus).every(v => v === true);

    const githubHeaders = { 'User-Agent': 'CRYSNOVA-LIVE/1.0', 'Accept': 'application/vnd.github.v3+json' };

    async function getGitHubUser(accessToken) {
      const res = await fetch('https://api.github.com/user', {
        headers: { ...githubHeaders, 'Authorization': 'Bearer ' + accessToken }
      });
      if (!res.ok) throw new Error('Failed to fetch GitHub user');
      return res.json();
    }

    function isAdmin(request) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
      return authHeader.slice(7) === env.ADMIN_PASSWORD;
    }

    async function getGitHubStats() {
      const cacheKey = 'github-stats';
      if (env.CRYSNOVA_CACHE) {
        const cached = await env.CRYSNOVA_CACHE.get(cacheKey);
        if (cached) return JSON.parse(cached);
      }
      const res = await fetch('https://api.github.com/repos/crysnovax/CRYSNOVA_AI', { headers: githubHeaders });
      const data = await res.json();
      const stats = { stars: data.stargazers_count || 0, forks: data.forks_count || 0 };
      if (env.CRYSNOVA_CACHE) {
        await env.CRYSNOVA_CACHE.put(cacheKey, JSON.stringify(stats), { expirationTtl: 300 });
      }
      return stats;
    }

    async function renderMarkdown(rawUrl) {
      const rawRes = await fetch(rawUrl, { headers: githubHeaders });
      if (!rawRes.ok) throw new Error('Failed to fetch raw content: ' + rawRes.status);
      const raw = await rawRes.text();
      const mdRes = await fetch('https://api.github.com/markdown', {
        method: 'POST',
        headers: { ...githubHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: raw, mode: 'gfm' })
      });
      return mdRes.text();
    }

    async function fetchRawText(rawUrl) {
      const res = await fetch(rawUrl, { headers: githubHeaders });
      return res.text();
    }

    // Public API
    if (path === '/api/config-status') {
      return new Response(JSON.stringify(configStatus), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (path === '/api/stats') {
      const stats = await getGitHubStats();
      return new Response(JSON.stringify(stats), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (path === '/api/readme') {
      if (!env.README_URL) return new Response('README_URL not configured', { status: 500 });
      try {
        const html = await renderMarkdown(env.README_URL);
        return new Response(html, { headers: { ...corsHeaders, 'Content-Type': 'text/html' } });
      } catch { return new Response('Error fetching README', { status: 500 }); }
    }
    if (path === '/api/deploy-script') {
      if (!env.DEPLOY_README_URL) return new Response('DEPLOY_README_URL not configured', { status: 500 });
      try {
        const raw = await fetchRawText(env.DEPLOY_README_URL);
        return new Response(raw, { headers: { ...corsHeaders, 'Content-Type': 'text/plain' } });
      } catch { return new Response('Error fetching deployment script', { status: 500 }); }
    }
    if (path === '/api/plugins') {
      const pluginsJson = await env.PLUGIN_STORE.get('plugins');
      const plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
      return new Response(JSON.stringify(plugins), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Submit Plugin
    if (path === '/api/submit-plugin' && method === 'POST') {
      const { accessToken, name, description, code } = await request.json();
      if (!accessToken || !name || !description || !code) {
        return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400, headers: corsHeaders });
      }
      try {
        const user = await getGitHubUser(accessToken);
        const submissionId = crypto.randomUUID();
        const submission = {
          id: submissionId, name, description, code,
          author: user.login, authorName: user.name || user.login, authorAvatar: user.avatar_url,
          submittedAt: Date.now(), status: 'pending'
        };
        await env.SUBMISSION_STORE.put(submissionId, JSON.stringify(submission));
        return new Response(JSON.stringify({ success: true, id: submissionId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Admin API
    if (path.startsWith('/api/admin')) {
      if (!isAdmin(request)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'WWW-Authenticate': 'Basic realm="Admin"' } });
      }

      if (path === '/api/admin/submissions' && method === 'GET') {
        const list = await env.SUBMISSION_STORE.list();
        const submissions = [];
        for (const key of list.keys) {
          const data = await env.SUBMISSION_STORE.get(key.name);
          if (data) submissions.push(JSON.parse(data));
        }
        return new Response(JSON.stringify(submissions), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (path === '/api/admin/submissions' && method === 'DELETE') {
        const { id } = await request.json();
        if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400 });
        await env.SUBMISSION_STORE.delete(id);
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      if (path === '/api/admin/approve' && method === 'POST') {
        const { id } = await request.json();
        if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400 });
        const submissionData = await env.SUBMISSION_STORE.get(id);
        if (!submissionData) return new Response(JSON.stringify({ error: 'Submission not found' }), { status: 404 });
        const submission = JSON.parse(submissionData);
        const filename = 'plugins/' + submission.author + '-' + submission.name.replace(/[^a-zA-Z0-9]/g, '_') + '-' + Date.now() + '.js';
        await env.PLUGIN_FILES.put(filename, submission.code);
        const cdnUrl = 'https://cdn.crysnovax.link/' + filename;
        const pluginsJson = await env.PLUGIN_STORE.get('plugins');
        const plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
        plugins.push({
          id: crypto.randomUUID(),
          name: submission.name,
          description: submission.description,
          author: submission.author,
          authorName: submission.authorName,
          code: submission.code,
          filename: filename,
          url: cdnUrl,
          customUrl: '',
          verified: true,
          approvedAt: Date.now()
        });
        await env.PLUGIN_STORE.put('plugins', JSON.stringify(plugins));
        await env.SUBMISSION_STORE.delete(id);
        return new Response(JSON.stringify({ success: true, url: cdnUrl }), { headers: corsHeaders });
      }

      if (path === '/api/admin/plugins' && method === 'GET') {
        const pluginsJson = await env.PLUGIN_STORE.get('plugins');
        const plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
        return new Response(JSON.stringify(plugins), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (path === '/api/admin/plugins' && method === 'PUT') {
        const { id, name, description, code, customUrl } = await request.json();
        if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400 });
        const pluginsJson = await env.PLUGIN_STORE.get('plugins');
        let plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
        const index = plugins.findIndex(p => p.id === id);
        if (index === -1) return new Response(JSON.stringify({ error: 'Plugin not found' }), { status: 404 });
        if (name !== undefined) plugins[index].name = name;
        if (description !== undefined) plugins[index].description = description;
        if (customUrl !== undefined) plugins[index].customUrl = customUrl;
        if (code !== undefined) {
          plugins[index].code = code;
          const filename = plugins[index].filename;
          if (filename) await env.PLUGIN_FILES.put(filename, code);
        }
        await env.PLUGIN_STORE.put('plugins', JSON.stringify(plugins));
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      if (path === '/api/admin/plugins' && method === 'DELETE') {
        const { id } = await request.json();
        if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400 });
        const pluginsJson = await env.PLUGIN_STORE.get('plugins');
        let plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
        const plugin = plugins.find(p => p.id === id);
        if (!plugin) return new Response(JSON.stringify({ error: 'Plugin not found' }), { status: 404 });
        if (plugin.filename) await env.PLUGIN_FILES.delete(plugin.filename).catch(() => {});
        plugins = plugins.filter(p => p.id !== id);
        await env.PLUGIN_STORE.put('plugins', JSON.stringify(plugins));
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
    }

    // OAuth Callback
    if (path === '/auth/github/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('Missing code', { status: 400 });
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code })
      });
      const tokenData = await tokenRes.json();
      if (tokenData.error) return new Response(tokenData.error_description, { status: 400 });
      return new Response(
        '<!DOCTYPE html><html><head><script>' +
        'window.opener.postMessage({ type: "github-oauth", accessToken: "' + tokenData.access_token + '" }, "*");' +
        'window.close();' +
        '</script></head><body>Authenticated! You can close this window.</body></html>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    }

    // Page setup
    const isDeploy = path === '/deploy';
    const isPlugins = path === '/plugins';
    const isAdminPanel = path === '/admin';
    const isSubmit = path === '/submit';
    const stats = await getGitHubStats();
    const repoUrl = 'https://github.com/crysnovax/CRYSNOVA_AI';
    const channelUrl = 'https://whatsapp.com/channel/0029Vb6pe77K0IBn48HLKb38';
    const groupUrl = 'https://chat.whatsapp.com/Besbj8VIle1GwxKKZv1lax?mode=gi_t';
    const youtubeUrl = 'https://youtube.com/@crysnovax?si=jpJRPNUoaXs_DEca';
    const tiktokUrl = 'https://www.tiktok.com/@crysnovax?_r=1&_t=ZS-95TCW7pMML7';
    const email = 'crysnovax@gmail.com';

    let pageTitle = 'CRYSN⚉VA LIVE 🜲';
    if (isDeploy) pageTitle = 'CRYSNOVA DEPLOY';
    else if (isPlugins) pageTitle = 'CRYSNOVA PLUGINS';
    else if (isAdminPanel) pageTitle = 'CRYSNOVA ADMIN';
    else if (isSubmit) pageTitle = 'CRYSNOVA SUBMIT';

    const infoDot = configStatus.readme ? '🟢' : '🔴';
    const deployDot = configStatus.deploy ? '🟢' : '🔴';
    const pluginsDot = (configStatus.pluginStore && configStatus.pluginFiles) ? '🟢' : '🔴';
    const submitDot = configStatus.github ? '🟢' : '🔴';
    const adminDot = configStatus.admin ? '🟢' : '🔴';

    const htmlParts = [];
    htmlParts.push('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' + pageTitle + '</title>');
    htmlParts.push('<style>*{margin:0;padding:0;box-sizing:border-box}body{background:linear-gradient(145deg,#0a0f1e 0%,#0d1528 100%);min-height:100vh;font-family:Inter,system-ui,sans-serif;color:#e0f2fe;padding:2rem 1rem;position:relative;overflow-x:hidden}body::before{content:"";position:fixed;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(rgba(6,182,212,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(6,182,212,0.03) 1px,transparent 1px);background-size:50px 50px;pointer-events:none;animation:gridPulse 8s infinite alternate;z-index:0}@keyframes gridPulse{0%{opacity:0.3}100%{opacity:0.7}}.orb{position:fixed;border-radius:50%;filter:blur(80px);opacity:0.4;z-index:-1}.orb-1{width:400px;height:400px;background:#06b6d4;top:-100px;right:-100px;animation:float 20s infinite alternate}.orb-2{width:300px;height:300px;background:#3b82f6;bottom:-50px;left:-50px;animation:float 15s infinite alternate-reverse}@keyframes float{0%{transform:translate(0,0) scale(1)}100%{transform:translate(50px,50px) scale(1.1)}}.snow{position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10}.snowflake{position:absolute;color:#a0e7ff;opacity:0.7;filter:drop-shadow(0 0 5px #06b6d4);animation:fall linear infinite}@keyframes fall{0%{transform:translateY(-10vh) rotate(0deg)}100%{transform:translateY(110vh) rotate(360deg)}}.container{max-width:1000px;margin:0 auto;position:relative;z-index:2}.header{text-align:center;margin-bottom:2rem;backdrop-filter:blur(10px);background:rgba(6,182,212,0.05);border:1px solid rgba(6,182,212,0.2);border-radius:40px;padding:2rem;box-shadow:0 20px 40px rgba(0,0,0,0.3),0 0 30px rgba(6,182,212,0.1);animation:slideDown 0.8s ease-out}@keyframes slideDown{0%{opacity:0;transform:translateY(-30px)}100%{opacity:1;transform:translateY(0)}}h1{font-size:2.8rem;font-weight:700;background:linear-gradient(135deg,#67e8f9 0%,#06b6d4 50%,#3b82f6 100%);-webkit-background-clip:text;background-clip:text;color:transparent;letter-spacing:-0.02em;margin-bottom:0.5rem;text-shadow:0 0 30px rgba(6,182,212,0.5)}.nav{display:flex;justify-content:center;gap:20px;margin-bottom:2rem;flex-wrap:wrap}.nav a{color:#e0f2fe;text-decoration:none;padding:8px 20px;border-radius:40px;background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.2);transition:all 0.3s}.nav a.active{background:#06b6d4;color:#0a0f1e;border-color:#06b6d4}.card{background:rgba(15,23,42,0.7);backdrop-filter:blur(10px);border:1px solid rgba(6,182,212,0.15);border-radius:24px;padding:2rem;margin-bottom:2rem;box-shadow:0 10px 20px rgba(0,0,0,0.2)}.stats{display:flex;gap:30px;justify-content:center;margin:1rem 0}.stat-item{text-align:center}.stat-number{font-size:2.5rem;font-weight:700;color:#67e8f9}.markdown-body{background:rgba(0,0,0,0.2);border-radius:16px;padding:1.5rem;color:#e0f2fe;max-height:70vh;overflow-y:auto}.code-block{background:#0a0f1e;border-radius:12px;padding:1.5rem;overflow-x:auto;max-height:60vh;overflow-y:auto;position:relative}.copy-btn{background:#06b6d4;color:#0a0f1e;border:none;padding:8px 16px;border-radius:8px;font-weight:600;cursor:pointer}.plugin-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}.plugin-card{background:rgba(0,0,0,0.2);border-radius:16px;padding:1.5rem}.social-section{display:flex;justify-content:center;gap:20px;margin:2rem 0;flex-wrap:wrap}.social-btn{display:flex;align-items:center;gap:8px;padding:10px 20px;border-radius:40px;text-decoration:none;color:#e0f2fe}.social-btn.wa{background:rgba(37,211,102,0.15);border:1px solid rgba(37,211,102,0.4)}.social-btn.yt{background:rgba(255,0,0,0.15);border:1px solid rgba(255,0,0,0.4)}.social-btn.tk{background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.2)}.footer{text-align:center;color:#64748b;margin-top:2rem}.admin-actions{display:flex;gap:10px;margin-top:10px}.btn-success{background:#10b981;color:white;border:none;padding:8px 16px;border-radius:8px}.btn-danger{background:#ef4444;color:white;border:none;padding:8px 16px;border-radius:8px}.btn-warning{background:#f59e0b;color:white;border:none;padding:8px 16px;border-radius:8px}.login-form input{width:100%;padding:12px;background:#0a0f1e;border:1px solid rgba(6,182,212,0.3);border-radius:8px;color:#e0f2fe}.modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:100}.modal-content{background:#0d1528;padding:2rem;border-radius:16px;max-width:500px;width:90%}.modal-content input,.modal-content textarea{width:100%;padding:12px;margin-bottom:1rem;background:#0a0f1e;border:1px solid rgba(6,182,212,0.3);border-radius:8px;color:#e0f2fe}</style>');
    htmlParts.push('<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css"></head><body><div class="orb orb-1"></div><div class="orb orb-2"></div><div class="snow" id="snow"></div><div class="container"><div class="header">');
    htmlParts.push('<h1>' + (pageTitle === 'CRYSNOVA LIVE' ? '❄️ CRYSNOVA LIVE' : (pageTitle === 'CRYSNOVA DEPLOY' ? '❄️ CRYSNOVA DEPLOY' : (pageTitle === 'CRYSNOVA PLUGINS' ? '🔌 PLUGIN MARKETPLACE' : (pageTitle === 'CRYSNOVA ADMIN' ? '🛠️ ADMIN PANEL' : '📤 SUBMIT PLUGIN')))) + '</h1>');
    htmlParts.push('<div class="subtitle">' + (pageTitle === 'CRYSNOVA LIVE' ? 'The AI Powerhouse Behind the Bot' : (pageTitle === 'CRYSNOVA DEPLOY' ? 'One‑Click Deployment Script' : (pageTitle === 'CRYSNOVA PLUGINS' ? 'Extend Your Bot with Plugins' : (pageTitle === 'CRYSNOVA ADMIN' ? 'Review & Manage Submissions' : 'Share Your Plugin with the Community')))) + '</div>');
    htmlParts.push('</div>');
    if (!allConfigured) htmlParts.push('<div class="config-warning">⚠️ Some services are not configured. Red dots indicate missing configuration.</div>');
    htmlParts.push('<div class="nav">');
    htmlParts.push('<a href="/" class="' + (path === '/' ? 'active' : '') + '">' + infoDot + ' Info</a>');
    htmlParts.push('<a href="/deploy" class="' + (path === '/deploy' ? 'active' : '') + '">' + deployDot + ' Deploy</a>');
    htmlParts.push('<a href="/plugins" class="' + (path === '/plugins' ? 'active' : '') + '">' + pluginsDot + ' Plugins</a>');
    htmlParts.push('<a href="/submit" class="' + (path === '/submit' ? 'active' : '') + '">' + submitDot + ' Submit</a>');
    htmlParts.push('<a href="/admin" class="' + (path === '/admin' ? 'active' : '') + '">' + adminDot + ' Admin</a>');
    htmlParts.push('</div>');

    // Page content
    if (path === '/') {
      htmlParts.push('<div class="card"><h2>📊 GitHub Stats</h2><div class="stats"><div class="stat-item"><div class="stat-number" id="stars">' + stats.stars + '</div><div>⭐ Stars</div></div><div class="stat-item"><div class="stat-number" id="forks">' + stats.forks + '</div><div>🍴 Forks</div></div></div><div style="text-align:center;margin-top:1rem"><a href="' + repoUrl + '" target="_blank" style="color:#67e8f9">View on GitHub →</a></div></div>');
      htmlParts.push('<div class="card"><h2>📖 README</h2><div id="readme-container" class="markdown-body">Loading...</div></div>');
      htmlParts.push('<div class="card"><h2>📧 Contact</h2><div style="display:flex;align-items:center;justify-content:center;gap:10px"><code style="background:#0a0f1e;padding:8px 16px;border-radius:8px">' + email + '</code><button class="copy-btn" onclick="copyText(\'' + email + '\')">📋 Copy</button></div></div>');
    } else if (path === '/deploy') {
      htmlParts.push('<div class="card"><h2>🚀 Deployment Instructions</h2><div class="instruction"><p><strong>Step 1:</strong> Create a new file in your Pterodactyl panel (or local bot folder).</p><p><strong>Step 2:</strong> Paste the script below and save it as <code>index.js</code>.</p><p><strong>Step 3:</strong> Run <code>node index.js</code> in your terminal/console.</p><p><strong>Step 4:</strong> Follow the interactive prompts – your configuration will be saved automatically.</p><p><strong>Step 5:</strong> Once complete, the bot will start automatically.</p></div><div style="position:relative"><button class="copy-btn copy-btn-top" onclick="copyCode()">📋 Copy Script</button><div class="code-block"><pre><code id="deploy-script">Loading deployment script...</code></pre></div></div></div>');
    } else if (path === '/plugins') {
      htmlParts.push('<div class="card"><h2>🔌 Available Plugins</h2><div id="plugin-list" class="plugin-grid">Loading plugins...</div></div>');
    } else if (path === '/submit') {
      htmlParts.push('<div class="card"><h2>📤 Submit a Plugin</h2><div id="submit-status"></div><div id="submit-form" style="display:none"><input type="text" id="plugin-name" placeholder="Plugin Name" style="width:100%;padding:12px;margin-bottom:1rem;background:#0a0f1e;border:1px solid rgba(6,182,212,0.3);border-radius:8px;color:#e0f2fe"><textarea id="plugin-desc" placeholder="Description" rows="3" style="width:100%;padding:12px;margin-bottom:1rem;background:#0a0f1e;border:1px solid rgba(6,182,212,0.3);border-radius:8px;color:#e0f2fe"></textarea><textarea id="plugin-code" placeholder="JavaScript Code" rows="10" style="width:100%;padding:12px;margin-bottom:1rem;background:#0a0f1e;border:1px solid rgba(6,182,212,0.3);border-radius:8px;color:#e0f2fe;font-family:monospace"></textarea><button onclick="submitPlugin()" style="background:#06b6d4;color:#0a0f1e;padding:12px 24px;border:none;border-radius:8px;font-weight:600">Submit for Review</button></div><div id="login-prompt"><button class="github-btn" onclick="loginWithGitHub()">🔐 Login with GitHub to Submit</button></div></div>');
    } else if (path === '/admin') {
      htmlParts.push('<div class="card"><h2>🛠️ Admin Login</h2><div id="admin-login" class="login-form"><input type="password" id="admin-password" placeholder="Admin Password"><button onclick="adminLogin()">Login</button><p id="login-error" style="color:#ef4444"></p></div><div id="admin-panel" style="display:none"><h3>⏳ Pending Submissions</h3><div id="submissions-list">Loading...</div><hr style="border-color:rgba(6,182,212,0.2);margin:2rem 0"><h3>📦 Approved Plugins (Manage)</h3><div id="approved-plugins-list">Loading...</div></div></div>');
      htmlParts.push('<div id="editModal" class="modal" style="display:none"><div class="modal-content"><h3>✏️ Edit Plugin</h3><input type="hidden" id="edit-plugin-id"><label>Name</label><input type="text" id="edit-plugin-name"><label>Description</label><textarea id="edit-plugin-desc" rows="2"></textarea><label>JavaScript Code</label><textarea id="edit-plugin-code" rows="8" style="font-family:monospace"></textarea><label>Custom URL (optional, overrides CDN)</label><input type="text" id="edit-plugin-url" placeholder="https://..."><div style="display:flex;gap:10px;justify-content:flex-end;margin-top:1rem"><button class="btn-danger" onclick="closeEditModal()">Cancel</button><button class="btn-success" onclick="savePluginEdit()">Save</button></div></div></div>');
    } else {
      htmlParts.push('<div class="card" style="text-align:center"><h2>❄️ 404 – Page Not Found</h2><p style="margin:2rem 0">The snowflake you\'re looking for has melted away.</p><a href="/" style="color:#67e8f9">🏠 Return Home</a></div>');
    }

    // Footer and Scripts
    htmlParts.push('<div class="social-section"><a href="' + channelUrl + '" target="_blank" class="social-btn wa">📱 WhatsApp</a><a href="' + groupUrl + '" target="_blank" class="social-btn wa">👥 Group</a><a href="' + youtubeUrl + '" target="_blank" class="social-btn yt">▶️ YouTube</a><a href="' + tiktokUrl + '" target="_blank" class="social-btn tk">🎵 TikTok</a></div>');
    htmlParts.push('<div class="footer"><span class="glow-text">CRYSNOVA AI</span> • Live Documentation<br><span style="font-size:0.75rem">❄️ Real‑time updates from GitHub</span></div></div>');
    htmlParts.push('<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>');
    htmlParts.push('<script>');
    htmlParts.push('const GITHUB_CLIENT_ID = "' + (env.GITHUB_CLIENT_ID || '') + '";');
    htmlParts.push('let adminToken = sessionStorage.getItem("admin_token");');
    htmlParts.push('let githubAccessToken = sessionStorage.getItem("github_token");');
    htmlParts.push('function createSnow(){const s=document.getElementById("snow");for(let i=0;i<60;i++){const f=document.createElement("div");f.className="snowflake";f.innerHTML=["❄️","❅","❆","✨","✧"][Math.floor(Math.random()*5)];f.style.left=Math.random()*100+"%";f.style.fontSize=(10+Math.random()*20)+"px";f.style.animationDuration=(5+Math.random()*10)+"s";f.style.animationDelay=Math.random()*-10+"s";f.style.opacity=0.3+Math.random()*0.5;s.appendChild(f)}}createSnow();');
    htmlParts.push('function copyText(t){navigator.clipboard.writeText(t);alert("Copied!")}');
    htmlParts.push('let deployScriptContent="";');
    htmlParts.push('async function loadReadme(){const c=document.getElementById("readme-container");if(!c)return;try{const r=await fetch("/api/readme");c.innerHTML=await r.text();hljs.highlightAll()}catch(e){c.innerHTML="<p>Failed to load README.</p>"}}');
    htmlParts.push('async function loadDeployScript(){const c=document.getElementById("deploy-script");if(!c)return;try{const r=await fetch("/api/deploy-script");deployScriptContent=await r.text();c.textContent=deployScriptContent;hljs.highlightAll()}catch(e){c.textContent="// Failed to load deployment script."}}');
    htmlParts.push('async function refreshStats(){try{const r=await fetch("/api/stats");const d=await r.json();document.getElementById("stars").innerText=d.stars;document.getElementById("forks").innerText=d.forks}catch(e){}}');
    htmlParts.push('function copyCode(){if(deployScriptContent){navigator.clipboard.writeText(deployScriptContent);alert("Copied!")}}');
    htmlParts.push('async function loadPlugins(){const c=document.getElementById("plugin-list");if(!c)return;try{const r=await fetch("/api/plugins");const p=await r.json();if(!p.length){c.innerHTML="<p>No plugins yet.</p>";return;}let h="";p.forEach(function(p){const url=p.customUrl||p.url;const cmd=".plugin "+url;h+="<div class=\\"plugin-card\\"><h3>"+p.name+"</h3><p>"+p.description+"</p><p><code>"+cmd+"</code></p><button onclick=\\"copyText(\'"+cmd+"\')\\">📋 Copy</button></div>";});c.innerHTML=h;}catch(e){c.innerHTML="<p>Failed to load.</p>";}}');
    htmlParts.push('function loginWithGitHub(){const w=600,h=600,l=(screen.width-w)/2,t=(screen.height-h)/2;window.open("https://github.com/login/oauth/authorize?client_id="+GITHUB_CLIENT_ID+"&redirect_uri="+encodeURIComponent("https://panel.crysnovax.link/auth/github/callback")+"&scope=read:user","GitHub","width="+w+",height="+h+",left="+l+",top="+t);}');
    htmlParts.push('window.addEventListener("message",function(e){if(e.data.type==="github-oauth"&&e.data.accessToken){githubAccessToken=e.data.accessToken;sessionStorage.setItem("github_token",githubAccessToken);document.getElementById("login-prompt").style.display="none";document.getElementById("submit-form").style.display="block";}});');
    htmlParts.push('async function submitPlugin(){const n=document.getElementById("plugin-name").value.trim(),d=document.getElementById("plugin-desc").value.trim(),c=document.getElementById("plugin-code").value.trim();if(!n||!d||!c){alert("All fields required");return;}const s=document.getElementById("submit-status");s.innerHTML="<p>Submitting...</p>";try{const r=await fetch("/api/submit-plugin",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accessToken:githubAccessToken,name:n,description:d,code:c})});const data=await r.json();s.innerHTML=data.success?"<p style=\\"color:#10b981\\">✓ Submitted!</p>":"<p style=\\"color:#ef4444\\">✘ Failed</p>";}catch(e){s.innerHTML="<p style=\\"color:#ef4444\\">Error</p>";}}');
    htmlParts.push('function adminLogin(){adminToken=document.getElementById("admin-password").value;sessionStorage.setItem("admin_token",adminToken);loadAdminPanel();}');
    htmlParts.push('async function loadAdminPanel(){if(!adminToken)return;try{const r=await fetch("/api/admin/submissions",{headers:{"Authorization":"Bearer "+adminToken}});if(!r.ok){document.getElementById("login-error").innerText="Invalid password";return;}document.getElementById("admin-login").style.display="none";document.getElementById("admin-panel").style.display="block";loadSubmissions();loadApprovedPlugins();}catch(e){}}');
    htmlParts.push('function escapeHtml(text){return text.replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}');
    htmlParts.push('async function loadSubmissions(){const l=document.getElementById("submissions-list");if(!l)return;l.innerHTML="<p>Loading...</p>";try{const r=await fetch("/api/admin/submissions",{headers:{"Authorization":"Bearer "+adminToken}});if(!r.ok){l.innerHTML="<p style=\\"color:#ef4444\\">Error: HTTP "+r.status+" - "+r.statusText+"</p>";return;}const s=await r.json();if(!s.length){l.innerHTML="<p>No pending submissions.</p>";return;}let h="";s.forEach(function(s){const cmd=".plugin (pending approval)";h+="<div class=\\"admin-submission\\"><h4>"+escapeHtml(s.name)+" by "+escapeHtml(s.author)+"</h4><p>"+escapeHtml(s.description)+"</p><p><code>"+cmd+"</code></p><details><summary>View Code</summary><pre style=\\"background:#0a0f1e;padding:1rem;border-radius:8px;overflow-x:auto;margin-top:10px\\">"+escapeHtml(s.code)+"</pre></details><div class=\\"admin-actions\\"><button class=\\"btn-success\\" onclick=\\"approvePlugin(\'"+s.id+"\')\\">✓ Accept</button><button class=\\"btn-danger\\" onclick=\\"rejectPlugin(\'"+s.id+"\')\\">✗ Reject</button></div></div>";});l.innerHTML=h;}catch(e){l.innerHTML="<p style=\\"color:#ef4444\\">Failed to load submissions: "+e.message+"</p>";}}');
    htmlParts.push('async function loadApprovedPlugins(){const c=document.getElementById("approved-plugins-list");if(!c)return;c.innerHTML="<p>Loading...</p>";try{const r=await fetch("/api/admin/plugins",{headers:{"Authorization":"Bearer "+adminToken}});if(!r.ok){c.innerHTML="<p style=\\"color:#ef4444\\">Error: HTTP "+r.status+"</p>";return;}const p=await r.json();if(!p.length){c.innerHTML="<p>No approved plugins yet.</p>";return;}let h="";p.forEach(function(p){const url=p.customUrl||p.url;const cmd=".plugin "+url;h+="<div class=\\"admin-submission\\"><h4>"+escapeHtml(p.name)+" by "+escapeHtml(p.author)+"</h4><p>"+escapeHtml(p.description)+"</p><p><code>"+cmd+"</code> <button class=\\"copy-btn\\" onclick=\\"copyText(\'"+cmd+"\')\\">📋</button></p><div class=\\"admin-actions\\"><button class=\\"btn-warning\\" onclick=\\"editPlugin(\'"+p.id+"\',\'"+escapeHtml(p.name)+"\',\'"+escapeHtml(p.description)+"\',\'"+escapeHtml(p.code)+"\',\'"+escapeHtml(p.customUrl||"")+"\')\\">✏️ Edit</button><button class=\\"btn-danger\\" onclick=\\"deletePlugin(\'"+p.id+"\')\\">🗑️ Delete</button></div></div>";});c.innerHTML=h;}catch(e){c.innerHTML="<p style=\\"color:#ef4444\\">Failed to load: "+e.message+"</p>";}}');
    htmlParts.push('async function approvePlugin(id){try{await fetch("/api/admin/approve",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+adminToken},body:JSON.stringify({id:id})});alert("Approved!");loadSubmissions();loadApprovedPlugins();loadPlugins();}catch(e){}}');
    htmlParts.push('async function rejectPlugin(id){if(!confirm("Reject?"))return;try{await fetch("/api/admin/submissions",{method:"DELETE",headers:{"Content-Type":"application/json","Authorization":"Bearer "+adminToken},body:JSON.stringify({id:id})});alert("Rejected");loadSubmissions();}catch(e){}}');
    htmlParts.push('function editPlugin(id,name,desc,code,customUrl){document.getElementById("edit-plugin-id").value=id;document.getElementById("edit-plugin-name").value=name;document.getElementById("edit-plugin-desc").value=desc;document.getElementById("edit-plugin-code").value=code;document.getElementById("edit-plugin-url").value=customUrl;document.getElementById("editModal").style.display="flex";}');
    htmlParts.push('function closeEditModal(){document.getElementById("editModal").style.display="none";}');
    htmlParts.push('async function savePluginEdit(){const id=document.getElementById("edit-plugin-id").value;const name=document.getElementById("edit-plugin-name").value.trim();const desc=document.getElementById("edit-plugin-desc").value.trim();const code=document.getElementById("edit-plugin-code").value.trim();const customUrl=document.getElementById("edit-plugin-url").value.trim();if(!name||!desc||!code){alert("Name, description, and code are required.");return;}try{const r=await fetch("/api/admin/plugins",{method:"PUT",headers:{"Content-Type":"application/json","Authorization":"Bearer "+adminToken},body:JSON.stringify({id:id,name:name,description:desc,code:code,customUrl:customUrl})});const data=await r.json();if(data.success){alert("Plugin updated!");closeEditModal();loadApprovedPlugins();loadPlugins();}else{alert("Update failed: "+data.error);}}catch(e){alert("Error: "+e.message);}}');
    htmlParts.push('async function deletePlugin(id){if(!confirm("Delete permanently?"))return;try{const r=await fetch("/api/admin/plugins",{method:"DELETE",headers:{"Content-Type":"application/json","Authorization":"Bearer "+adminToken},body:JSON.stringify({id:id})});const data=await r.json();if(data.success){alert("Deleted!");loadApprovedPlugins();loadPlugins();}else{alert("Delete failed: "+data.error);}}catch(e){alert("Error: "+e.message);}}');
    htmlParts.push('if(location.pathname==="/"){loadReadme();refreshStats();setInterval(refreshStats,300000);}else if(location.pathname==="/deploy"){loadDeployScript();}else if(location.pathname==="/plugins"){loadPlugins();}else if(location.pathname==="/submit"){if(githubAccessToken){document.getElementById("login-prompt").style.display="none";document.getElementById("submit-form").style.display="block";}}else if(location.pathname==="/admin"){if(adminToken)loadAdminPanel();}');
    htmlParts.push('</script></body></html>');

    return new Response(htmlParts.join(''), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  },
};

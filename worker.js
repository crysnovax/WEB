// worker.js – CRYSNOVA LIVE Final Production Build
// Features: Plugin Marketplace, Admin Panel, Search, Ratings, Download Count,
// Plugin Details Page, Email Notifications, API Docs, Categories
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

    async function sendNotification(subject, body) {
      if (!env.RESEND_API_KEY) return;
      try {
        const { results } = await env.DB.prepare('SELECT email FROM subscribers').all();
        const emails = results.map(r => r.email);
        if (emails.length === 0) return;
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'CRYSNOVA LIVE <notify@panel.crysnovax.link>', to: emails, subject, html: body })
        });
      } catch (e) { console.error('Email failed:', e); }
    }

    // -------------------- PUBLIC API --------------------
    if (path === '/api/config-status') {
      return new Response(JSON.stringify(configStatus), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (path === '/api/stats') {
      const stats = await getGitHubStats();
      return new Response(JSON.stringify(stats), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (path === '/api/readme') {
      if (!env.README_URL) return new Response('README_URL not configured', { status: 500 });
      try { return new Response(await renderMarkdown(env.README_URL), { headers: { ...corsHeaders, 'Content-Type': 'text/html' } }); }
      catch { return new Response('Error fetching README', { status: 500 }); }
    }
    if (path === '/api/deploy-script') {
      if (!env.DEPLOY_README_URL) return new Response('DEPLOY_README_URL not configured', { status: 500 });
      try { return new Response(await fetchRawText(env.DEPLOY_README_URL), { headers: { ...corsHeaders, 'Content-Type': 'text/plain' } }); }
      catch { return new Response('Error fetching deployment script', { status: 500 }); }
    }
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
        const avg = cnt > 0 ? (sum / cnt).toFixed(1) : '0.0';
        return new Response(JSON.stringify({ success: true, average: avg, count: cnt }), { headers: corsHeaders });
      } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
    }

    // -------------------- SUBMIT PLUGIN --------------------
    if (path === '/api/submit-plugin' && method === 'POST') {
      const { accessToken, name, description, code, category } = await request.json();
      if (!accessToken || !name || !description || !code) {
        return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400, headers: corsHeaders });
      }
      try {
        const user = await getGitHubUser(accessToken);
        const submissionId = crypto.randomUUID();
        const submission = {
          id: submissionId, name, description, code, category: category || 'utility',
          author: user.login, authorName: user.name || user.login, authorAvatar: user.avatar_url,
          submittedAt: Date.now(), status: 'pending'
        };
        await env.SUBMISSION_STORE.put(submissionId, JSON.stringify(submission));
        await sendNotification('New Plugin: ' + name, '<p><strong>' + name + '</strong> by ' + user.login + '</p><p>' + description + '</p><p><a href="https://web.crysnovax.link/admin">Review in Admin Panel</a></p>');
        return new Response(JSON.stringify({ success: true, id: submissionId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // -------------------- ADMIN API --------------------
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
        let rawUrl, cdnUrl;
        try {
          const formData = new FormData();
          formData.append('file', new Blob([submission.code], { type: 'text/plain' }), 'paste.txt');
          const uploadRes = await fetch(env.CDN_URL + '/upload', { method: 'POST', body: formData });
          const uploadData = await uploadRes.json();
          if (uploadData.url) {
            cdnUrl = uploadData.url;
            rawUrl = cdnUrl.replace(/\/(upload|file)\//, '/files/').replace(/\.html?$/, '.txt');
          }
        } catch (err) {
          cdnUrl = 'https://cdn.crysnovax.link/' + filename;
          rawUrl = cdnUrl;
        }
        const pluginsJson = await env.PLUGIN_STORE.get('plugins');
        const plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
        plugins.push({
          id: crypto.randomUUID(), name: submission.name, description: submission.description,
          author: submission.author, authorName: submission.authorName, code: submission.code,
          category: submission.category || 'utility', filename: filename, url: rawUrl,
          customUrl: '', verified: true, approvedAt: Date.now()
        });
        await env.PLUGIN_STORE.put('plugins', JSON.stringify(plugins));
        await env.SUBMISSION_STORE.delete(id);
        return new Response(JSON.stringify({ success: true, url: rawUrl }), { headers: corsHeaders });
      }

      if (path === '/api/admin/plugins' && method === 'GET') {
        const pluginsJson = await env.PLUGIN_STORE.get('plugins');
        const plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
        return new Response(JSON.stringify(plugins), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (path === '/api/admin/plugins' && method === 'PUT') {
        const { id, name, description, code, customUrl, category } = await request.json();
        if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400 });
        const pluginsJson = await env.PLUGIN_STORE.get('plugins');
        let plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
        const index = plugins.findIndex(p => p.id === id);
        if (index === -1) return new Response(JSON.stringify({ error: 'Plugin not found' }), { status: 404 });
        if (name !== undefined) plugins[index].name = name;
        if (description !== undefined) plugins[index].description = description;
        if (customUrl !== undefined) plugins[index].customUrl = customUrl;
        if (category !== undefined) plugins[index].category = category;
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

    // -------------------- OAUTH CALLBACK --------------------
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

    // -------------------- RAW FILE SERVING --------------------
    if (path.startsWith('/raw/')) {
      const filePath = path.slice(5);
      const content = await env.PLUGIN_FILES.get(filePath);
      if (!content) return new Response('File not found', { status: 404 });
      return new Response(content, { 
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' } 
      });
    }

    // -------------------- PLUGIN DETAIL PAGE --------------------
    if (path.startsWith('/plugin/')) {
      const pluginId = path.slice(8);
      const pluginsJson = await env.PLUGIN_STORE.get('plugins');
      const plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
      const plugin = plugins.find(p => p.id === pluginId);
      if (!plugin) return new Response('Plugin not found', { status: 404 });
      const downloads = await env.STATS_STORE.get('downloads:' + pluginId) || '0';
      const list = await env.RATINGS_STORE.list({ prefix: 'rating:' + pluginId + ':' });
      let sum = 0, cnt = 0;
      for (const k of list.keys) { const v = await env.RATINGS_STORE.get(k.name); if (v) { sum += parseInt(v); cnt++; } }
      const avgRating = cnt > 0 ? (sum / cnt).toFixed(1) : '0.0';
      const html = pluginDetailPage(plugin, downloads, avgRating, cnt);
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    }

    // -------------------- FRONTEND PAGES --------------------
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
    if (isDeploy) pageTitle = 'CRYSNⓘVA DEPLOY';
    else if (isPlugins) pageTitle = 'CRYSN⎔VA PLUGINS';
    else if (isAdminPanel) pageTitle = 'CRYS❂NVA ADMIN';
    else if (isSubmit) pageTitle = 'CRYSN☉VA SUBMIT ✐';

    const infoDot = configStatus.readme ? '🟢' : '🔴';
    const deployDot = configStatus.deploy ? '🟢' : '🔴';
    const pluginsDot = (configStatus.pluginStore && configStatus.pluginFiles) ? '🟢' : '🔴';
    const submitDot = configStatus.github ? '🟢' : '🔴';
    const adminDot = configStatus.admin ? '🟢' : '🔴';

    return new Response(buildHTML(env, path, stats, configStatus, allConfigured, pageTitle, infoDot, deployDot, pluginsDot, submitDot, adminDot, channelUrl, groupUrl, youtubeUrl, tiktokUrl, email, repoUrl), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  },
};

function pluginDetailPage(plugin, downloads, avgRating, cnt) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${plugin.name} - CRYSNOVA</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"><style>${pluginStyles()}</style></head><body><div class="bg-grid"></div><div class="orb orb-1"></div><div class="orb orb-2"></div><div class="container"><a href="/plugins" class="back-link">← Back to Plugins</a><div class="card"><h1>${plugin.name}</h1><p style="color:var(--text2);margin:1rem 0">${plugin.description}</p><div class="stats"><div class="stat"><span class="stat-value">${avgRating}</span><span class="stat-label">⭐ Rating (${cnt})</span></div><div class="stat"><span class="stat-value">${downloads}</span><span class="stat-label">⬇️ Downloads</span></div><div class="stat"><span class="stat-value">${plugin.authorName || plugin.author}</span><span class="stat-label">👤 Author</span></div></div><div class="code-box"><code>.plugin ${plugin.customUrl || plugin.url}</code><button class="btn" onclick="copyText('.plugin ${plugin.customUrl || plugin.url}')">📋 Copy</button></div></div><div class="card"><h2>📜 Source Code</h2><pre><code>${escapeHtml(plugin.code)}</code></pre></div></div><script>function copyText(t){navigator.clipboard.writeText(t);alert('Copied!')}</script></body></html>`;
}

function escapeHtml(text) { return text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }

function pluginStyles() {
  return `
    :root{--bg:#06080d;--surface:#0d1117;--surface2:#161b22;--border:#21262d;--primary:#58a6ff;--accent:#79c0ff;--text:#e6edf3;--text2:#8b949e;--text3:#484f58;--radius:12px}
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;min-height:100vh;overflow-x:hidden}
    .bg-grid{position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;opacity:0.02;background-image:linear-gradient(rgba(88,166,255,0.3) 1px,transparent 1px),linear-gradient(90deg,rgba(88,166,255,0.3) 1px,transparent 1px);background-size:80px 80px}
    .orb{position:fixed;border-radius:50%;filter:blur(100px);opacity:0.08;z-index:0;pointer-events:none}
    .orb-1{width:500px;height:500px;background:#58a6ff;top:-150px;right:-100px}
    .orb-2{width:350px;height:350px;background:#79c0ff;bottom:-100px;left:-80px}
    .container{max-width:900px;margin:0 auto;padding:2rem;position:relative;z-index:1}
    .back-link{color:var(--text2);text-decoration:none;font-size:0.9rem;display:inline-block;margin-bottom:1.5rem}
    .back-link:hover{color:var(--primary)}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:2rem;margin-bottom:1.5rem}
    h1{font-size:2rem;font-weight:700;color:var(--primary)}
    h2{font-size:1.2rem;font-weight:600;margin-bottom:1rem}
    .stats{display:flex;gap:2rem;margin:1.5rem 0;flex-wrap:wrap}
    .stat{display:flex;flex-direction:column;align-items:center}
    .stat-value{font-size:1.5rem;font-weight:700;color:var(--accent)}
    .stat-label{font-size:0.8rem;color:var(--text2);margin-top:0.2rem}
    .code-box{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:1rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
    .code-box code{font-family:'JetBrains Mono',monospace;font-size:0.85rem;color:var(--accent)}
    .btn{background:var(--primary);color:#fff;border:none;padding:0.6rem 1.2rem;border-radius:6px;cursor:pointer;font-weight:600;font-size:0.85rem;transition:all 0.2s}
    .btn:hover{opacity:0.85}
    pre{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:1.5rem;overflow:auto;max-height:500px}
    pre code{font-family:'JetBrains Mono',monospace;font-size:0.85rem;line-height:1.6;color:var(--text2)}
    @media(max-width:768px){.container{padding:1rem}.stats{gap:1rem}}
  `;
}

function buildHTML(env, path, stats, configStatus, allConfigured, pageTitle, infoDot, deployDot, pluginsDot, submitDot, adminDot, channelUrl, groupUrl, youtubeUrl, tiktokUrl, email, repoUrl) {
  const isHome = path === '/' || path === '';
  const isDeploy = path === '/deploy';
  const isPlugins = path === '/plugins';
  const isAdminPanel = path === '/admin';
  const isSubmit = path === '/submit';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${pageTitle}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--bg:#06080d;--surface:#0d1117;--surface2:#161b22;--border:#21262d;--primary:#58a6ff;--accent:#79c0ff;--text:#e6edf3;--text2:#8b949e;--text3:#484f58;--green:#3fb950;--red:#f85149;--yellow:#d2991d;--radius:12px;--radius-sm:8px}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;min-height:100vh;overflow-x:hidden}
  .bg-grid{position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;opacity:0.025;background-image:linear-gradient(rgba(88,166,255,0.25) 1px,transparent 1px),linear-gradient(90deg,rgba(88,166,255,0.25) 1px,transparent 1px);background-size:80px 80px;animation:gridShift 30s linear infinite}
  @keyframes gridShift{0%{transform:translate(0,0)}100%{transform:translate(80px,80px)}}
  .orb{position:fixed;border-radius:50%;filter:blur(120px);opacity:0.06;z-index:0;pointer-events:none}
  .orb-1{width:600px;height:600px;background:var(--primary);top:-200px;right:-150px;animation:orbFloat 20s ease-in-out infinite}
  .orb-2{width:400px;height:400px;background:var(--accent);bottom:-150px;left:-100px;animation:orbFloat 25s ease-in-out infinite reverse}
  @keyframes orbFloat{0%,100%{transform:translate(0,0)scale(1)}33%{transform:translate(50px,-40px)scale(1.08)}66%{transform:translate(-30px,50px)scale(0.94)}}
  .container{max-width:1000px;margin:0 auto;padding:2rem;position:relative;z-index:1}
  .header{text-align:center;margin-bottom:2rem}
  .header h1{font-size:2.4rem;font-weight:800;background:linear-gradient(135deg,var(--primary),var(--accent));-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-0.02em;margin-bottom:0.5rem}
  .header p{color:var(--text2);font-size:1rem}
  .nav{display:flex;justify-content:center;gap:6px;margin-bottom:2rem;flex-wrap:wrap;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:5px}
  .nav a{color:var(--text2);text-decoration:none;padding:0.6rem 1.2rem;border-radius:var(--radius-sm);font-size:0.85rem;font-weight:500;transition:all 0.25s}
  .nav a:hover{background:var(--surface2);color:var(--text)}
  .nav a.active{background:var(--primary);color:#fff}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.8rem;margin-bottom:1.5rem}
  .card h2{font-size:1.15rem;font-weight:600;margin-bottom:1rem;color:var(--accent)}
  .stats-row{display:flex;gap:2rem;justify-content:center;flex-wrap:wrap;margin:1rem 0}
  .stat-item{text-align:center}
  .stat-num{font-size:2.2rem;font-weight:700;color:var(--primary)}
  .stat-label{font-size:0.8rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-top:0.2rem}
  .code-block{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:1.2rem;font-family:'JetBrains Mono',monospace;font-size:0.85rem;overflow-x:auto;line-height:1.6;max-height:60vh;overflow-y:auto}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:0.55rem 1.2rem;border-radius:var(--radius-sm);font-size:0.85rem;font-weight:600;cursor:pointer;border:none;transition:all 0.2s;font-family:'Inter',sans-serif;text-decoration:none}
  .btn-primary{background:var(--primary);color:#fff}.btn-primary:hover{opacity:0.85}
  .btn-success{background:var(--green);color:#fff}.btn-danger{background:var(--red);color:#fff}.btn-warning{background:var(--yellow);color:#000}
  .plugin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
  .plugin-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.3rem;transition:all 0.25s}
  .plugin-card:hover{border-color:var(--primary)}
  .plugin-card h3{font-size:1rem;margin-bottom:0.5rem}
  .plugin-card p{color:var(--text2);font-size:0.85rem;margin-bottom:0.5rem}
  .plugin-card code{display:block;background:var(--surface2);padding:0.4rem 0.7rem;border-radius:4px;font-size:0.8rem;margin:0.5rem 0;word-break:break-all}
  input,textarea,select{width:100%;padding:0.7rem 0.9rem;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-family:'Inter',sans-serif;font-size:0.9rem;outline:none;margin-bottom:0.8rem;transition:border-color 0.2s}
  input:focus,textarea:focus,select:focus{border-color:var(--primary)}
  .social-row{display:flex;justify-content:center;gap:14px;flex-wrap:wrap;margin:2rem 0}
  .social-link{display:flex;align-items:center;gap:6px;padding:0.5rem 1.2rem;border-radius:50px;text-decoration:none;font-weight:500;font-size:0.85rem;transition:all 0.25s;color:var(--text2);border:1px solid var(--border)}
  .social-link:hover{border-color:var(--primary);color:var(--text)}
  .social-link.wa{border-color:rgba(63,185,80,0.4)}.social-link.yt{border-color:rgba(248,81,73,0.4)}.social-link.gh{border-color:rgba(255,255,255,0.15)}
  .footer{text-align:center;color:var(--text3);margin-top:3rem;padding-top:2rem;border-top:1px solid var(--border);font-size:0.85rem}
  .footer span{color:var(--primary);font-weight:600}
  .modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:100}
  .modal-box{background:var(--surface);padding:2rem;border-radius:var(--radius);max-width:500px;width:90%;border:1px solid var(--border)}
  .modal-box label{display:block;font-size:0.85rem;color:var(--text2);margin-bottom:0.3rem}
  .warning-banner{background:rgba(248,81,73,0.08);border:1px solid rgba(248,81,73,0.3);border-radius:var(--radius-sm);padding:0.8rem 1.2rem;margin-bottom:1.5rem;text-align:center;color:var(--red);font-size:0.9rem}
  @media(max-width:768px){.container{padding:1rem}.header h1{font-size:1.8rem}.nav a{font-size:0.8rem;padding:0.5rem 0.8rem}}
</style></head><body><div class="bg-grid"></div><div class="orb orb-1"></div><div class="orb orb-2"></div><div class="container">
<div class="header"><h1>${pageTitle}</h1><p>The AI Powerhouse Behind the Bot</p></div>
${!allConfigured ? '<div class="warning-banner">⚠️ Some services not configured. Red dots = missing.</div>' : ''}
<div class="nav">
  <a href="/" class="${isHome?'active':''}">${infoDot} Info</a>
  <a href="/deploy" class="${isDeploy?'active':''}">${deployDot} Deploy</a>
  <a href="/plugins" class="${isPlugins?'active':''}">${pluginsDot} Plugins</a>
  <a href="/submit" class="${isSubmit?'active':''}">${submitDot} Submit</a>
  <a href="/admin" class="${isAdminPanel?'active':''}">${adminDot} Admin</a>
  <a href="/docs">📚 Docs</a>
</div>
${isHome ? `
<div class="card"><h2>📊 GitHub Stats</h2><div class="stats-row"><div class="stat-item"><div class="stat-num" id="stars">${stats.stars}</div><div class="stat-label">⭐ Stars</div></div><div class="stat-item"><div class="stat-num" id="forks">${stats.forks}</div><div class="stat-label">🍴 Forks</div></div></div><div style="text-align:center;margin-top:1rem"><a href="${repoUrl}" target="_blank" style="color:var(--primary)">View on GitHub →</a></div></div>
<div class="card"><h2>📖 README</h2><div id="readme-container" style="max-height:70vh;overflow-y:auto">Loading...</div></div>
<div class="card"><h2>📬 Subscribe</h2><input type="email" id="subscribe-email" placeholder="Your email"><button class="btn btn-primary" onclick="subscribeEmail()">Subscribe</button><p id="subscribe-status" style="margin-top:0.5rem;font-size:0.85rem"></p></div>
<div class="card"><h2>📧 Contact</h2><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><code style="background:var(--surface2);padding:0.5rem 1rem;border-radius:var(--radius-sm)">${email}</code><button class="btn btn-primary" onclick="copyText('${email}')">📋 Copy</button></div></div>
` : isDeploy ? `
<div class="card"><h2>🚀 Deployment</h2><p style="color:var(--text2);margin-bottom:1rem">Copy the script below and run it in your terminal.</p><button class="btn btn-primary" onclick="copyCode()" style="margin-bottom:1rem">📋 Copy Script</button><div class="code-block"><pre><code id="deploy-script">Loading...</code></pre></div></div>
` : isPlugins ? `
<div class="card"><h2>🔌 Plugin Marketplace</h2><input type="text" id="plugin-search" placeholder="🔍 Search plugins..."><select id="category-filter"><option value="">All Categories</option><option value="fun">🎮 Fun</option><option value="utility">🔧 Utility</option><option value="ai">🤖 AI</option><option value="admin">🛡️ Admin</option><option value="downloader">📥 Downloader</option></select><div id="plugin-list" class="plugin-grid">Loading...</div></div>
` : isSubmit ? `
<div class="card"><h2>📤 Submit Plugin</h2><div id="submit-status"></div><div id="login-prompt"><button class="btn btn-primary" onclick="loginWithGitHub()">🔐 Login with GitHub to Submit</button></div><div id="submit-form" style="display:none"><input type="text" id="plugin-name" placeholder="Plugin Name"><textarea id="plugin-desc" placeholder="Description" rows="3"></textarea><textarea id="plugin-code" placeholder="JavaScript Code" rows="10" style="font-family:monospace"></textarea><select id="plugin-category"><option value="">Category</option><option value="fun">🎮 Fun</option><option value="utility">🔧 Utility</option><option value="ai">🤖 AI</option><option value="admin">🛡️ Admin</option><option value="downloader">📥 Downloader</option></select><button class="btn btn-primary" onclick="submitPlugin()">Submit for Review</button></div></div>
` : isAdminPanel ? `
<div class="card"><h2>🛡️ Admin</h2><div id="admin-login"><input type="password" id="admin-password" placeholder="Admin Password"><button class="btn btn-primary" onclick="adminLogin()">Login</button><p id="login-error" style="color:var(--red);margin-top:0.5rem"></p></div><div id="admin-panel" style="display:none"><h3>⏳ Pending</h3><div id="submissions-list">Loading...</div><hr style="border-color:var(--border);margin:2rem 0"><h3>📦 Approved</h3><div id="approved-plugins-list">Loading...</div></div></div>
<div id="editModal" class="modal" style="display:none"><div class="modal-box"><h3>✏️ Edit Plugin</h3><input type="hidden" id="edit-plugin-id"><label>Name</label><input type="text" id="edit-plugin-name"><label>Description</label><textarea id="edit-plugin-desc" rows="2"></textarea><label>Code</label><textarea id="edit-plugin-code" rows="8" style="font-family:monospace"></textarea><label>Custom URL</label><input type="text" id="edit-plugin-url"><label>Category</label><select id="edit-plugin-category"><option value="fun">🎮 Fun</option><option value="utility">🔧 Utility</option><option value="ai">🤖 AI</option><option value="admin">🛡️ Admin</option><option value="downloader">📥 Downloader</option></select><div style="display:flex;gap:10px;justify-content:flex-end;margin-top:1.2rem"><button class="btn btn-danger" onclick="closeEditModal()">Cancel</button><button class="btn btn-success" onclick="savePluginEdit()">Save</button></div></div></div>
` : path === '/docs' ? `
<div class="card"><h2>📚 API Docs</h2><p style="color:var(--text2);margin-bottom:1rem">Public Endpoints</p><div class="code-block"><code>GET /api/plugins</code> - List plugins<br><code>GET /api/stats</code> - GitHub stats<br><code>POST /api/subscribe</code> - Subscribe<br><code>POST /api/ratings</code> - Rate</div><p style="color:var(--text2);margin:1rem 0">Admin Endpoints (Bearer token)</p><div class="code-block"><code>GET /api/admin/submissions</code><br><code>POST /api/admin/approve</code><br><code>PUT /api/admin/plugins</code><br><code>DELETE /api/admin/plugins</code></div></div>
` : `<div class="card" style="text-align:center"><h2>404</h2><p style="margin:1.5rem 0;color:var(--text2)">Page not found.</p><a href="/" style="color:var(--primary)">🏠 Home</a></div>`}
<div class="social-row">
  <a href="${channelUrl}" target="_blank" class="social-link wa">📱 Channel</a>
  <a href="${groupUrl}" target="_blank" class="social-link wa">👥 Group</a>
  <a href="${youtubeUrl}" target="_blank" class="social-link yt">▶️ YouTube</a>
  <a href="${tiktokUrl}" target="_blank" class="social-link">🎵 TikTok</a>
  <a href="https://github.com/crysnovax" target="_blank" class="social-link gh">💻 GitHub</a>
</div>
<div class="footer"><span>CRYSNOVA AI</span> • Live Documentation<br><span style="font-size:0.75rem;color:var(--text3)">Real-time from GitHub</span></div>
</div>
<script>
var GITHUB_CLIENT_ID="${env.GITHUB_CLIENT_ID||''}";
var adminToken=sessionStorage.getItem("admin_token");
var githubAccessToken=sessionStorage.getItem("github_token");
var deployScriptContent="";
function copyText(t){navigator.clipboard.writeText(t);alert("Copied!")}
async function loadReadme(){var c=document.getElementById("readme-container");if(!c)return;try{var r=await fetch("/api/readme");c.innerHTML=await r.text()}catch(e){c.innerHTML="Failed to load"}}
async function loadDeployScript(){var c=document.getElementById("deploy-script");if(!c)return;try{var r=await fetch("/api/deploy-script");deployScriptContent=await r.text();c.textContent=deployScriptContent}catch(e){c.textContent="Failed"}}
async function refreshStats(){try{var r=await fetch("/api/stats");var d=await r.json();document.getElementById("stars").innerText=d.stars;document.getElementById("forks").innerText=d.forks}catch(e){}}
function copyCode(){if(deployScriptContent){navigator.clipboard.writeText(deployScriptContent);alert("Copied!")}}
async function recordInstall(id){await fetch("/api/stats/install",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pluginId:id})})}
async function loadPlugins(){var c=document.getElementById("plugin-list");if(!c)return;var s=document.getElementById("plugin-search")?.value.toLowerCase()||"";var cat=document.getElementById("category-filter")?.value||"";try{var r=await fetch("/api/plugins");var p=await r.json();p=p.filter(function(x){return x.name.toLowerCase().includes(s)&&(!cat||x.category===cat)});if(!p.length){c.innerHTML="<p>No plugins found</p>";return}var h="";p.forEach(function(x){var url=x.customUrl||x.url;h+='<div class="plugin-card"><h3>'+x.name+' <span style="color:#d2991d">⭐ '+x.rating+'</span></h3><p>'+x.description+'</p><p style="font-size:0.8rem">⬇️ '+x.downloads+' installs</p><code>.plugin '+url+'</code><button class="btn btn-primary" onclick="copyText(\\'.plugin '+url.replace(/'/g,"\\\\'")+'\\');recordInstall(\\''+x.id+'\\')" style="margin-right:6px">📋 Copy</button><button class="btn btn-primary" onclick="location.href=\\'/plugin/'+x.id+'\\'" style="margin-right:6px">🔍 Details</button><button class="btn btn-primary" onclick="ratePlugin(\\''+x.id+'\\')">⭐ Rate</button></div>'});c.innerHTML=h}catch(e){c.innerHTML="Failed"}}
if(document.getElementById("plugin-search")){document.getElementById("plugin-search").addEventListener("input",loadPlugins);document.getElementById("category-filter").addEventListener("change",loadPlugins)}
function loginWithGitHub(){var w=600,h=600,l=(screen.width-w)/2,t=(screen.height-h)/2;window.open("https://github.com/login/oauth/authorize?client_id="+GITHUB_CLIENT_ID+"&redirect_uri="+encodeURIComponent("https://web.crysnovax.link/auth/github/callback")+"&scope=read:user","GitHub","width="+w+",height="+h+",left="+l+",top="+t)}
window.addEventListener("message",function(e){if(e.data.type==="github-oauth"&&e.data.accessToken){githubAccessToken=e.data.accessToken;sessionStorage.setItem("github_token",githubAccessToken);document.getElementById("login-prompt").style.display="none";document.getElementById("submit-form").style.display="block"}})
async function submitPlugin(){var n=document.getElementById("plugin-name").value.trim(),d=document.getElementById("plugin-desc").value.trim(),c=document.getElementById("plugin-code").value.trim(),cat=document.getElementById("plugin-category").value;if(!n||!d||!c){alert("All fields required");return}var s=document.getElementById("submit-status");s.innerHTML="Submitting...";try{var r=await fetch("/api/submit-plugin",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accessToken:githubAccessToken,name:n,description:d,code:c,category:cat})});var data=await r.json();s.innerHTML=data.success?'<p style="color:var(--green)">✓ Submitted!</p>':'<p style="color:var(--red)">✘ Failed</p>'}catch(e){s.innerHTML="Error"}}
async function subscribeEmail(){var email=document.getElementById("subscribe-email").value.trim();var s=document.getElementById("subscribe-status");if(!email){s.innerHTML='<p style="color:var(--red)">Enter email</p>';return}try{var r=await fetch("/api/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:email})});var d=await r.json();s.innerHTML=d.success?'<p style="color:var(--green)">✓ Subscribed!</p>':'<p style="color:var(--red)">Failed</p>'}catch(e){s.innerHTML="Error"}}
async function ratePlugin(id){if(!githubAccessToken){alert("Login first");return}var rating=prompt("Rate 1-5:");if(!rating||isNaN(rating)||rating<1||rating>5)return;try{var r=await fetch("/api/ratings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pluginId:id,rating:parseInt(rating),accessToken:githubAccessToken})});var d=await r.json();if(d.success){alert("Rated! Avg: "+d.average);loadPlugins()}}catch(e){alert("Error")}}
function adminLogin(){adminToken=document.getElementById("admin-password").value;sessionStorage.setItem("admin_token",adminToken);loadAdminPanel()}
async function loadAdminPanel(){if(!adminToken)return;try{var r=await fetch("/api/admin/submissions",{headers:{"Authorization":"Bearer "+adminToken}});if(!r.ok){document.getElementById("login-error").innerText="Invalid password";return}document.getElementById("admin-login").style.display="none";document.getElementById("admin-panel").style.display="block";loadSubmissions();loadApprovedPlugins()}catch(e){}}
async function loadSubmissions(){var l=document.getElementById("submissions-list");if(!l)return;try{var r=await fetch("/api/admin/submissions",{headers:{"Authorization":"Bearer "+adminToken}});var s=await r.json();if(!s.length){l.innerHTML="<p>No pending</p>";return}var h="";s.forEach(function(x){h+='<div style="border:1px solid var(--border);border-radius:8px;padding:1rem;margin-bottom:0.8rem"><h4>'+x.name+' by '+x.author+'</h4><p style="color:var(--text2);font-size:0.85rem">'+x.description+'</p><details><summary style="cursor:pointer;color:var(--primary)">View Code</summary><pre style="background:var(--surface2);padding:0.8rem;border-radius:4px;overflow:auto;font-size:0.8rem;margin-top:0.5rem">'+x.code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</pre></details><div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-success" onclick="approvePlugin(\\''+x.id+'\\')">✓ Accept</button><button class="btn btn-danger" onclick="rejectPlugin(\\''+x.id+'\\')">✗ Reject</button></div></div>'});l.innerHTML=h}catch(e){}}
async function loadApprovedPlugins(){var c=document.getElementById("approved-plugins-list");if(!c)return;try{var r=await fetch("/api/admin/plugins",{headers:{"Authorization":"Bearer "+adminToken}});var p=await r.json();if(!p.length){c.innerHTML="<p>None</p>";return}var h="";p.forEach(function(x){var url=x.customUrl||x.url;h+='<div style="border:1px solid var(--border);border-radius:8px;padding:1rem;margin-bottom:0.8rem"><h4>'+x.name+' by '+x.author+'</h4><p style="color:var(--text2);font-size:0.85rem">'+x.description+'</p><code>.plugin '+url+'</code><div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-warning" onclick="editPlugin(\\''+x.id+'\\',\\''+x.name.replace(/'/g,"\\\\'")+'\\',\\''+(x.description||'').replace(/'/g,"\\\\'")+'\\',\\''+(x.code||'').replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'").replace(/\\n/g,'\\\\n')+'\\',\\''+(x.customUrl||'').replace(/'/g,"\\\\'")+'\\',\\''+(x.category||'utility')+'\\')">✏️ Edit</button><button class="btn btn-danger" onclick="deletePlugin(\\''+x.id+'\\')">🗑️ Delete</button></div></div>'});c.innerHTML=h}catch(e){}}
async function approvePlugin(id){await fetch("/api/admin/approve",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+adminToken},body:JSON.stringify({id})});alert("Approved!");loadSubmissions();loadApprovedPlugins();if(typeof loadPlugins==="function")loadPlugins()}
async function rejectPlugin(id){if(!confirm("Reject?"))return;await fetch("/api/admin/submissions",{method:"DELETE",headers:{"Content-Type":"application/json","Authorization":"Bearer "+adminToken},body:JSON.stringify({id})});alert("Rejected");loadSubmissions()}
function editPlugin(id,name,desc,code,customUrl,category){document.getElementById("edit-plugin-id").value=id;document.getElementById("edit-plugin-name").value=name;document.getElementById("edit-plugin-desc").value=desc;document.getElementById("edit-plugin-code").value=code;document.getElementById("edit-plugin-url").value=customUrl;document.getElementById("edit-plugin-category").value=category||"utility";document.getElementById("editModal").style.display="flex"}
function closeEditModal(){document.getElementById("editModal").style.display="none"}
async function savePluginEdit(){var id=document.getElementById("edit-plugin-id").value;var name=document.getElementById("edit-plugin-name").value.trim();var desc=document.getElementById("edit-plugin-desc").value.trim();var code=document.getElementById("edit-plugin-code").value.trim();var url=document.getElementById("edit-plugin-url").value.trim();var cat=document.getElementById("edit-plugin-category").value;var r=await fetch("/api/admin/plugins",{method:"PUT",headers:{"Content-Type":"application/json","Authorization":"Bearer "+adminToken},body:JSON.stringify({id,name,description:desc,code,customUrl:url,category:cat})});var d=await r.json();if(d.success){alert("Updated!");closeEditModal();loadApprovedPlugins();if(typeof loadPlugins==="function")loadPlugins()}}
async function deletePlugin(id){if(!confirm("Delete?"))return;var r=await fetch("/api/admin/plugins",{method:"DELETE",headers:{"Content-Type":"application/json","Authorization":"Bearer "+adminToken},body:JSON.stringify({id})});var d=await r.json();if(d.success){alert("Deleted!");loadApprovedPlugins();if(typeof loadPlugins==="function")loadPlugins()}}
if(location.pathname==="/"||location.pathname===""){loadReadme();refreshStats();setInterval(refreshStats,300000)}
else if(location.pathname==="/deploy"){loadDeployScript()}
else if(location.pathname==="/plugins"){loadPlugins()}
else if(location.pathname==="/submit"){if(githubAccessToken){document.getElementById("login-prompt").style.display="none";document.getElementById("submit-form").style.display="block"}}
else if(location.pathname==="/admin"){if(adminToken)loadAdminPanel()}
</script></body></html>`;
}
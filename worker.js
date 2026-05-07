// worker.js – CRYSNOVA LIVE
// API logic 100% untouched - only frontend upgraded
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
      const cacheKey = 'github-stats';
      if (env.CRYSNOVA_CACHE) {
        const cached = await env.CRYSNOVA_CACHE.get(cacheKey);
        if (cached) return JSON.parse(cached);
      }
      const res = await fetch('https://api.github.com/repos/crysnovax/CRYSNOVA_AI', { headers: githubHeaders });
      const data = await res.json();
      const stats = { stars: data.stargazers_count || 0, forks: data.forks_count || 0 };
      if (env.CRYSNOVA_CACHE) await env.CRYSNOVA_CACHE.put(cacheKey, JSON.stringify(stats), { expirationTtl: 300 });
      return stats;
    }

    async function renderMarkdown(rawUrl) {
      const rawRes = await fetch(rawUrl, { headers: githubHeaders });
      if (!rawRes.ok) throw new Error('Failed to fetch raw content: ' + rawRes.status);
      const raw = await rawRes.text();
      const mdRes = await fetch('https://api.github.com/markdown', {
        method: 'POST', headers: { ...githubHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: raw, mode: 'gfm' })
      });
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
        await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'CRYSNOVA LIVE <notify@web.crysnovax.link>', to: emails, subject, html: body })
        });
      } catch (e) {}
    }

    // ============ PUBLIC API ============
    if (path === '/api/config-status') return new Response(JSON.stringify(configStatus), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (path === '/api/stats') { const s = await getGitHubStats(); return new Response(JSON.stringify(s), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }
    if (path === '/api/readme' && env.README_URL) { try { return new Response(await renderMarkdown(env.README_URL), { headers: { ...corsHeaders, 'Content-Type': 'text/html' } }); } catch { return new Response('Error', { status: 500 }); } }
    if (path === '/api/deploy-script' && env.DEPLOY_README_URL) { try { return new Response(await fetchRawText(env.DEPLOY_README_URL), { headers: { ...corsHeaders, 'Content-Type': 'text/plain' } }); } catch { return new Response('Error', { status: 500 }); } }

    if (path === '/api/plugins') {
      const pluginsJson = await env.PLUGIN_STORE.get('plugins');
      let plugins = pluginsJson ? JSON.parse(pluginsJson) : [];
      for (let p of plugins) {
        p.downloads = parseInt(await env.STATS_STORE.get('downloads:' + p.id) || '0');
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
      } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
    }

    if (path === '/api/stats/install' && method === 'POST') {
      const { pluginId } = await request.json();
      if (!pluginId) return new Response(JSON.stringify({ error: 'Missing pluginId' }), { status: 400 });
      const key = 'downloads:' + pluginId;
      const current = await env.STATS_STORE.get(key);
      await env.STATS_STORE.put(key, (current ? parseInt(current) + 1 : 1).toString());
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    if (path === '/api/ratings' && method === 'POST') {
      const { pluginId, rating, accessToken } = await request.json();
      if (!pluginId || !rating || !accessToken) return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400 });
      try {
        const user = await getGitHubUser(accessToken);
        await env.RATINGS_STORE.put('rating:' + pluginId + ':' + user.login, rating.toString());
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
        const sid = crypto.randomUUID();
        await env.SUBMISSION_STORE.put(sid, JSON.stringify({ id: sid, name, description, code, category: category || 'utility', author: user.login, authorName: user.name || user.login, authorAvatar: user.avatar_url, submittedAt: Date.now(), status: 'pending' }));
        await sendNotification('New Plugin: ' + name, '<p><strong>' + name + '</strong> by ' + user.login + '</p>');
        return new Response(JSON.stringify({ success: true, id: sid }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
    }

    // ============ ADMIN API ============
    if (path.startsWith('/api/admin')) {
      if (!isAdmin(request)) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'WWW-Authenticate': 'Basic' } });
      if (path === '/api/admin/submissions' && method === 'GET') {
        const list = await env.SUBMISSION_STORE.list();
        const subs = []; for (const k of list.keys) { const d = await env.SUBMISSION_STORE.get(k.name); if (d) subs.push(JSON.parse(d)); }
        return new Response(JSON.stringify(subs), { headers: { ...corsHeaders } });
      }
      if (path === '/api/admin/submissions' && method === 'DELETE') { await env.SUBMISSION_STORE.delete((await request.json()).id); return new Response(JSON.stringify({ success: true }), { headers: corsHeaders }); }
      if (path === '/api/admin/approve' && method === 'POST') {
        const { id } = await request.json();
        const sd = await env.SUBMISSION_STORE.get(id);
        if (!sd) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        const sub = JSON.parse(sd);
        const fn = 'plugins/' + sub.author + '-' + sub.name.replace(/[^a-zA-Z0-9]/g,'_') + '-' + Date.now() + '.js';
        await env.PLUGIN_FILES.put(fn, sub.code);
        let rawUrl = 'https://cdn.crysnovax.link/' + fn;
        try { const fd = new FormData(); fd.append('file', new Blob([sub.code],{type:'text/plain'}),'paste.txt'); const up = await (await fetch(env.CDN_URL+'/upload',{method:'POST',body:fd})).json(); if(up.url) rawUrl = up.url.replace(/\/(upload|file)\//,'/files/').replace(/\.html?$/,'.txt'); } catch(e){}
        const pj = await env.PLUGIN_STORE.get('plugins'); const pls = pj ? JSON.parse(pj) : [];
        pls.push({ id: crypto.randomUUID(), name: sub.name, description: sub.description, author: sub.author, authorName: sub.authorName, code: sub.code, category: sub.category||'utility', filename: fn, url: rawUrl, customUrl: '', verified: true, approvedAt: Date.now() });
        await env.PLUGIN_STORE.put('plugins', JSON.stringify(pls));
        await env.SUBMISSION_STORE.delete(id);
        return new Response(JSON.stringify({ success: true, url: rawUrl }), { headers: corsHeaders });
      }
      if (path === '/api/admin/plugins' && method === 'GET') { const p = await env.PLUGIN_STORE.get('plugins'); return new Response(p||'[]', { headers: corsHeaders }); }
      if (path === '/api/admin/plugins' && method === 'PUT') {
        const { id, name, description, code, customUrl, category } = await request.json();
        const pj = await env.PLUGIN_STORE.get('plugins'); let ps = pj ? JSON.parse(pj) : [];
        const i = ps.findIndex(p => p.id === id);
        if (i === -1) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        if (name) ps[i].name = name; if (description) ps[i].description = description;
        if (customUrl !== undefined) ps[i].customUrl = customUrl;
        if (category) ps[i].category = category;
        if (code) { ps[i].code = code; if (ps[i].filename) await env.PLUGIN_FILES.put(ps[i].filename, code); }
        await env.PLUGIN_STORE.put('plugins', JSON.stringify(ps));
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
      if (path === '/api/admin/plugins' && method === 'DELETE') {
        const { id } = await request.json();
        const pj = await env.PLUGIN_STORE.get('plugins'); let ps = pj ? JSON.parse(pj) : [];
        const pl = ps.find(p => p.id === id);
        if (pl?.filename) await env.PLUGIN_FILES.delete(pl.filename).catch(()=>{});
        ps = ps.filter(p => p.id !== id);
        await env.PLUGIN_STORE.put('plugins', JSON.stringify(ps));
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
      return new Response(JSON.stringify({ error: 'Admin endpoint not found' }), { status: 404 });
    }

    // ============ OAUTH ============
    if (path === '/auth/github/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('Missing code', { status: 400 });
      const tr = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }) });
      const td = await tr.json();
      if (td.error) return new Response(td.error_description, { status: 400 });
      return new Response('<!DOCTYPE html><html><head><script>window.opener.postMessage({type:"github-oauth",accessToken:"' + td.access_token + '"}, "*");window.close();</script></head><body>Done!</body></html>', { headers: { 'Content-Type': 'text/html' } });
    }

    // ============ RAW FILES ============
    if (path.startsWith('/raw/')) {
      const c = await env.PLUGIN_FILES.get(path.slice(5));
      if (!c) return new Response('Not found', { status: 404 });
      return new Response(c, { headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } });
    }

    // ============ PLUGIN DETAIL ============
    if (path.startsWith('/plugin/')) {
      const pid = path.slice(8);
      const pj = await env.PLUGIN_STORE.get('plugins'); const ps = pj ? JSON.parse(pj) : [];
      const p = ps.find(x => x.id === pid);
      if (!p) return new Response('Not found', { status: 404 });
      const dls = await env.STATS_STORE.get('downloads:' + pid) || '0';
      const rl = await env.RATINGS_STORE.list({ prefix: 'rating:' + pid + ':' });
      let sum = 0, cnt = 0;
      for (const k of rl.keys) { const v = await env.RATINGS_STORE.get(k.name); if (v) { sum += parseInt(v); cnt++; } }
      return new Response(detailPage(p, dls, cnt > 0 ? (sum/cnt).toFixed(1) : '0.0', cnt), { headers: { 'Content-Type': 'text/html' } });
    }

    // ============ FRONTEND ============
    const stats = await getGitHubStats();
    return new Response(frontend(env, path, stats, configStatus, allConfigured), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }
};

function detailPage(p, dls, rt, rc) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${p.name} - CRYSNOVA</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"><style>${detailCSS()}</style></head><body><a href="/plugins" class="back">← Plugins</a><div class="container"><h1>${p.name}</h1><p class="desc">${p.description}</p><div class="meta"><span>⭐ ${rt} (${rc})</span><span>⬇️ ${dls}</span><span>👤 ${p.authorName||p.author}</span></div><div class="cmd"><code>.plugin ${p.customUrl||p.url}</code><button onclick="navigator.clipboard.writeText('.plugin ${p.customUrl||p.url}')">Copy</button></div><h2>Source</h2><pre>${esc(p.code)}</pre></div></body></html>`;
}
function esc(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function detailCSS() {
  return `:root{--bg:#05070d;--s:#0c1119;--b:rgba(56,139,253,.15);--p:#388bfd;--t:#e6edf3;--t2:#8b949e}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--t);font-family:'Inter',sans-serif;min-height:100vh;padding:2rem}.back{color:var(--p);text-decoration:none;font-size:.9rem}.container{max-width:800px;margin:2rem auto}h1{font-size:2rem;font-weight:700;margin-bottom:.5rem}.desc{color:var(--t2);margin-bottom:1.5rem;line-height:1.6}.meta{display:flex;gap:2rem;margin:1rem 0;color:var(--t2)}.cmd{background:var(--s);border:1px solid var(--b);border-radius:10px;padding:1rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:1.5rem 0}code{font-family:'JetBrains Mono',monospace;font-size:.85rem;color:var(--p)}button{background:var(--p);color:#fff;border:none;padding:.6rem 1.2rem;border-radius:6px;cursor:pointer;font-weight:600}h2{font-size:1.1rem;margin:1.5rem 0 .8rem}pre{background:var(--s);border:1px solid var(--b);border-radius:10px;padding:1.5rem;overflow:auto;font-size:.85rem;line-height:1.6}@media(max-width:600px){body{padding:1rem}.meta{flex-direction:column;gap:.5rem}}`;
}

function frontend(env, path, stats, cs, ac) {
  const isHome = path === '/' || path === '';
  const GID = env.GITHUB_CLIENT_ID || '';
  const title = isHome ? 'CRYSN⚉VA' : path==='/deploy' ? 'Deploy' : path==='/plugins' ? 'Plugins' : path==='/submit' ? 'Submit' : path==='/admin' ? 'Admin' : path==='/docs' ? 'Docs' : '404';
  const icon = isHome ? '✦' : path==='/deploy' ? '↓' : path==='/plugins' ? '◆' : path==='/submit' ? '↑' : path==='/admin' ? '◈' : '○';
  const d = { r: cs.readme?'✓':'·', d: cs.deploy?'✓':'·', p: (cs.pluginStore&&cs.pluginFiles)?'✓':'·', s: cs.github?'✓':'·', a: cs.admin?'✓':'·' };

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${icon} ${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  --bg:#05070d;
  --s:rgba(12,17,25,0.85);
  --s2:rgba(18,24,36,0.9);
  --b:rgba(56,139,253,0.1);
  --bf:rgba(56,139,253,0.25);
  --p:#388bfd;
  --pa:#58a6ff;
  --t:#e6edf3;
  --t2:#8b949e;
  --t3:#484f58;
  --g:#3fb950;
  --r:#f85149;
  --y:#d2991d;
  --rd:14px;
  --rds:8px;
  --font:'Inter',system-ui,-apple-system,sans-serif;
  --mono:'JetBrains Mono',monospace;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--t);font-family:var(--font);min-height:100vh;overflow-x:hidden}
.particles{position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none}
.p{position:absolute;border-radius:50%;background:var(--p);opacity:0.03;animation:drift 30s infinite linear}
@keyframes drift{0%{transform:translate(0,0)}25%{transform:translate(100px,-50px)}50%{transform:translate(200px,100px)}75%{transform:translate(-50px,150px)}100%{transform:translate(0,0)}}
.glow{position:fixed;z-index:0;pointer-events:none}
.glow-1{top:-20%;right:-10%;width:700px;height:700px;background:radial-gradient(circle,rgba(56,139,253,0.06) 0%,transparent 70%)}
.glow-2{bottom:-20%;left:-10%;width:600px;height:600px;background:radial-gradient(circle,rgba(88,166,255,0.04) 0%,transparent 70%)}
.wrap{max-width:1050px;margin:0 auto;padding:1.5rem;position:relative;z-index:1}
.nav{display:flex;align-items:center;justify-content:space-between;padding:1rem 1.5rem;background:var(--s);backdrop-filter:blur(20px);border:1px solid var(--b);border-radius:var(--rd);margin-bottom:2rem;position:sticky;top:1rem;z-index:50}
.nav-logo{font-weight:800;font-size:1.1rem;background:linear-gradient(135deg,var(--p),var(--pa));-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-decoration:none}
.nav-links{display:flex;gap:4px;flex-wrap:wrap}
.nav-links a{color:var(--t2);text-decoration:none;padding:.45rem .9rem;border-radius:20px;font-size:.8rem;font-weight:500;transition:all .2s;white-space:nowrap}
.nav-links a:hover,.nav-links a.on{background:var(--p);color:#fff}
.hero{text-align:center;padding:3rem 1rem;margin-bottom:2rem}
.hero h1{font-size:3.5rem;font-weight:900;letter-spacing:-.03em;background:linear-gradient(135deg,var(--p) 0%,var(--pa) 50%,#a371f7 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:1rem}
.hero p{color:var(--t2);font-size:1.1rem;max-width:500px;margin:0 auto;line-height:1.6}
.alert{background:rgba(248,81,73,0.06);border:1px solid rgba(248,81,73,0.25);border-radius:var(--rds);padding:.7rem 1.2rem;margin-bottom:1.5rem;text-align:center;color:var(--r);font-size:.85rem;font-weight:500}
.grid{display:grid;gap:1rem}
.grid-2{grid-template-columns:1fr 1fr}
.card{background:var(--s);backdrop-filter:blur(15px);border:1px solid var(--b);border-radius:var(--rd);padding:1.8rem;transition:all .3s}
.card:hover{border-color:var(--bf)}
.card h2{font-size:1rem;font-weight:600;margin-bottom:1rem;color:var(--pa)}
.stats-row{display:flex;gap:2rem;justify-content:center;flex-wrap:wrap}
.stat-val{font-size:2.5rem;font-weight:800;color:var(--p)}
.stat-lbl{font-size:.75rem;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin-top:.2rem}
input,textarea,select{width:100%;padding:.7rem .9rem;background:rgba(18,24,36,0.8);border:1px solid var(--b);border-radius:var(--rds);color:var(--t);font-family:var(--font);font-size:.85rem;outline:none;margin-bottom:.7rem;transition:border .2s}
input:focus,textarea:focus,select:focus{border-color:var(--p)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:.55rem 1.2rem;border-radius:20px;font-size:.82rem;font-weight:600;cursor:pointer;border:none;transition:all .2s;font-family:var(--font);text-decoration:none}
.btn-p{background:var(--p);color:#fff}.btn-p:hover{filter:brightness(1.2)}
.btn-s{background:var(--g);color:#fff}.btn-d{background:var(--r);color:#fff}.btn-w{background:var(--y);color:#000}.btn-o{background:transparent;color:var(--t2);border:1px solid var(--b)}.btn-o:hover{border-color:var(--p)}
.code-block{background:rgba(18,24,36,0.8);border:1px solid var(--b);border-radius:var(--rds);padding:1.2rem;font-family:var(--mono);font-size:.82rem;overflow:auto;line-height:1.7;max-height:60vh}
.plugin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.plugin-card{background:var(--s);border:1px solid var(--b);border-radius:var(--rd);padding:1.3rem;transition:all .25s}
.plugin-card:hover{border-color:var(--bf);transform:translateY(-2px)}
.plugin-card h3{font-size:.95rem;margin-bottom:.4rem}
.plugin-card .pdesc{color:var(--t2);font-size:.8rem;margin-bottom:.6rem;line-height:1.5}
.plugin-card .pmeta{font-size:.75rem;color:var(--t3);margin-bottom:.5rem}
.plugin-card .pcode{display:block;background:rgba(0,0,0,.3);padding:.35rem .6rem;border-radius:4px;font-family:var(--mono);font-size:.75rem;color:var(--pa);margin:.5rem 0;word-break:break-all}
.pactions{display:flex;gap:6px;flex-wrap:wrap;margin-top:.5rem}
.footer{text-align:center;color:var(--t3);margin-top:3rem;padding-top:2rem;border-top:1px solid var(--b);font-size:.82rem}
.footer .brand{color:var(--p);font-weight:700}
.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:100}
.modal-box{background:var(--s);backdrop-filter:blur(20px);padding:2rem;border-radius:var(--rd);max-width:500px;width:90%;border:1px solid var(--b)}
.modal-box label{display:block;font-size:.8rem;color:var(--t2);margin-bottom:.3rem}
.tag{display:inline-block;padding:.15rem .5rem;border-radius:10px;font-size:.7rem;font-weight:600}
.tag-g{background:rgba(63,185,80,.15);color:var(--g)}.tag-r{background:rgba(248,81,73,.15);color:var(--r)}.tag-y{background:rgba(210,153,29,.15);color:var(--y)}
.socials{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin:2rem 0}
.socials a{color:var(--t2);text-decoration:none;padding:.4rem 1rem;border-radius:20px;font-size:.8rem;border:1px solid var(--b);transition:all .2s}
.socials a:hover{border-color:var(--p);color:var(--t)}
@media(max-width:768px){.hero h1{font-size:2.2rem}.grid-2{grid-template-columns:1fr}.nav{flex-direction:column;gap:.8rem}.nav-links{justify-content:center}}
</style>
</head>
<body>
<div class="particles"><div class="p" style="width:400px;height:400px;top:10%;left:5%"></div><div class="p" style="width:300px;height:300px;top:60%;left:70%;animation-delay:-10s"></div><div class="p" style="width:200px;height:200px;top:30%;left:50%;animation-delay:-20s"></div></div>
<div class="glow glow-1"></div><div class="glow glow-2"></div>
<div class="wrap">
<nav class="nav"><a href="/" class="nav-logo">CRYSN⚉VA LIVE</a><div class="nav-links"><a href="/" class="${isHome?'on':''}">${d.r} Info</a><a href="/deploy" class="${path==='/deploy'?'on':''}">${d.d} Deploy</a><a href="/plugins" class="${path==='/plugins'?'on':''}">${d.p} Plugins</a><a href="/submit" class="${path==='/submit'?'on':''}">${d.s} Submit</a><a href="/admin" class="${path==='/admin'?'on':''}">${d.a} Admin</a></div></nav>
${!ac ? '<div class="alert">⚠ Some services not configured</div>' : ''}
${isHome ? `
<div class="hero"><h1>CRYSN⚉VA</h1><p>The AI powerhouse behind the most advanced WhatsApp bot ecosystem. Deploy, extend, and manage everything from one place.</p></div>
<div class="grid grid-2">
<div class="card"><h2>Repository</h2><div class="stats-row"><div style="text-align:center"><div class="stat-val" id="stars">${stats.stars}</div><div class="stat-lbl">Stars</div></div><div style="text-align:center"><div class="stat-val" id="forks">${stats.forks}</div><div class="stat-lbl">Forks</div></div></div><div style="text-align:center;margin-top:1rem"><a href="https://github.com/crysnovax/CRYSNOVA_AI" target="_blank" style="color:var(--p);font-weight:600">View on GitHub →</a></div></div>
<div class="card"><h2>Subscribe</h2><input type="email" id="se" placeholder="email@example.com"><button class="btn btn-p" onclick="sub()">Subscribe</button><p id="ss" style="margin-top:.5rem;font-size:.8rem"></p></div>
</div>
<div class="card" style="margin-top:1rem"><h2>README</h2><div id="rm" style="max-height:65vh;overflow-y:auto">Loading...</div></div>
` : path==='/deploy' ? `
<div class="hero"><h1>Deploy</h1><p>One command to deploy your own CRYSNOVA bot instance.</p></div>
<div class="card"><button class="btn btn-p" onclick="cc()" style="margin-bottom:1rem">Copy Script</button><div class="code-block"><pre><code id="ds">Loading...</code></pre></div></div>
` : path==='/plugins' ? `
<div class="hero"><h1>Plugins</h1><p>Extend your bot with community plugins.</p></div>
<div class="card"><input type="text" id="ps" placeholder="Search plugins..."><select id="cf"><option value="">All</option><option value="fun">Fun</option><option value="utility">Utility</option><option value="ai">AI</option><option value="admin">Admin</option><option value="downloader">Downloader</option></select><div id="pl" class="plugin-grid">Loading...</div></div>
` : path==='/submit' ? `
<div class="hero"><h1>Submit</h1><p>Share your plugin with the community.</p></div>
<div class="card"><div id="sst"></div><div id="lp"><button class="btn btn-p" onclick="lgh()">Login with GitHub</button></div><div id="sf" style="display:none"><input type="text" id="pn" placeholder="Name"><textarea id="pd" placeholder="Description" rows="3"></textarea><textarea id="pc" placeholder="Code" rows="10" style="font-family:var(--mono)"></textarea><select id="pcat"><option value="">Category</option><option value="fun">Fun</option><option value="utility">Utility</option><option value="ai">AI</option><option value="admin">Admin</option><option value="downloader">Downloader</option></select><button class="btn btn-p" onclick="sp()">Submit</button></div></div>
` : path==='/admin' ? `
<div class="hero"><h1>Admin</h1></div>
<div class="card"><div id="al"><input type="password" id="ap" placeholder="Password"><button class="btn btn-p" onclick="al()">Enter</button><p id="ale" style="color:var(--r);margin-top:.5rem"></p></div><div id="apn" style="display:none"><h3 style="margin-bottom:1rem">Pending</h3><div id="sl">Loading...</div><hr style="border-color:var(--b);margin:2rem 0"><h3 style="margin-bottom:1rem">Approved</h3><div id="apl">Loading...</div></div></div>
<div id="em" class="modal-overlay" style="display:none"><div class="modal-box"><h3 style="margin-bottom:1rem">Edit Plugin</h3><input type="hidden" id="ei"><label>Name</label><input type="text" id="en"><label>Desc</label><textarea id="ed" rows="2"></textarea><label>Code</label><textarea id="ec" rows="8" style="font-family:var(--mono)"></textarea><label>URL</label><input type="text" id="eu"><label>Category</label><select id="ecat"><option value="fun">Fun</option><option value="utility">Utility</option><option value="ai">AI</option><option value="admin">Admin</option><option value="downloader">Downloader</option></select><div style="display:flex;gap:10px;justify-content:flex-end;margin-top:1.5rem"><button class="btn btn-d" onclick="document.getElementById('em').style.display='none'">Cancel</button><button class="btn btn-s" onclick="se()">Save</button></div></div></div>
` : path==='/docs' ? `
<div class="hero"><h1>API</h1></div>
<div class="card"><h2>Public</h2><div class="code-block">GET /api/plugins<br>GET /api/stats<br>POST /api/subscribe<br>POST /api/ratings</div><h2 style="margin-top:1.5rem">Admin</h2><div class="code-block">GET /api/admin/submissions<br>POST /api/admin/approve<br>PUT /api/admin/plugins<br>DELETE /api/admin/plugins</div></div>
` : `<div class="hero"><h1>404</h1><p>Page not found.</p></div>`}
<div class="socials"><a href="https://whatsapp.com/channel/0029Vb6pe77K0IBn48HLKb38">Channel</a><a href="https://chat.whatsapp.com/Besbj8VIle1GwxKKZv1lax">Group</a><a href="https://youtube.com/@crysnovax">YouTube</a><a href="https://github.com/crysnovax">GitHub</a></div>
<div class="footer"><span class="brand">CRYSNOVA AI</span> · Live Documentation</div>
</div>
<script>
var GID="${GID}";var AT=sessionStorage.getItem("at");var GT=sessionStorage.getItem("gt");var DC="";
function cp(t){navigator.clipboard.writeText(t);alert("Copied")}
async function lr(){var c=document.getElementById("rm");if(!c)return;try{var r=await fetch("/api/readme");c.innerHTML=await r.text()}catch(e){c.innerHTML="Failed"}}
async function ld(){var c=document.getElementById("ds");if(!c)return;try{var r=await fetch("/api/deploy-script");DC=await r.text();c.textContent=DC}catch(e){c.textContent="Failed"}}
async function rs(){try{var r=await fetch("/api/stats");var d=await r.json();document.getElementById("stars").innerText=d.stars;document.getElementById("forks").innerText=d.forks}catch(e){}}
function cc(){if(DC){navigator.clipboard.writeText(DC);alert("Copied")}}
async function ri(id){await fetch("/api/stats/install",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pluginId:id})})}
async function lp(){var c=document.getElementById("pl");if(!c)return;var s=document.getElementById("ps")?.value.toLowerCase()||"";var cat=document.getElementById("cf")?.value||"";try{var r=await fetch("/api/plugins");var p=await r.json();p=p.filter(function(x){return x.name.toLowerCase().includes(s)&&(!cat||x.category===cat)});if(!p.length){c.innerHTML="<p style=color:var(--t2)>None</p>";return}var h="";p.forEach(function(x){var u=x.customUrl||x.url;h+='<div class=plugin-card><h3>'+x.name+' <span class="tag tag-y">⭐ '+x.rating+'</span></h3><div class=pdesc>'+x.description+'</div><div class=pmeta>'+x.downloads+' installs · '+x.author+'</div><span class=pcode>.plugin '+u+'</span><div class=pactions><button class="btn btn-p" onclick="cp(&quot;.plugin '+u+'&quot;);ri(&quot;'+x.id+'&quot;)">Copy</button><button class="btn btn-o" onclick="location.href=&quot;/plugin/'+x.id+'&quot;">Details</button><button class="btn btn-o" onclick="rp(&quot;'+x.id+'&quot;)">Rate</button></div></div>'});c.innerHTML=h}catch(e){c.innerHTML="Failed"}}
if(document.getElementById("ps")){document.getElementById("ps").addEventListener("input",lp);document.getElementById("cf").addEventListener("change",lp)}
function lgh(){var w=600,h=600;window.open("https://github.com/login/oauth/authorize?client_id="+GID+"&redirect_uri="+encodeURIComponent("https://web.crysnovax.link/auth/github/callback")+"&scope=read:user","GH","width="+w+",height="+h+",left="+((screen.width-w)/2)+",top="+((screen.height-h)/2))}
window.addEventListener("message",function(e){if(e.data.type==="github-oauth"&&e.data.accessToken){GT=e.data.accessToken;sessionStorage.setItem("gt",GT);document.getElementById("lp").style.display="none";document.getElementById("sf").style.display="block"}})
async function sp(){var n=document.getElementById("pn").value.trim();var d=document.getElementById("pd").value.trim();var c=document.getElementById("pc").value.trim();var cat=document.getElementById("pcat").value;if(!n||!d||!c){alert("Fill all fields");return}var s=document.getElementById("sst");s.innerHTML="Submitting...";try{var r=await fetch("/api/submit-plugin",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accessToken:GT,name:n,description:d,code:c,category:cat})});var data=await r.json();s.innerHTML=data.success?'<span class="tag tag-g">✓ Submitted</span>':'<span class="tag tag-r">Failed</span>'}catch(e){s.innerHTML="Error"}}
async function sub(){var e=document.getElementById("se").value.trim();var s=document.getElementById("ss");if(!e){s.innerHTML='<span class="tag tag-r">Enter email</span>';return}try{var r=await fetch("/api/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:e})});s.innerHTML=(await r.json()).success?'<span class="tag tag-g">✓ Subscribed</span>':'<span class="tag tag-r">Failed</span>'}catch(x){s.innerHTML="Error"}}
async function rp(id){if(!GT){alert("Login first");return}var r=prompt("Rate 1-5:");if(!r||isNaN(r)||r<1||r>5)return;try{var d=await (await fetch("/api/ratings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pluginId:id,rating:parseInt(r),accessToken:GT})})).json();if(d.success){alert("Rated! Avg: "+d.average);lp()}}catch(e){alert("Error")}}
function al(){AT=document.getElementById("ap").value;sessionStorage.setItem("at",AT);lap()}
async function lap(){if(!AT)return;try{var r=await fetch("/api/admin/submissions",{headers:{"Authorization":"Bearer "+AT}});if(!r.ok){document.getElementById("ale").innerText="Invalid";return}document.getElementById("al").style.display="none";document.getElementById("apn").style.display="block";ls();la()}catch(e){}}
async function ls(){var l=document.getElementById("sl");try{var s=await (await fetch("/api/admin/submissions",{headers:{"Authorization":"Bearer "+AT}})).json();if(!s.length){l.innerHTML="<p style=color:var(--t2)>None</p>";return}var h="";s.forEach(function(x){h+='<div style="border:1px solid var(--b);border-radius:var(--rds);padding:1rem;margin-bottom:.6rem"><b>'+x.name+'</b> by '+x.author+'<p style=color:var(--t2);font-size:.8rem>'+x.description+'</p><details><summary style=cursor:pointer;color:var(--p)>Code</summary><pre style=background:rgba(0,0,0,.3);padding:.6rem;border-radius:4px;overflow:auto;font-size:.75rem;margin-top:.4rem>'+x.code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</pre></details><div style=display:flex;gap:6px;margin-top:.5rem><button class="btn btn-s" onclick="apv(&quot;'+x.id+'&quot;)">Accept</button><button class="btn btn-d" onclick="arj(&quot;'+x.id+'&quot;)">Reject</button></div></div>'});l.innerHTML=h}catch(e){}}
async function la(){var c=document.getElementById("apl");try{var p=await (await fetch("/api/admin/plugins",{headers:{"Authorization":"Bearer "+AT}})).json();if(!p.length){c.innerHTML="<p style=color:var(--t2)>None</p>";return}var h="";p.forEach(function(x){var u=x.customUrl||x.url;h+='<div style="border:1px solid var(--b);border-radius:var(--rds);padding:1rem;margin-bottom:.6rem"><b>'+x.name+'</b> by '+x.author+'<p style=color:var(--t2);font-size:.8rem>'+x.description+'</p><code style=font-size:.75rem>.plugin '+u+'</code><div style=display:flex;gap:6px;margin-top:.5rem><button class="btn btn-w" onclick="ed(&quot;'+x.id+'&quot;,&quot;'+x.name.replace(/"/g,'&quot;')+'&quot;,&quot;'+(x.description||'').replace(/"/g,'&quot;')+'&quot;,&quot;'+(x.code||'').replace(/\\/g,'\\\\').replace(/"/g,'&quot;').replace(/\n/g,'\\n')+'&quot;,&quot;'+(x.customUrl||'').replace(/"/g,'&quot;')+'&quot;,&quot;'+(x.category||'utility')+'&quot;)">Edit</button><button class="btn btn-d" onclick="adl(&quot;'+x.id+'&quot;)">Delete</button></div></div>'});c.innerHTML=h}catch(e){}}
async function apv(id){await fetch("/api/admin/approve",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+AT},body:JSON.stringify({id})});ls();la();lp()}
async function arj(id){if(!confirm("Reject?"))return;await fetch("/api/admin/submissions",{method:"DELETE",headers:{"Content-Type":"application/json","Authorization":"Bearer "+AT},body:JSON.stringify({id})});ls()}
function ed(id,n,d,c,u,cat){document.getElementById("ei").value=id;document.getElementById("en").value=n;document.getElementById("ed").value=d;document.getElementById("ec").value=c;document.getElementById("eu").value=u;document.getElementById("ecat").value=cat;document.getElementById("em").style.display="flex"}
async function se(){var id=document.getElementById("ei").value;var r=await fetch("/api/admin/plugins",{method:"PUT",headers:{"Content-Type":"application/json","Authorization":"Bearer "+AT},body:JSON.stringify({id,name:document.getElementById("en").value.trim(),description:document.getElementById("ed").value.trim(),code:document.getElementById("ec").value.trim(),customUrl:document.getElementById("eu").value.trim(),category:document.getElementById("ecat").value})});if((await r.json()).success){document.getElementById("em").style.display="none";la();lp()}}
async function adl(id){if(!confirm("Delete?"))return;await fetch("/api/admin/plugins",{method:"DELETE",headers:{"Content-Type":"application/json","Authorization":"Bearer "+AT},body:JSON.stringify({id})});la();lp()}
if(location.pathname==="/"||location.pathname===""){lr();rs();setInterval(rs,300000)}
else if(location.pathname==="/deploy")ld()
else if(location.pathname==="/plugins")lp()
else if(location.pathname==="/submit"){if(GT){document.getElementById("lp").style.display="none";document.getElementById("sf").style.display="block"}}
else if(location.pathname==="/admin"){if(AT)lap()}
</script></body></html>`;
}

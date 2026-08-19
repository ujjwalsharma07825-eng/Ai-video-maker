const API = location.origin;
const clientId = localStorage.getItem('clientId') || crypto.randomUUID();
localStorage.setItem('clientId', clientId);

const state = { wallet: null, settings: null, files: [], job: null, busy: false, error: '', mode: 'text' };
const app = document.getElementById('app');
const samplePrompt = 'Cinematic ultra-realistic product launch video, smooth dolly movement, dramatic lighting, premium color grade, 4K detail';
const sampleNegative = 'low quality, blurry, warped faces, flicker, text artifacts';

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

function render() {
  const output = Array.isArray(state.job?.prediction?.output) ? state.job.prediction.output[0] : state.job?.prediction?.output;
  const dailyCredits = state.wallet?.dailyCredits ?? 8;
  app.innerHTML = `
    <section class="hero">
      <div>
        <p class="eyebrow">✦ Real AI video generation</p>
        <h1>Ultimate AI Video Maker</h1>
        <p>Text prompts aur multi-image references se fast, sharp, provider-backed cinematic videos generate karein. Free users ko roz 8 videos milti hain; 00:00 UTC par credits refresh ho jaate hain.</p>
      </div>
      <div class="credit"><b>⚡</b><span>${state.wallet?.credits ?? '—'}</span><small>/ ${dailyCredits} ${state.wallet?.plan ?? 'free'} credits today</small></div>
    </section>
    <form class="studio" id="studio">
      <div class="panel wide">
        <label>Production prompt</label>
        <textarea name="prompt" minlength="12">${escapeHtml(samplePrompt)}</textarea>
        <label>Accuracy guard / negative prompt</label>
        <input name="negativePrompt" value="${escapeHtml(sampleNegative)}" />
      </div>
      <div class="panel">
        <label>Generation mode</label>
        <div class="tabs"><button type="button" data-mode="text" class="${state.mode === 'text' ? 'active' : ''}">Text video</button><button type="button" data-mode="image" class="${state.mode === 'image' ? 'active' : ''}">Image reference</button></div>
        <input type="hidden" name="mode" value="${state.mode}" />
        <label>Reference images</label>
        <div class="drop">▧<input id="refs" type="file" accept="image/*" multiple /><span>Upload up to 6 images</span></div>
        <div class="thumbs">${state.files.map((file, i) => `<img src="${URL.createObjectURL(file)}" alt="Reference ${i + 1}" />`).join('')}</div>
      </div>
      <div class="panel controls">
        <label>Duration</label><select name="duration"><option>5</option><option>10</option></select>
        <label>Aspect ratio</label><select name="aspectRatio"><option>16:9</option><option>9:16</option><option>1:1</option></select>
        <button class="generate" ${state.busy ? 'disabled' : ''}>${state.busy ? '⏳ Rendering...' : '🎬 Generate real video'}</button>
      </div>
    </form>
    <section class="setup panel">
      <h2>Connect API from phone/browser</h2>
      <p>Status: ${state.settings?.replicateConfigured ? `Connected (${escapeHtml(state.settings.replicateTokenPreview)})` : 'Not connected'} · Browser setup: ${state.settings?.setupEnabled ? 'Enabled' : 'Disabled'}</p>
      <form id="settings">
        <input name="replicateToken" placeholder="Replicate API token: r8_..." autocomplete="off" />
        <input name="adminPin" placeholder="Admin PIN, if configured" autocomplete="off" />
        <input name="model" placeholder="Model slug/version, optional" value="${escapeHtml(state.settings?.model || '')}" />
        <button type="submit">Save API</button>
      </form>
    </section>
    <section class="upgrade panel">
      <h2>Need more than 8 videos?</h2>
      <p>Upgrade code daalein aur pro daily credits unlock karein. Agar upgrade configured nahi hai, app clearly bata dega.</p>
      <form id="upgrade"><input name="code" placeholder="Upgrade access code" /><button type="submit">Upgrade</button></form>
    </section>
    ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    ${state.job ? `<section class="result"><h2>Generation status: ${escapeHtml(state.job.prediction?.status)}</h2>${output ? `<video controls src="${escapeHtml(output)}"></video>` : '<p>Rendering in progress. This panel auto-refreshes every few seconds.</p>'}</section>` : ''}`;
  bind();
}

function bind() {
  document.getElementById('refs').addEventListener('change', (event) => { state.files = [...event.target.files].slice(0, 6); render(); });
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => { state.mode = button.dataset.mode; render(); }));
  document.getElementById('studio').addEventListener('submit', generate);
  document.getElementById('settings').addEventListener('submit', saveSettings);
  document.getElementById('upgrade').addEventListener('submit', upgrade);
}

async function refreshCredits() {
  const [creditsRes, settingsRes] = await Promise.all([
    fetch(`${API}/api/credits`, { headers: { 'x-client-id': clientId } }),
    fetch(`${API}/api/settings`, { headers: { 'x-client-id': clientId } }),
  ]);
  state.wallet = await creditsRes.json();
  state.settings = await settingsRes.json();
  render();
}

async function generate(event) {
  event.preventDefault();
  state.busy = true; state.error = ''; state.job = null; render();
  const form = new FormData(event.currentTarget);
  state.files.forEach((file) => form.append('references', file));
  const res = await fetch(`${API}/api/generate-video`, { method: 'POST', headers: { 'x-client-id': clientId }, body: form });
  const data = await res.json();
  state.busy = false;
  if (!res.ok) state.error = data.error || 'Generation failed';
  else { state.wallet = data.wallet; state.job = data; pollJob(data.jobId); }
  render();
}

async function saveSettings(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries([...form.entries()].filter(([, value]) => String(value).trim()));
  const res = await fetch(`${API}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-client-id': clientId }, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) state.error = data.error || 'Settings save failed';
  else { state.error = ''; state.settings = data; }
  render();
}

async function upgrade(event) {
  event.preventDefault();
  const code = new FormData(event.currentTarget).get('code');
  const res = await fetch(`${API}/api/upgrade`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-client-id': clientId }, body: JSON.stringify({ code }) });
  const data = await res.json();
  if (!res.ok) state.error = data.error || 'Upgrade failed';
  else { state.error = ''; state.wallet = data; }
  render();
}

function pollJob(jobId) {
  const timer = setInterval(async () => {
    const res = await fetch(`${API}/api/jobs/${jobId}`, { headers: { 'x-client-id': clientId } });
    const data = await res.json();
    if (res.ok) {
      state.job = { jobId, ...data };
      render();
      if (['succeeded', 'failed', 'canceled'].includes(data.prediction?.status)) clearInterval(timer);
    }
  }, 3500);
}

render();
refreshCredits();

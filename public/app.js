// Shared helpers for every page.

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode: keep going without persistence */
    }
  },
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const $ = (sel, root = document) => root.querySelector(sel);

function codeFromPath() {
  const m = location.pathname.match(/^\/s\/([A-Za-z0-9]{6})/);
  return m ? m[1].toUpperCase() : null;
}

// Anonymous id for this browser, used for one-vote-per-person.
const voterId = (() => {
  let v = store.get('sorak:voter');
  if (!v) {
    // getRandomValues (unlike randomUUID) also works on plain-HTTP origins.
    v = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    store.set('sorak:voter', v);
  }
  return v;
})();

function hostKey(code) {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('key');
  if (fromHash) {
    const keys = store.get('sorak:hostKeys', {});
    keys[code] = fromHash;
    store.set('sorak:hostKeys', keys);
    return fromHash;
  }
  return store.get('sorak:hostKeys', {})[code] || null;
}

async function api(method, path, body, { key } = {}) {
  const headers = { 'X-Voter-Id': voterId };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `request failed (${res.status})`), { status: res.status });
  return data;
}

// Subscribes to a session's live state. EventSource reconnects on its own,
// including to a different replica after a deploy.
function live(code, onState, statusEl) {
  const es = new EventSource(`/api/sessions/${code}/events`);
  const setStatus = (on) => {
    if (!statusEl) return;
    statusEl.classList.toggle('live', on);
    statusEl.textContent = on ? 'Live' : 'Reconnecting…';
  };
  es.onopen = () => setStatus(true);
  es.onerror = () => setStatus(false);
  es.onmessage = (e) => {
    setStatus(true);
    onState(JSON.parse(e.data));
  };
  return es;
}

let toastTimer;
function toast(msg) {
  let el = $('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

// Renders a poll's options. With `onVote`, options are buttons; results
// show once `reveal` is true.
function renderOptions(poll, { mine, reveal, onVote }) {
  return poll.options
    .map((o) => {
      const p = pct(o.votes, poll.total);
      const disabled = !onVote || poll.closed ? 'disabled' : '';
      return `<button class="option ${mine === o.id ? 'mine' : ''}" data-option="${o.id}" ${disabled}>
        <span class="fill" style="width:${reveal ? p : 0}%"></span>
        <span class="label">${esc(o.label)}</span>
        <span class="pct">${reveal ? `${p}%` : ''}</span>
      </button>`;
    })
    .join('');
}

function renderQuestion(q, { upvoted, interactive, actions = '' }) {
  return `<li class="q ${q.answered ? 'answered' : ''}">
    <button class="upvote ${upvoted ? 'on' : ''}" data-upvote="${q.id}" ${interactive ? '' : 'disabled'}
      aria-label="Upvote (${q.votes})">${q.votes}</button>
    <div class="q-body">
      <div>${esc(q.body)}${q.answered ? '<span class="tag good">Answered</span>' : ''}${q.hidden ? '<span class="tag">Hidden</span>' : ''}</div>
      <div class="q-author">${q.author ? esc(q.author) : 'Anonymous'}</div>
      ${actions}
    </div>
  </li>`;
}

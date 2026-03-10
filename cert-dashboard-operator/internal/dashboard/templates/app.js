// Certificate Dashboard — Frontend Logic

const container = document.getElementById('certs-container');
const loading = document.getElementById('loading');
const modal = document.getElementById('renew-modal');
const modalCertName = document.getElementById('modal-cert-name');
const modalCertNs = document.getElementById('modal-cert-ns');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');
const modalToken = document.getElementById('modal-token');
const tokenError = document.getElementById('token-error');
const copyCmd = document.getElementById('copy-cmd');
const toggleToken = document.getElementById('toggle-token');

let pendingRenew = null;

// ─── Token field helpers ────────────────────────────────────────────────

copyCmd.addEventListener('click', async () => {
  const cmd = document.getElementById('token-cmd').textContent;
  const copyIcon = document.getElementById('copy-icon');
  const checkIcon = document.getElementById('check-icon');

  try {
    await navigator.clipboard.writeText(cmd);
  } catch {
    // Fallback for non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = cmd;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }

  // Show checkmark icon briefly
  copyIcon.style.display = 'none';
  checkIcon.style.display = 'block';
  copyCmd.classList.add('copied');
  setTimeout(() => {
    checkIcon.style.display = 'none';
    copyIcon.style.display = 'block';
    copyCmd.classList.remove('copied');
  }, 2000);
});

toggleToken.addEventListener('click', () => {
  if (modalToken.type === 'password') {
    modalToken.type = 'text';
    toggleToken.textContent = 'Hide';
  } else {
    modalToken.type = 'password';
    toggleToken.textContent = 'Show';
  }
});

modalToken.addEventListener('input', () => {
  // Clear error state when user types
  modalToken.classList.remove('invalid');
  tokenError.hidden = true;
});

// ─── Fetch & Render ─────────────────────────────────────────────────────

async function fetchCerts() {
  try {
    const res = await fetch('/api/certs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('Failed to fetch certs:', err);
    return null;
  }
}

function renderCerts(certs) {
  loading.style.display = 'none';
  if (!certs || certs.length === 0) {
    container.innerHTML = '<div class="loading">No certificates found.</div>';
    return;
  }

  container.innerHTML = certs.map(cert => renderCard(cert)).join('');

  // Attach event listeners to renew buttons
  document.querySelectorAll('.btn-renew').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingRenew = { name: btn.dataset.name, namespace: btn.dataset.ns };
      modalCertName.textContent = btn.dataset.name;
      modalCertNs.textContent = btn.dataset.ns;
      // Reset token field state
      modalToken.value = '';
      modalToken.type = 'password';
      toggleToken.textContent = 'Show';
      modalToken.classList.remove('invalid');
      tokenError.hidden = true;
      modal.showModal();
      modalToken.focus();
    });
  });
}

function renderCard(cert) {
  const progressPct = cert.daysTotal > 0
    ? Math.max(0, Math.min(100, (cert.daysRemaining / cert.daysTotal) * 100))
    : 100;

  const readyClass = cert.ready ? 'is-ready' : 'not-ready';
  const readyText = cert.ready ? 'Ready' : 'Not Ready';
  const caLabel = cert.isCA ? '<span class="cert-ca-badge">CA</span>' : '';

  return `
    <div class="cert-card" id="card-${cert.namespace}-${cert.name}">
      <div class="cert-header">
        <div>
          <span class="cert-title">${esc(cert.name)}</span>
          <span class="cert-namespace">${esc(cert.namespace)}</span>
          ${caLabel}
        </div>
        <span class="cert-ready ${readyClass}">
          <span class="dot"></span> ${readyText}
        </span>
      </div>

      <div class="cert-details">
        <div class="detail-item">
          <div class="detail-label">Issuer</div>
          <div class="detail-value">${esc(cert.issuer)} (${esc(cert.issuerKind)})</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">DNS Names</div>
          <div class="detail-value">${(cert.dnsNames || []).map(esc).join(', ') || '—'}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">IP Addresses</div>
          <div class="detail-value">${(cert.ipAddresses || []).map(esc).join(', ') || '—'}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Algorithm</div>
          <div class="detail-value">${esc(cert.algorithm || '—')}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Serial Number</div>
          <div class="detail-value">${esc(cert.serialNumber || '—')}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Duration / Renew Before</div>
          <div class="detail-value">${esc(cert.duration || '—')} / ${esc(cert.renewBefore || '—')}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Not Before</div>
          <div class="detail-value">${formatDate(cert.notBefore)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Not After (Expiry)</div>
          <div class="detail-value">${formatDate(cert.notAfter)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Renewal Time</div>
          <div class="detail-value">${formatDate(cert.renewalTime)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Revision</div>
          <div class="detail-value">${cert.revision || '—'}</div>
        </div>
      </div>

      <div class="progress-section">
        <div class="progress-header">
          <span class="progress-label">Certificate Lifetime</span>
          <span class="progress-days ${cert.status}">${cert.daysRemaining} days remaining</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${cert.status}" style="width: ${progressPct}%"></div>
        </div>
      </div>

      <div class="cert-actions">
        <button class="btn btn-primary btn-renew"
                data-name="${esc(cert.name)}"
                data-ns="${esc(cert.namespace)}"
                ${!cert.ready ? 'disabled' : ''}>
          Renew Certificate
        </button>
      </div>

      <div class="sse-panel" id="sse-${cert.namespace}-${cert.name}"></div>
    </div>
  `;
}

// ─── Modal ──────────────────────────────────────────────────────────────

modalCancel.addEventListener('click', () => {
  modal.close();
  pendingRenew = null;
  modalToken.value = '';
});

modal.addEventListener('close', () => {
  pendingRenew = null;
  modalToken.value = '';
});

modalConfirm.addEventListener('click', async () => {
  if (!pendingRenew) return;

  const token = modalToken.value.trim();
  if (!token) {
    modalToken.classList.add('invalid');
    tokenError.hidden = false;
    modalToken.focus();
    return;
  }

  const { name, namespace } = pendingRenew;
  modal.close();

  const card = document.getElementById(`card-${namespace}-${name}`);
  const btn = card?.querySelector('.btn-renew');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/renew', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ name, namespace }),
    });

    if (!res.ok) {
      let errMsg = res.statusText;
      try {
        const err = await res.json();
        errMsg = err.error || errMsg;
      } catch { /* non-JSON error body */ }
      alert(`Renewal failed: ${errMsg}`);
      if (btn) btn.disabled = false;
      return;
    }

    const { streamId } = await res.json();
    startSSE(name, namespace, streamId);
  } catch (err) {
    alert(`Renewal request failed: ${err.message}`);
    if (btn) btn.disabled = false;
  }
});

// ─── SSE ────────────────────────────────────────────────────────────────

function startSSE(name, namespace, streamId) {
  const panel = document.getElementById(`sse-${namespace}-${name}`);
  if (!panel) return;

  panel.classList.add('active');
  panel.innerHTML = '<div class="sse-message"><span class="sse-spinner"></span> Starting renewal...</div>';

  const source = new EventSource(`/api/sse/${streamId}`);

  source.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    const phaseClass = data.phase ? `phase-${data.phase}` : '';
    const spinner = data.phase !== 'ready' && data.phase !== 'error' ? '<span class="sse-spinner"></span> ' : '';
    panel.innerHTML += `<div class="sse-message ${phaseClass}">${spinner}${esc(data.message)}</div>`;
    panel.scrollTop = panel.scrollHeight;
  });

  source.addEventListener('complete', (e) => {
    const data = JSON.parse(e.data);
    const color = data.done ? 'phase-ready' : 'phase-error';
    panel.innerHTML += `<div class="sse-message ${color}">${esc(data.message)}</div>`;
    source.close();

    // Re-fetch certificates after renewal (delay to allow UI assertions)
    setTimeout(async () => {
      const certs = await fetchCerts();
      if (certs) renderCerts(certs);
    }, 10000);
  });

  source.onerror = () => {
    panel.innerHTML += '<div class="sse-message phase-error">SSE connection lost.</div>';
    source.close();
    const btn = document.querySelector(`[data-name="${name}"][data-ns="${namespace}"]`);
    if (btn) btn.disabled = false;
  };
}

// ─── Utilities ──────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
    });
  } catch {
    return iso;
  }
}

// ─── Init & Auto-refresh ────────────────────────────────────────────────

async function init() {
  const certs = await fetchCerts();
  if (certs) renderCerts(certs);
  else loading.textContent = 'Failed to load certificates.';
}

init();
setInterval(async () => {
  const certs = await fetchCerts();
  // Only re-render if no SSE panel is active (avoid disrupting renewal view)
  if (certs && !document.querySelector('.sse-panel.active')) {
    renderCerts(certs);
  }
}, 30000);

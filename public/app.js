// ── Helpers ───────────────────────────────────────────────────────────────────
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let flightsById = {};

// ── API ───────────────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

// ── App ───────────────────────────────────────────────────────────────────────
function initApp() {
  // ── Add flight form ────────────────────────────────────────────────────────
  document.getElementById('addFlightForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!e.target.checkValidity()) {
      alert('Please fill in all required fields with valid data.');
      return;
    }

    // Parse origin — support comma-separated multi-airport e.g. "JFK,LGA,ISP"
    const originRaw  = document.getElementById('origin').value;
    const originList = originRaw.split(',').map(s => s.trim().toUpperCase()).filter(s => s.length >= 2 && s.length <= 4);
    if (originList.length === 0) {
      alert('Please enter at least one valid IATA airport code.');
      return;
    }
    const origin = originList.length === 1 ? originList[0] : originList;

    const destination  = document.getElementById('destination').value.toUpperCase();
    const departureDate = document.getElementById('departureDate').value;
    const returnDate    = document.getElementById('returnDate').value;

    if (returnDate && returnDate <= departureDate) {
      alert('Return date must be after departure date.');
      return;
    }

    const stopsChecked = document.querySelector('input[name="stopsPreference"]:checked');

    const flight = {
      origin,
      destination,
      departureDate,
      returnDate: returnDate || null,
      adults:             parseInt(document.getElementById('adults').value),
      children:           parseInt(document.getElementById('children').value) || 0,
      currency:           'usd',
      lastPrice:          null,
      lastChecked:        null,
      alertPercentage:    parseInt(document.getElementById('alertPercentage').value),
      flightType:         document.getElementById('flightType').value,
      stopsPreference:    stopsChecked ? stopsChecked.value : 'any',
      departureTimeStart: document.getElementById('departureTimeStart').value || null,
      departureTimeEnd:   document.getElementById('departureTimeEnd').value || null,
      maxDurationHours:   parseFloat(document.getElementById('maxDuration').value) || null,
      alertEnabled:       true
    };

    try {
      await api('POST', '/api/flights', flight);
      await refreshFlights();
      e.target.reset();
      // Restore defaults after reset
      document.getElementById('origin').value   = 'JFK,ISP,LGA';
      document.getElementById('adults').value   = '2';
      document.getElementById('children').value = '2';
      document.querySelector('input[name="stopsPreference"][value="any"]').checked = true;

      const today = new Date().toISOString().split('T')[0];
      document.getElementById('departureDate').min = today;
    } catch (err) {
      alert('Error adding flight: ' + err.message);
    }
  });

  // Uppercase destination as typed
  document.getElementById('destination').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });

  // Min date
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('departureDate').min = today;

  // Flight list: load now, then poll (prices land in the background after adds/checks)
  refreshFlights();
  setInterval(refreshFlights, 60000);

  // Close modal on backdrop click
  document.getElementById('editModal').addEventListener('click', (e) => {
    if (e.target.id === 'editModal') closeEditModal();
  });

  // Edit form submission
  document.getElementById('editFlightForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const flightId = document.getElementById('editFlightId').value;
    const stopsChecked = document.querySelector('input[name="editStopsPreference"]:checked');

    const updates = {
      alertPercentage:    parseInt(document.getElementById('editAlertPercentage').value),
      flightType:         document.getElementById('editFlightType').value,
      alertEnabled:       document.getElementById('editAlertEnabled').checked,
      stopsPreference:    stopsChecked ? stopsChecked.value : 'any',
      departureTimeStart: document.getElementById('editDepartureTimeStart').value || null,
      departureTimeEnd:   document.getElementById('editDepartureTimeEnd').value || null,
      maxDurationHours:   parseFloat(document.getElementById('editMaxDuration').value) || null
    };

    try {
      await api('PATCH', `/api/flights/${flightId}`, updates);
      closeEditModal();
      await refreshFlights();
    } catch (err) {
      alert('Error updating flight: ' + err.message);
    }
  });
}

// ── Flight list ───────────────────────────────────────────────────────────────

let lastFlightsJson = null;

async function refreshFlights() {
  const list = document.getElementById('flightList');
  try {
    const flights = await api('GET', '/api/flights');
    const json = JSON.stringify(flights);
    if (json === lastFlightsJson) return; // nothing changed; keep charts/collapsed state
    lastFlightsJson = json;
    flightsById = Object.fromEntries(flights.map(f => [f.id, f]));

    while (list.firstChild) list.removeChild(list.firstChild);
    if (flights.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'no-history';
      empty.textContent = 'No tracked flights yet. Add one above to get started.';
      list.appendChild(empty);
      return;
    }
    for (const f of flights) {
      try {
        list.appendChild(createFlightCard(f.id, f));
      } catch (err) {
        console.error(`Failed to render flight ${f.id}:`, err);
        const errCard = document.createElement('div');
        errCard.className = 'flight-card';
        const msg = document.createElement('p');
        msg.style.cssText = 'color:var(--text-faint);padding:1rem';
        msg.textContent = `Could not display flight (${f.id}): ${err.message}`;
        errCard.appendChild(msg);
        list.appendChild(errCard);
      }
    }
  } catch (err) {
    console.error('Failed to load flights:', err);
    if (lastFlightsJson === null) {
      list.textContent = `Error loading flights: ${err.message}`;
    }
  }
}

// ── Flight card ───────────────────────────────────────────────────────────────

function createFlightCard(flightId, flight) {
  const today = new Date().toISOString().split('T')[0];
  const isExpired = flight.departureDate && flight.departureDate < today;

  const card = document.createElement('div');
  card.className = `flight-card ${!flight.alertEnabled ? 'disabled' : ''} ${isExpired ? 'expired' : ''}`;

  const trendScore = flight.trendScore || 0;

  const lastChecked = flight.lastChecked ? new Date(flight.lastChecked).toLocaleString() : 'Never';

  // Format origin display (array or string)
  const originDisplay = esc(Array.isArray(flight.origin) ? flight.origin.join(' / ') : flight.origin);
  const destination = esc(flight.destination);

  // Stops badge text
  const stopsText = {
    direct: 'NONSTOP',
    '1stop': '1 STOP MAX',
    any: 'ANY STOPS'
  }[flight.stopsPreference || 'any'] || 'ANY STOPS';

  // Best price badge (cross-source) shown on current best price row
  let vsBestBadge = '';
  const refBest  = flight.bestPrice ?? flight.bestGooglePrice ?? null;
  const refLast  = flight.lastPrice ?? flight.lastGooglePrice ?? null;
  if (refBest != null && refLast != null) {
    if (refLast <= refBest) {
      vsBestBadge = '<span class="best-price-badge best-price-new">🏆 Best</span>';
    } else {
      const abovePct = ((refLast - refBest) / refBest * 100).toFixed(1);
      vsBestBadge = `<span class="best-price-badge best-price-above">+${abovePct}% vs best</span>`;
    }
  }

  // Source badge for the last best price
  const sourceBadge = flight.lastPriceSource
    ? `<span class="price-source-badge">${esc(flight.lastPriceSource)}</span>`
    : '';

  // Filter summary for display
  const filterParts = [];
  if (flight.departureTimeStart || flight.departureTimeEnd) {
    const after  = flight.departureTimeStart || '00:00';
    const before = flight.departureTimeEnd   || '23:59';
    filterParts.push(`${after}–${before}`);
  }
  if (flight.maxDurationHours) filterParts.push(`≤${flight.maxDurationHours}h`);
  const filterSummary = filterParts.length > 0 ? filterParts.join(', ') : null;

  card.innerHTML = `
    <div class="flight-card-header">
      <div class="flight-route">
        <span>${originDisplay}</span>
        <span class="route-arrow">→</span>
        <span>${destination}</span>
      </div>
      <div class="flight-badges">
        ${isExpired
          ? '<span class="badge badge-expired">Departed</span>'
          : `<span class="badge ${flight.alertEnabled ? 'badge-active' : 'badge-paused'}">${flight.alertEnabled ? 'Active' : 'Paused'}</span>`
        }
        <span class="badge badge-stops">${stopsText}</span>
      </div>
    </div>

    <div class="flight-card-body">
      <div class="flight-details">
        <div class="detail-item">
          <span class="detail-label">Departure</span>
          <span class="detail-value">${formatDate(flight.departureDate)}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Return</span>
          <span class="detail-value">${flight.returnDate ? formatDate(flight.returnDate) : 'One-way'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Passengers</span>
          <span class="detail-value">${flight.adults} adult${flight.adults > 1 ? 's' : ''}${flight.children ? ', ' + flight.children + ' child' + (flight.children > 1 ? 'ren' : '') : ''}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Best Price</span>
          <span class="detail-value price-google">
            ${flight.lastPrice != null
              ? `$${flight.lastPrice.toFixed(0)}${sourceBadge}${vsBestBadge}`
              : '<span style="color:var(--text-faint);font-size:0.8rem;font-weight:400;">Pending</span>'}
          </span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Google Flights</span>
          <span class="detail-value price-google">
            ${flight.lastGooglePrice != null
              ? `$${flight.lastGooglePrice.toFixed(0)}${flight.lastGooglePriceLevel
                  ? `<span class="price-level-badge price-level-${esc(flight.lastGooglePriceLevel)}">${esc(flight.lastGooglePriceLevel)}</span>`
                  : ''}`
              : '<span style="color:var(--text-faint);font-size:0.8rem;font-weight:400;">—</span>'}
          </span>
        </div>
        <div class="detail-item">
          <span class="detail-label">fli Scanner</span>
          <span class="detail-value price-fli">
            ${flight.lastFliPrice != null
              ? `$${flight.lastFliPrice.toFixed(0)}`
              : '<span style="color:var(--text-faint);font-size:0.8rem;font-weight:400;">—</span>'}
          </span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Best Ever</span>
          <span class="detail-value price-best-google">
            ${(flight.bestPrice ?? flight.bestGooglePrice) != null
              ? `$${(flight.bestPrice ?? flight.bestGooglePrice).toFixed(0)}${flight.bestPriceSource ? `<span class="price-source-badge">${esc(flight.bestPriceSource)}</span>` : ''}`
              : '<span style="color:var(--text-faint);font-size:0.8rem;font-weight:400;">Pending</span>'}
          </span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Alert</span>
          <span class="detail-value">${flight.alertPercentage}% drop</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Filters</span>
          <span class="detail-value" style="font-size:0.78rem;color:var(--text-muted);">${filterSummary || 'None'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Trend</span>
          <span class="detail-value">
            <span class="${getTrendScoreClass(trendScore)}">${trendScore.toFixed(2)}</span>
          </span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Last Checked</span>
          <span class="detail-value" style="font-size:0.75rem;color:var(--text-muted);">${lastChecked}</span>
        </div>
      </div>

      <div class="chart-container" id="chart-${flightId}">
        <canvas id="canvas-${flightId}"></canvas>
      </div>

      <div class="collapsible-flights">
        <button class="collapse-toggle" onclick="toggleFlightList('${flightId}')">
          <span>Last fetched flights (${(flight.lastGoogleFlights || []).length})</span>
          <span class="collapse-arrow">›</span>
        </button>
        <div id="flights-${flightId}" class="collapse-body" hidden>
          ${renderGoogleFlightsList(flight.lastGoogleFlights || [])}
        </div>
      </div>

      <div class="flight-actions">
        <button class="btn-test" onclick="testLivePrice('${flightId}')" id="test-btn-${flightId}">
          Get Live Price
        </button>
        <button class="btn-secondary" onclick="sendTestTelegram('${flightId}')" id="telegram-btn-${flightId}">
          Test Telegram
        </button>
        <button class="btn-edit" onclick="openEditModal('${flightId}')">
          Edit
        </button>
        <button class="btn-danger" onclick="deleteFlight('${flightId}')">
          Delete
        </button>
      </div>
    </div>
  `;

  setTimeout(() => renderChart(flightId), 100);
  return card;
}

// ── Collapsible flight list ───────────────────────────────────────────────────

function toggleFlightList(flightId) {
  const body  = document.getElementById(`flights-${flightId}`);
  const arrow = body.previousElementSibling.querySelector('.collapse-arrow');
  body.hidden = !body.hidden;
  arrow.textContent = body.hidden ? '›' : '˅';
}

function renderGoogleFlightsList(flights) {
  if (!flights || flights.length === 0) {
    return '<p class="no-history" style="padding:12px;">No flight data yet — click Get Live Price.</p>';
  }
  const header = `
    <div class="gf-header">
      <span>Airline</span>
      <span>Times</span>
      <span>Duration</span>
      <span>Stops</span>
      <span>Price</span>
    </div>`;
  const rows = flights.map(f => `
    <div class="gf-row${f.is_best ? ' gf-best' : ''}">
      <span class="gf-airline">${esc(f.airline)}</span>
      <span class="gf-time">${f.departure} → ${esc(f.arrival)}</span>
      <span class="gf-duration">${esc(f.duration)}</span>
      <span class="gf-stops">${f.stops === 0 ? 'Nonstop' : f.stops + ' stop' + (f.stops > 1 ? 's' : '')}</span>
      <span class="gf-price">${esc(f.price)}</span>
    </div>
  `).join('');
  return header + rows;
}

// ── Live price ────────────────────────────────────────────────────────────────

async function testLivePrice(flightId) {
  const btn = document.getElementById(`test-btn-${flightId}`);
  btn.disabled = true;
  btn.textContent = 'Fetching...';

  try {
    const data = await api('POST', `/api/flights/${flightId}/live-price`);

    if (!data.success && data.noData) {
      alert(`⚠️ No price data available\n\n${data.flight.origin} → ${data.flight.destination}\n\n${data.reason}`);
      return;
    }

    const { googlePrice, googlePriceLevel, fliPrice, currency, flight } = data;
    const originDisplay = Array.isArray(flight.origin) ? flight.origin.join('/') : flight.origin;

    const googleLine = googlePrice != null
      ? `✈ Google Flights:  ${googlePrice.toFixed(2)} ${currency || 'USD'}${googlePriceLevel ? ' (' + googlePriceLevel + ')' : ''}`
      : 'Google Flights: n/a';
    const cheapLine = fliPrice != null
      ? `🔍 fli Scanner:     ${fliPrice.toFixed(2)} ${currency || 'USD'}`
      : 'fli Scanner: n/a';

    alert(`Live Prices Fetched!\n\n${originDisplay} → ${flight.destination}\n\n${googleLine}\n${cheapLine}`);
    await refreshFlights();
  } catch (err) {
    alert(`Error fetching price: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Get Live Price';
  }
}

// ── Test Telegram ─────────────────────────────────────────────────────────────

async function sendTestTelegram(flightId) {
  const btn = document.getElementById(`telegram-btn-${flightId}`);
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    await api('POST', `/api/flights/${flightId}/test-telegram`);
    btn.textContent = '✓ Sent!';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = 'Test Telegram';
    }, 3000);
  } catch (err) {
    alert(`Error sending Telegram: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Test Telegram';
  }
}

// ── Trend score ───────────────────────────────────────────────────────────────

function getTrendScoreClass(score) {
  if (score < 1) return 'trend-score low';
  if (score < 2) return 'trend-score medium';
  return 'trend-score high';
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatDate(dateString) {
  const date = new Date(dateString + 'T00:00:00');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Chart ─────────────────────────────────────────────────────────────────────

let chartInstances = {};

async function renderChart(flightId) {
  try {
    const rows = await api('GET', `/api/flights/${flightId}/history`);

    const canvas    = document.getElementById(`canvas-${flightId}`);
    const container = document.getElementById(`chart-${flightId}`);

    if (!canvas || !container) return;

    if (rows.length === 0) {
      container.innerHTML = '<div class="no-history">No price history yet. Prices are checked 3× daily.</div>';
      return;
    }

    const labels = rows.map(d => {
      const date = new Date(d.checkedAt);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit' });
    });

    const googleData = rows.map(d => d.googlePrice ?? null);

    const hasGoogleData = googleData.some(v => v !== null);

    if (chartInstances[flightId]) {
      chartInstances[flightId].destroy();
    }

    const datasets = [];

    if (hasGoogleData) {
      datasets.push({
        label: 'Google Flights',
        data: googleData,
        borderColor: '#0d652d',
        backgroundColor: 'rgba(13, 101, 45, 0.07)',
        borderWidth: 2.5,
        fill: true,
        tension: 0.4,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: '#0d652d',
        pointBorderColor: '#ffffff',
        spanGaps: true,
        order: 1
      });
    }

    chartInstances[flightId] = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            display: false,
            labels: { color: '#5f6368', font: { size: 11 } }
          },
          tooltip: {
            backgroundColor: '#202124',
            titleColor: '#ffffff',
            bodyColor: '#dadce0',
            borderColor: '#5f6368',
            borderWidth: 1,
            callbacks: {
              label: function(context) {
                const val = context.parsed.y;
                return val != null ? `${context.dataset.label}: $${val.toFixed(2)}` : `${context.dataset.label}: n/a`;
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: false,
            grid: { color: '#f1f3f4' },
            ticks: { color: '#5f6368', callback: v => '$' + v.toFixed(0) }
          },
          x: {
            grid: { color: '#f1f3f4' },
            ticks: { color: '#5f6368', maxRotation: 45, minRotation: 45 }
          }
        }
      }
    });
  } catch (err) {
    const container = document.getElementById(`chart-${flightId}`);
    if (container) container.innerHTML = '<div class="no-history">Error loading price history.</div>';
  }
}

// ── Edit modal ────────────────────────────────────────────────────────────────

function openEditModal(flightId) {
  const flight = flightsById[flightId];
  document.getElementById('editFlightId').value           = flightId;
  document.getElementById('editAlertPercentage').value    = flight.alertPercentage;
  document.getElementById('editFlightType').value         = flight.flightType || 'any';
  document.getElementById('editAlertEnabled').checked     = flight.alertEnabled;
  document.getElementById('editDepartureTimeStart').value = flight.departureTimeStart || '';
  document.getElementById('editDepartureTimeEnd').value   = flight.departureTimeEnd || '';
  document.getElementById('editMaxDuration').value        = flight.maxDurationHours || '';

  const stopsVal = flight.stopsPreference || 'any';
  const stopsRadio = document.querySelector(`input[name="editStopsPreference"][value="${stopsVal}"]`);
  if (stopsRadio) stopsRadio.checked = true;

  document.getElementById('editModal').classList.add('active');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('active');
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function deleteFlight(flightId) {
  const f = flightsById[flightId] || {};
  const origin = Array.isArray(f.origin) ? f.origin.join('/') : f.origin;
  if (!confirm(`Delete flight ${origin} → ${f.destination}?`)) return;

  try {
    await api('DELETE', `/api/flights/${flightId}`);
    await refreshFlights();
  } catch (err) {
    alert('Error deleting flight: ' + err.message);
  }
}

initApp();

// ── Auth gate ─────────────────────────────────────────────────────────────────
const OWNER_EMAIL = 'ilan.dee@gmail.com';

let appInitialised = false;

auth.onAuthStateChanged(user => {
  const loginScreen = document.getElementById('loginScreen');
  const loginError  = document.getElementById('loginError');
  const app         = document.getElementById('app');
  const avatar      = document.getElementById('userAvatar');

  console.log('[Auth] state changed. user:', user ? `${user.email} (uid: ${user.uid})` : 'null');

  if (!user) {
    // Not signed in — show login, clear error
    loginScreen.style.display = 'flex';
    if (loginError) loginError.style.display = 'none';
    app.style.display = 'none';
    return;
  }

  const emailMatch = user.email && user.email.toLowerCase().trim() === OWNER_EMAIL.toLowerCase().trim();
  console.log('[Auth] email check:', user.email, '===', OWNER_EMAIL, '->', emailMatch);

  if (!emailMatch) {
    // Wrong account — sign out immediately and show error
    console.warn('[Auth] Unauthorised email, signing out:', user.email);
    auth.signOut();
    loginScreen.style.display = 'flex';
    if (loginError) loginError.style.display = 'block';
    app.style.display = 'none';
    return;
  }

  // Authorised
  loginScreen.style.display = 'none';
  if (loginError) loginError.style.display = 'none';
  app.style.display = 'flex';

  // Show avatar if available
  if (avatar && user.photoURL) {
    avatar.src = user.photoURL;
    avatar.style.display = 'block';
  }

  if (!appInitialised) {
    appInitialised = true;
    initApp();
  }
});

document.getElementById('googleSignInBtn').addEventListener('click', () => {
  const loginError = document.getElementById('loginError');
  if (loginError) loginError.style.display = 'none';
  auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(err => {
    alert('Sign-in failed: ' + err.message);
  });
});

document.getElementById('signOutBtn').addEventListener('click', () => {
  auth.signOut();
});

// ── App ───────────────────────────────────────────────────────────────────────
const TELEGRAM_CHAT_ID = '1304208404';

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
      telegramChatId:     TELEGRAM_CHAT_ID,
      alertEnabled:       true
    };

    try {
      await db.collection('trackedFlights').add(flight);
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

  // Real-time flight list
  db.collection('trackedFlights').onSnapshot(async (snapshot) => {
    const list = document.getElementById('flightList');

    if (snapshot.empty) {
      list.innerHTML = '<div class="no-history">No tracked flights yet. Add one above to get started.</div>';
      return;
    }

    list.innerHTML = '';

    for (const doc of snapshot.docs) {
      const flight = doc.data();
      const card = await createFlightCard(doc.id, flight);
      list.appendChild(card);
    }
  });

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
      await db.collection('trackedFlights').doc(flightId).update(updates);
      closeEditModal();
    } catch (err) {
      alert('Error updating flight: ' + err.message);
    }
  });
}

// ── Flight card ───────────────────────────────────────────────────────────────

async function createFlightCard(flightId, flight) {
  const today = new Date().toISOString().split('T')[0];
  const isExpired = flight.departureDate && flight.departureDate < today;

  const card = document.createElement('div');
  card.className = `flight-card ${!flight.alertEnabled ? 'disabled' : ''} ${isExpired ? 'expired' : ''}`;

  const trendScore = await computePriceTrend(flightId);

  const lastChecked = flight.lastChecked
    ? new Date(flight.lastChecked.toDate()).toLocaleString()
    : 'Never';

  // Format origin display (array or string)
  const originDisplay = Array.isArray(flight.origin) ? flight.origin.join(' / ') : flight.origin;

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
    ? `<span class="price-source-badge">${flight.lastPriceSource}</span>`
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
        <span>${flight.destination}</span>
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
                  ? `<span class="price-level-badge price-level-${flight.lastGooglePriceLevel}">${flight.lastGooglePriceLevel}</span>`
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
          <span class="detail-label">Travelpayouts</span>
          <span class="detail-value price-cached">
            ${flight.lastCheapPrice != null ? `$${flight.lastCheapPrice.toFixed(0)}` : '—'}
          </span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Best Ever</span>
          <span class="detail-value price-best-google">
            ${(flight.bestPrice ?? flight.bestGooglePrice) != null
              ? `$${(flight.bestPrice ?? flight.bestGooglePrice).toFixed(0)}${flight.bestPriceSource ? `<span class="price-source-badge">${flight.bestPriceSource}</span>` : ''}`
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
        <button class="btn-primary" onclick="openGoogleFlights('${flightId}', ${JSON.stringify(flight).replace(/"/g, '&quot;')})">
          Google Flights
        </button>
        <button class="btn-secondary" onclick="openKayak('${flightId}', ${JSON.stringify(flight).replace(/"/g, '&quot;')})">
          Kayak
        </button>
        <button class="btn-secondary" onclick="openSkyscanner('${flightId}', ${JSON.stringify(flight).replace(/"/g, '&quot;')})">
          Skyscanner
        </button>
        <button class="btn-edit" onclick="openEditModal('${flightId}', ${JSON.stringify(flight).replace(/"/g, '&quot;')})">
          Edit
        </button>
        <button class="btn-danger" onclick="deleteFlight('${flightId}', '${originDisplay}', '${flight.destination}')">
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
      <span class="gf-airline">${f.airline}</span>
      <span class="gf-time">${f.departure} → ${f.arrival}</span>
      <span class="gf-duration">${f.duration}</span>
      <span class="gf-stops">${f.stops === 0 ? 'Nonstop' : f.stops + ' stop' + (f.stops > 1 ? 's' : '')}</span>
      <span class="gf-price">${f.price}</span>
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
    const getLivePrice = functions.httpsCallable('getLivePrice');
    const result = await getLivePrice({ flightId });
    const data = result.data;

    if (!data.success && data.noData) {
      alert(`⚠️ No price data available\n\n${data.flight.origin} → ${data.flight.destination}\n\n${data.reason}`);
      return;
    }

    const { googlePrice, googlePriceLevel, cheapPrice, currency, flight } = data;
    const originDisplay = Array.isArray(flight.origin) ? flight.origin.join('/') : flight.origin;

    const googleLine = googlePrice != null
      ? `✈ Google Flights:  ${googlePrice.toFixed(2)} ${currency || 'USD'}${googlePriceLevel ? ' (' + googlePriceLevel + ')' : ''}`
      : 'Google Flights: n/a';
    const cheapLine = cheapPrice != null
      ? `Best cached:       ${cheapPrice.toFixed(2)} ${currency || 'USD'}`
      : 'Best cached: n/a';

    alert(`Live Prices Fetched!\n\n${originDisplay} → ${flight.destination}\n\n${googleLine}\n${cheapLine}`);
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
    const sendTest = functions.httpsCallable('sendTestTelegram');
    await sendTest({ flightId });
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

// ── Booking links ─────────────────────────────────────────────────────────────

function openGoogleFlights(flightId, flight) {
  const adults   = flight.adults || 1;
  const children = flight.children || 0;
  // Use first origin if array
  const orig = Array.isArray(flight.origin) ? flight.origin[0] : flight.origin;
  let url;
  if (flight.returnDate) {
    url = `https://www.google.com/travel/flights?q=flights%20from%20${orig}%20to%20${flight.destination}%20on%20${flight.departureDate}%20return%20${flight.returnDate}%20${adults}%20adult${adults > 1 ? 's' : ''}${children > 0 ? '%20' + children + '%20child' + (children > 1 ? 'ren' : '') : ''}`;
  } else {
    url = `https://www.google.com/travel/flights?q=flights%20from%20${orig}%20to%20${flight.destination}%20on%20${flight.departureDate}%20${adults}%20adult${adults > 1 ? 's' : ''}${children > 0 ? '%20' + children + '%20child' + (children > 1 ? 'ren' : '') : ''}`;
  }
  window.open(url, '_blank');
}

function openKayak(flightId, flight) {
  const orig = Array.isArray(flight.origin) ? flight.origin[0] : flight.origin;
  const passengers = (flight.adults || 1) + (flight.children || 0);
  const url = `https://www.kayak.com/flights/${orig}-${flight.destination}/${flight.departureDate}${flight.returnDate ? '/' + flight.returnDate : ''}/${passengers}adults`;
  window.open(url, '_blank');
}

function openSkyscanner(flightId, flight) {
  const orig = Array.isArray(flight.origin) ? flight.origin[0] : flight.origin;
  const returnDate = flight.returnDate || '';
  const url = `https://www.skyscanner.com/transport/flights/${orig}/${flight.destination}/${flight.departureDate.replace(/-/g, '')}${returnDate ? '/' + returnDate.replace(/-/g, '') : ''}?adults=${flight.adults}&children=${flight.children || 0}&cabinclass=economy`;
  window.open(url, '_blank');
}

// ── Trend score ───────────────────────────────────────────────────────────────

async function computePriceTrend(flightId) {
  try {
    const snapshot = await db.collection('priceHistory')
      .where('flightId', '==', flightId)
      .orderBy('checkedAt', 'desc')
      .limit(20)
      .get();

    const prices = snapshot.docs.map(d => d.data().price);
    if (prices.length < 5) return 0;

    const historicalPrices = prices.slice(1);
    if (historicalPrices.length === 0) return 0;

    const mean = historicalPrices.reduce((a, b) => a + b, 0) / historicalPrices.length;
    const variance = historicalPrices.map(p => Math.pow(p - mean, 2)).reduce((a, b) => a + b, 0) / historicalPrices.length;
    const std = Math.sqrt(variance);
    if (std === 0) return 0;

    return Math.abs((prices[0] - mean) / std);
  } catch (err) {
    return 0;
  }
}

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
    const snapshot = await db.collection('priceHistory')
      .where('flightId', '==', flightId)
      .orderBy('checkedAt', 'asc')
      .get();

    const canvas    = document.getElementById(`canvas-${flightId}`);
    const container = document.getElementById(`chart-${flightId}`);

    if (!canvas || !container) return;

    if (snapshot.empty) {
      container.innerHTML = '<div class="no-history">No price history yet. Prices are checked 3× daily.</div>';
      return;
    }

    const labels = snapshot.docs.map(d => {
      const date = d.data().checkedAt.toDate();
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit' });
    });

    const googleData = snapshot.docs.map(d => d.data().googlePrice ?? null);
    const cheapData  = snapshot.docs.map(d => d.data().cheapPrice ?? null);

    const hasGoogleData = googleData.some(v => v !== null);
    const hasCheapData  = cheapData.some(v => v !== null);

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

    if (hasCheapData) {
      datasets.push({
        label: 'Best Cached',
        data: cheapData,
        borderColor: '#f9ab00',
        backgroundColor: 'rgba(249, 171, 0, 0.04)',
        borderWidth: 2,
        borderDash: [5, 3],
        fill: false,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBackgroundColor: '#f9ab00',
        pointBorderColor: '#ffffff',
        spanGaps: true,
        order: 2
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
            display: hasGoogleData && hasCheapData,
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

function openEditModal(flightId, flight) {
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

async function deleteFlight(flightId, origin, destination) {
  if (!confirm(`Delete flight ${origin} → ${destination}?`)) return;

  try {
    await db.collection('trackedFlights').doc(flightId).delete();
  } catch (err) {
    alert('Error deleting flight: ' + err.message);
  }
}

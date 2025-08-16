/*
 * main.ts
 *
 * Entry point for the transport log PWA. This module coordinates
 * interactions between the UI, the database, geolocation tracking,
 * and optional AI assistance. It renders a simple interface for
 * starting and ending drive sessions, recording breaks and fuel
 * stops, and viewing past logs. Data is persisted locally via
 * IndexedDB and synchronised with a remote Google Apps Script when
 * network connectivity is available.
 */

import { saveLog, getAllLogs, getPendingLogs, clearPendingLogs, LogRecord } from './db';
import { watchPosition, clearWatch, haversineDistance, Coordinate } from './geo';
import { loadConfig, parseNaturalLog, summarizeLogs } from './ai';

// Application state for the current driving session
interface SessionState {
  startTime: number;
  startCoord?: Coordinate;
  coords: Coordinate[];
  distance: number;
  breaks: Array<{ start: number; end?: number }>;
  fuelLogs: Array<{ time: number; amount: number; cost?: number }>;
  watchId?: number;
}

let currentSession: SessionState | null = null;
let appConfig: { SHEETS_WEBAPP_URL?: string; OPENAI_API_KEY?: string } = {};

/**
 * Entry point: load configuration and render the UI. We await
 * configuration as early as possible so that dependent features (e.g.
 * AI) know whether to show or hide their UI. After loading config
 * the history is rendered and event listeners are attached.
 */
async function init() {
  appConfig = await loadConfig();
  render();
  // Attach online/offline handlers to update the UI and sync pending
  window.addEventListener('online', () => {
    updateOnlineStatus();
    sendPendingIfOnline();
  });
  window.addEventListener('offline', updateOnlineStatus);
  // Attempt to send any pending logs on startup
  sendPendingIfOnline();
}

/**
 * Update the visibility of the offline banner based on navigator.onLine.
 */
function updateOnlineStatus() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  if (navigator.onLine) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
  }
}

/**
 * Render the entire application based on the current session state.
 * If no session is active, display the dashboard with a start button
 * and history; if a session is active, show live tracking controls.
 */
async function render() {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = '';
  updateOnlineStatus();
  if (currentSession) {
    root.appendChild(renderActiveSession());
  } else {
    root.appendChild(await renderDashboard());
  }
}

/**
 * Render the dashboard view shown when no session is in progress. It
 * includes a button to start a new session, a list of past logs, and
 * optional AI-assisted tools when enabled.
 */
async function renderDashboard(): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.className = 'space-y-4';

  // Start session section
  const startSection = document.createElement('div');
  startSection.className = 'bg-white p-4 rounded shadow';
  const startButton = document.createElement('button');
  startButton.className = 'w-full bg-blue-600 text-white py-3 rounded disabled:opacity-50';
  startButton.textContent = '走行開始';
  startButton.onclick = () => startSession();
  startSection.appendChild(startButton);
  container.appendChild(startSection);

  // History section
  const historySection = document.createElement('div');
  historySection.className = 'bg-white p-4 rounded shadow';
  const hHeader = document.createElement('h2');
  hHeader.className = 'text-lg font-semibold mb-2';
  hHeader.textContent = '過去の走行ログ';
  historySection.appendChild(hHeader);
  const logs = await getAllLogs();
  if (logs.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'まだログはありません。';
    historySection.appendChild(p);
  } else {
    const ul = document.createElement('ul');
    ul.className = 'divide-y';
    logs.sort((a, b) => (a.date < b.date ? 1 : -1));
    for (const log of logs) {
      const li = document.createElement('li');
      li.className = 'py-2';
      li.innerHTML = `<strong>${log.date}</strong>：${log.departureName || '未設定'}→${log.arrivalName || '未設定'} / 距離 ${log.distanceKm.toFixed(1)}km`;
      ul.appendChild(li);
    }
    historySection.appendChild(ul);
  }
  container.appendChild(historySection);

  // AI assistance section (conditionally displayed)
  if (appConfig.OPENAI_API_KEY) {
    container.appendChild(renderAISection());
  }

  return container;
}

/**
 * Render a panel offering AI-assisted features: natural language log
 * parsing and log summary generation. This is only available when
 * OPENAI_API_KEY is configured.
 */
function renderAISection(): HTMLElement {
  const aiSection = document.createElement('div');
  aiSection.className = 'bg-white p-4 rounded shadow';
  const header = document.createElement('h2');
  header.className = 'text-lg font-semibold mb-2';
  header.textContent = 'AIアシスタント';
  aiSection.appendChild(header);

  // Natural language parser
  const parserContainer = document.createElement('div');
  parserContainer.className = 'space-y-2';
  const parserLabel = document.createElement('label');
  parserLabel.textContent = '自然文から運行記録を作成';
  parserContainer.appendChild(parserLabel);
  const parserInput = document.createElement('textarea');
  parserInput.className = 'w-full p-2 border rounded h-24';
  parserInput.placeholder = '例：今日は6時に札幌を出発し、12時に帯広に到着しました。途中30分休憩し、250km走行しました。100L給油しました。';
  parserContainer.appendChild(parserInput);
  const parserButton = document.createElement('button');
  parserButton.className = 'bg-green-600 text-white px-4 py-2 rounded';
  parserButton.textContent = '解析して保存';
  parserButton.onclick = async () => {
    if (!parserInput.value.trim()) return;
    parserButton.disabled = true;
    parserButton.textContent = '解析中...';
    try {
      const parsed = await parseNaturalLog(parserInput.value.trim());
      // Map parsed result to log record. We assume parsed fields are provided
      const record: LogRecord = {
        date: parsed.departureTime ? parsed.departureTime.split('T')[0] : new Date().toISOString().split('T')[0],
        departureName: parsed.departureName || '',
        arrivalName: parsed.arrivalName || '',
        departureTime: parsed.departureTime || '',
        arrivalTime: parsed.arrivalTime || '',
        drivingMinutes: parsed.drivingMinutes || 0,
        breakMinutes: parsed.breakMinutes || 0,
        distanceKm: parsed.distanceKm || 0,
        fuelLitres: parsed.fuelLitres || 0,
        fuelCost: parsed.fuelCost || 0,
        departureLat: 0,
        departureLng: 0,
        arrivalLat: 0,
        arrivalLng: 0,
        note: parsed.note || ''
      };
      // Save to DB and queue for remote; treat as complete log
      await saveLog(record, !navigator.onLine);
      await sendPendingIfOnline();
      parserInput.value = '';
      alert('解析したログを保存しました。');
      render();
    } catch (err: any) {
      alert('解析に失敗しました: ' + err.message);
    } finally {
      parserButton.disabled = false;
      parserButton.textContent = '解析して保存';
    }
  };
  parserContainer.appendChild(parserButton);
  aiSection.appendChild(parserContainer);

  // Separator
  const hr = document.createElement('hr');
  hr.className = 'my-4';
  aiSection.appendChild(hr);

  // Summary generator
  const summaryButton = document.createElement('button');
  summaryButton.className = 'bg-purple-600 text-white px-4 py-2 rounded';
  summaryButton.textContent = 'ログの要約を作成';
  summaryButton.onclick = async () => {
    summaryButton.disabled = true;
    summaryButton.textContent = '生成中...';
    try {
      const logs = await getAllLogs();
      const summary = await summarizeLogs(logs);
      alert('要約:\n' + summary);
    } catch (err: any) {
      alert('要約生成に失敗しました: ' + err.message);
    } finally {
      summaryButton.disabled = false;
      summaryButton.textContent = 'ログの要約を作成';
    }
  };
  aiSection.appendChild(summaryButton);
  return aiSection;
}

/**
 * Render the active session view. Displays current statistics and
 * provides controls to record breaks, fuel stops, and to finish the
 * session. Real-time updates are reflected as new coordinates are
 * recorded.
 */
function renderActiveSession(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'bg-white p-4 rounded shadow space-y-4';
  if (!currentSession) return container;
  // Compute elapsed time and break time
  const now = Date.now();
  const drivingMs = now - currentSession.startTime - totalBreakMs(currentSession);
  const drivingMin = Math.floor(drivingMs / 60000);
  const breakMin = Math.floor(totalBreakMs(currentSession) / 60000);
  // Header
  const header = document.createElement('h2');
  header.className = 'text-lg font-semibold';
  header.textContent = '走行中';
  container.appendChild(header);
  // Stats
  const stats = document.createElement('div');
  stats.className = 'space-y-1 text-sm';
  stats.innerHTML = `
    <div>経過時間：<strong>${formatMinutes(drivingMin)}</strong> (運転), <strong>${formatMinutes(breakMin)}</strong> (休憩)</div>
    <div>走行距離：<strong>${currentSession.distance.toFixed(2)} km</strong></div>
    <div>燃料記録：${currentSession.fuelLogs.length}回</div>
  `;
  container.appendChild(stats);
  // Break button
  const breakButton = document.createElement('button');
  const onBreak = currentSession.breaks.length > 0 && currentSession.breaks[currentSession.breaks.length - 1].end === undefined;
  breakButton.className = 'w-full py-3 rounded text-white ' + (onBreak ? 'bg-yellow-600' : 'bg-blue-600');
  breakButton.textContent = onBreak ? '休憩終了' : '休憩開始';
  breakButton.onclick = toggleBreak;
  container.appendChild(breakButton);
  // Fuel button
  const fuelButton = document.createElement('button');
  fuelButton.className = 'w-full py-3 rounded bg-green-600 text-white';
  fuelButton.textContent = '給油記録';
  fuelButton.onclick = addFuel;
  container.appendChild(fuelButton);
  // End session button
  const endButton = document.createElement('button');
  endButton.className = 'w-full py-3 rounded bg-red-600 text-white';
  endButton.textContent = '走行終了';
  endButton.onclick = endSession;
  container.appendChild(endButton);
  return container;
}

/**
 * Start a new driving session. This obtains the initial location,
 * records the start time, and begins watching the user's location.
 */
async function startSession() {
  if (currentSession) return;
  // Request current position to initialise
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude } = pos.coords;
      const coord: Coordinate = { lat: latitude, lng: longitude, timestamp: pos.timestamp };
      currentSession = {
        startTime: Date.now(),
        startCoord: coord,
        coords: [coord],
        distance: 0,
        breaks: [],
        fuelLogs: [],
        watchId: undefined
      };
      // Start watching for location updates
      const watchId = watchPosition(handleLocationUpdate, () => {});
      currentSession.watchId = watchId;
      render();
    },
    err => {
      alert('現在位置の取得に失敗しました: ' + err.message);
    },
    { enableHighAccuracy: true }
  );
}

/**
 * Handle a new geolocation update. Adds the coordinate to the
 * session's track and updates the total distance travelled.
 */
function handleLocationUpdate(coord: Coordinate) {
  if (!currentSession) return;
  const coords = currentSession.coords;
  const last = coords[coords.length - 1];
  const delta = haversineDistance(last, coord);
  // Apply a threshold to ignore GPS jitter below 50 metres
  if (delta * 1000 >= 50) {
    currentSession.distance += delta;
    currentSession.coords.push(coord);
    render();
  }
}

/**
 * Toggle break: start a new break if none is active, otherwise end
 * the current break. Breaks are recorded as start/end timestamps.
 */
function toggleBreak() {
  if (!currentSession) return;
  const breaks = currentSession.breaks;
  if (breaks.length > 0 && breaks[breaks.length - 1].end === undefined) {
    // End ongoing break
    breaks[breaks.length - 1].end = Date.now();
  } else {
    // Start new break
    breaks.push({ start: Date.now() });
  }
  render();
}

/**
 * Prompt the user to enter fuel data and record it to the session.
 */
function addFuel() {
  if (!currentSession) return;
  const amountStr = prompt('給油量 (リットル) を入力してください:', '0');
  if (!amountStr) return;
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    alert('数値を入力してください。');
    return;
  }
  const costStr = prompt('給油費用 (円) を入力してください（任意）:', '0');
  let cost = 0;
  if (costStr) {
    const c = parseFloat(costStr);
    if (!isNaN(c) && c > 0) cost = c;
  }
  currentSession.fuelLogs.push({ time: Date.now(), amount, cost });
  render();
}

/**
 * End the current session. Stops geolocation tracking, computes
 * aggregated data, prompts the user to confirm the session
 * information, and persists the log. The log is queued for
 * synchronisation if the network is unavailable.
 */
async function endSession() {
  if (!currentSession) return;
  // Stop watching position
  if (currentSession.watchId !== undefined) {
    clearWatch(currentSession.watchId);
  }
  // Get final position
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude, longitude } = pos.coords;
      const endCoord: Coordinate = { lat: latitude, lng: longitude, timestamp: pos.timestamp };
      currentSession.coords.push(endCoord);
      const totalDistance = currentSession.distance;
      const totalBreak = totalBreakMs(currentSession);
      const drivingMs = Date.now() - currentSession.startTime - totalBreak;
      const record: LogRecord = {
        date: new Date(currentSession.startTime).toISOString().split('T')[0],
        departureName: '',
        arrivalName: '',
        departureTime: new Date(currentSession.startTime).toISOString(),
        arrivalTime: new Date().toISOString(),
        drivingMinutes: Math.floor(drivingMs / 60000),
        breakMinutes: Math.floor(totalBreak / 60000),
        distanceKm: parseFloat(totalDistance.toFixed(3)),
        fuelLitres: currentSession.fuelLogs.reduce((sum, f) => sum + f.amount, 0),
        fuelCost: currentSession.fuelLogs.reduce((sum, f) => sum + (f.cost || 0), 0),
        departureLat: currentSession.startCoord ? currentSession.startCoord.lat : 0,
        departureLng: currentSession.startCoord ? currentSession.startCoord.lng : 0,
        arrivalLat: endCoord.lat,
        arrivalLng: endCoord.lng,
        note: ''
      };
      // Allow the user to enter departure/arrival names and note
      const dep = prompt('出発地名を入力してください：', '');
      if (dep !== null) record.departureName = dep;
      const arr = prompt('到着地名を入力してください：', '');
      if (arr !== null) record.arrivalName = arr;
      const note = prompt('備考や休息詳細（任意）：', '');
      if (note !== null) record.note = note;
      // Persist the log locally and queue for sync if offline
      await saveLog(record, !navigator.onLine);
      await sendPendingIfOnline();
      // Reset session state
      currentSession = null;
      render();
    },
    err => {
      alert('終了位置の取得に失敗しました: ' + err.message);
    },
    { enableHighAccuracy: true }
  );
}

/**
 * Compute the total break time in milliseconds for a session.
 */
function totalBreakMs(session: SessionState): number {
  return session.breaks.reduce((sum, b) => {
    const end = b.end || Date.now();
    return sum + (end - b.start);
  }, 0);
}

/**
 * Format minutes into HH:MM style for display.
 */
function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}時間${m}分`;
}

/**
 * Send all pending logs to the remote endpoint if online. The
 * function retrieves pending logs from the database, attempts to
 * post each one, and clears the pending store if successful. On
 * failure, logs remain queued for the next attempt. The remote URL
 * is loaded from config (SHEETS_WEBAPP_URL). Logs are posted one
 * by one to simplify error handling.
 */
async function sendPendingIfOnline() {
  if (!navigator.onLine) return;
  if (!appConfig.SHEETS_WEBAPP_URL) return;
  const pending = await getPendingLogs();
  if (pending.length === 0) return;
  for (const record of pending) {
    try {
      await postLog(record);
    } catch (err) {
      console.warn('Failed to post log, will retry later', err);
      // abort sending remaining to preserve order and avoid duplication
      return;
    }
  }
  // If all were sent successfully, clear pending
  await clearPendingLogs();
}

/**
 * Post a single log record to the Google Apps Script endpoint. The
 * record is sent as JSON via POST. If the request fails or the
 * response indicates failure, an exception is thrown. Assumes
 * SHEETS_WEBAPP_URL is defined.
 */
async function postLog(record: LogRecord): Promise<void> {
  if (!appConfig.SHEETS_WEBAPP_URL) throw new Error('SHEETS_WEBAPP_URL is not configured');
  const res = await fetch(appConfig.SHEETS_WEBAPP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(record)
  });
  if (!res.ok) {
    throw new Error('Failed to post log: HTTP ' + res.status);
  }
  const body = await res.json();
  if (!body || !body.ok) {
    throw new Error('Server error: ' + JSON.stringify(body));
  }
}

// Kick off the application
init().catch(err => {
  console.error('Failed to initialise application:', err);
});
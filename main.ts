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

import { saveLog, getAllLogs, getPendingLogs, clearPendingLogs, LogRecord, deleteLogById } from './db';
import { watchPosition, clearWatch, haversineDistance, Coordinate } from './geo';
import { loadConfig, parseNaturalLog, summarizeLogs } from './ai';

// Application state for the current driving session
// Additional interfaces to capture detailed event data. Breaks and rests
// now store optional start/end coordinates so that the location of each
// button press is preserved. Fuel logs capture where the vehicle was
// refuelled. These structures make it easy to summarise events into
// the final log note when the session ends.
interface BreakLog {
  start: number;
  end?: number;
  startLat?: number;
  startLng?: number;
  endLat?: number;
  endLng?: number;
}
interface RestLog {
  start: number;
  end?: number;
  startLat?: number;
  startLng?: number;
  endLat?: number;
  endLng?: number;
}
interface FuelEvent {
  time: number;
  amount: number;
  cost?: number;
  lat: number;
  lng: number;
}

interface SessionState {
  startTime: number;
  startCoord?: Coordinate;
  coords: Coordinate[];
  distance: number;
  breaks: BreakLog[];
  rests: RestLog[];
  fuelLogs: FuelEvent[];
  watchId?: number;
}

let currentSession: SessionState | null = null;
let appConfig: { SHEETS_WEBAPP_URL?: string; OPENAI_API_KEY?: string } = {};

// Interval ID for updating the timer display every second. When a session
// is active the UI should refresh automatically so that seconds are shown.
let timerIntervalId: number | undefined;

/**
 * Prompt user for manual coordinates when geolocation fails.
 * If the user cancels the prompt or inputs invalid values, the prompt will repeat.
 */
function promptForCoords(message: string = '現在位置を取得できませんでした。緯度と経度をカンマ区切りで入力してください（例: 43.06,141.35）'): { lat: number; lng: number } {
  const input = prompt(message, '');
  if (!input) {
    throw new Error('緯度・経度の入力がキャンセルされました');
  }
  const parts = input.split(',');
  if (parts.length !== 2) {
    alert('緯度と経度をカンマ区切りで入力してください');
    return promptForCoords(message);
  }
  const lat = parseFloat(parts[0].trim());
  const lng = parseFloat(parts[1].trim());
  if (isNaN(lat) || isNaN(lng)) {
    alert('緯度または経度が正しくありません');
    return promptForCoords(message);
  }
  return { lat, lng };
}

/**
 * Helper to obtain current position or fall back to manual input.
 * Returns a promise that resolves with a latitude/longitude pair.
 */
async function getCurrentPositionOrPrompt(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      pos => {
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        try {
          const coords = promptForCoords();
          resolve(coords);
        } catch (e: any) {
          reject(e);
        }
      },
      { enableHighAccuracy: true }
    );
  });
}

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
      li.className = 'py-2 flex justify-between items-center';
      const infoSpan = document.createElement('span');
      infoSpan.innerHTML = ` ${log.date} ：${log.departureName || '未設定'}→${log.arrivalName || '未設定'} / 距離 ${log.distanceKm.toFixed(1)}km`;
      li.appendChild(infoSpan);
      // Delete button for each log
      const delBtn = document.createElement('button');
      delBtn.className = 'ml-2 px-2 py-1 bg-red-500 text-white rounded text-xs';
      delBtn.textContent = '削除';
      delBtn.onclick = async () => {
        if (log.id === undefined) return;
        if (confirm('このログを削除しますか？')) {
          await deleteLogById(log.id);
          await render();
        }
      };
      li.appendChild(delBtn);
      ul.appendChild(li);
    }
    historySection.appendChild(ul);
    // Add a button to manually synchronise pending logs to the sheet
    const syncBtn = document.createElement('button');
    syncBtn.className = 'mt-4 px-4 py-2 bg-indigo-600 text-white rounded';
    syncBtn.textContent = 'スプレッドシートに同期';
    syncBtn.onclick = async () => {
      await sendPendingIfOnline();
      if (!appConfig.SHEETS_WEBAPP_URL) {
        alert('同期先のURLが設定されていません。config.jsonにSHEETS_WEBAPP_URLを指定してください。');
      } else {
        alert('未送信のログを同期しました。');
      }
      await render();
    };
    historySection.appendChild(syncBtn);
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
  // Compute elapsed time and break/rest time
  const now = Date.now();
  const breakMs = totalBreakMs(currentSession);
  const restMs = totalRestMs(currentSession);
  const drivingMs = now - currentSession.startTime - breakMs - restMs;
  // Header
  const header = document.createElement('h2');
  header.className = 'text-lg font-semibold';
  header.textContent = '走行中';
  container.appendChild(header);
  // Stats
  const stats = document.createElement('div');
  stats.className = 'space-y-1 text-sm';
  stats.innerHTML = `
 経過時間： ${formatDuration(drivingMs)} (運転), ${formatDuration(breakMs)} (休憩), ${formatDuration(restMs)} (休息) 
 走行距離： ${currentSession.distance.toFixed(2)} km 
 燃料記録：${currentSession.fuelLogs.length}回 
  `;
  container.appendChild(stats);
  // Break button
  const breakButton = document.createElement('button');
  const onBreak = currentSession.breaks.length > 0 && currentSession.breaks[currentSession.breaks.length - 1].end === undefined;
  breakButton.className = 'w-full py-3 rounded text-white ' + (onBreak ? 'bg-yellow-600' : 'bg-blue-600');
  breakButton.textContent = onBreak ? '休憩終了' : '休憩開始';
  breakButton.onclick = toggleBreak;
  container.appendChild(breakButton);

  // Rest button
  const restButton = document.createElement('button');
  const onRest = currentSession.rests.length > 0 && currentSession.rests[currentSession.rests.length - 1].end === undefined;
  restButton.className = 'w-full py-3 rounded text-white ' + (onRest ? 'bg-yellow-800' : 'bg-blue-700');
  restButton.textContent = onRest ? '休息終了' : '休息開始';
  restButton.onclick = toggleRest;
  container.appendChild(restButton);
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

  // Display a history of events (breaks, rests, fuel) with timestamps and
  // coordinates so that the user can see where and when each action
  // occurred. This list is scrollable to handle many entries. Each
  // event is summarised with its type, index, timestamp and
  // coordinates. Fuel events also include the amount and cost.
  const eventsContainer = document.createElement('div');
  eventsContainer.className = 'mt-4 max-h-40 overflow-y-auto border-t pt-2 text-xs space-y-1';
  const eventLines: string[] = [];
  // Breaks
  currentSession.breaks.forEach((brk, idx) => {
    const sTime = new Date(brk.start).toLocaleTimeString();
    const eTime = brk.end ? new Date(brk.end).toLocaleTimeString() : '';
    const sCoord = brk.startLat !== undefined ? `(${brk.startLat.toFixed(5)},${(brk.startLng ?? 0).toFixed(5)})` : '';
    const eCoord = brk.endLat !== undefined ? `(${brk.endLat.toFixed(5)},${(brk.endLng ?? 0).toFixed(5)})` : '';
    eventLines.push(`休憩${idx + 1}: ${sTime}${sCoord} - ${eTime}${eCoord}`);
  });
  // Rests
  currentSession.rests.forEach((rest, idx) => {
    const sTime = new Date(rest.start).toLocaleTimeString();
    const eTime = rest.end ? new Date(rest.end).toLocaleTimeString() : '';
    const sCoord = rest.startLat !== undefined ? `(${rest.startLat.toFixed(5)},${(rest.startLng ?? 0).toFixed(5)})` : '';
    const eCoord = rest.endLat !== undefined ? `(${rest.endLat.toFixed(5)},${(rest.endLng ?? 0).toFixed(5)})` : '';
    eventLines.push(`休息${idx + 1}: ${sTime}${sCoord} - ${eTime}${eCoord}`);
  });
  // Fuel events
  currentSession.fuelLogs.forEach((fuel, idx) => {
    const t = new Date(fuel.time).toLocaleTimeString();
    eventLines.push(`給油${idx + 1}: ${t} (${fuel.lat.toFixed(5)},${fuel.lng.toFixed(5)}) ${fuel.amount}L ¥${fuel.cost ?? 0}`);
  });
  eventsContainer.innerHTML = eventLines.map(l => ` ${l} `).join('');
  container.appendChild(eventsContainer);
  return container;
}

/**
 * Start a new driving session. This obtains the initial location,
 * records the start time, and begins watching the user's location.
 * On geolocation failure, the user is prompted to enter coordinates
 * manually so that a session can still be started.
 */
async function startSession() {
  if (currentSession) return;
  try {
    const { lat, lng } = await getCurrentPositionOrPrompt();
    const coord: Coordinate = { lat, lng, timestamp: Date.now() };
    currentSession = {
      startTime: Date.now(),
      startCoord: coord,
      coords: [coord],
      distance: 0,
      breaks: [],
      rests: [],
      fuelLogs: [],
      watchId: undefined
    };
    // Start watching for location updates
    const watchId = watchPosition(handleLocationUpdate, () => {});
    currentSession.watchId = watchId;
    // Start periodic UI updates so that timers include seconds
    timerIntervalId = window.setInterval(() => {
      if (currentSession) {
        render();
      }
    }, 1000);
    render();
  } catch (err: any) {
    alert('現在位置の取得に失敗しました: ' + err.message);
  }
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
 * If geolocation fails the user can input coordinates manually.
 */
async function toggleBreak() {
  if (!currentSession) return;
  const breaks = currentSession.breaks;
  if (breaks.length > 0 && breaks[breaks.length - 1].end === undefined) {
    // End ongoing break: record end time and location
    try {
      const { lat, lng } = await getCurrentPositionOrPrompt();
      breaks[breaks.length - 1].end = Date.now();
      breaks[breaks.length - 1].endLat = lat;
      breaks[breaks.length - 1].endLng = lng;
    } catch {
      // If location fails or cancelled, still end the break without coords
      breaks[breaks.length - 1].end = Date.now();
    }
  } else {
    // Start new break: record start time and location
    try {
      const { lat, lng } = await getCurrentPositionOrPrompt();
      breaks.push({
        start: Date.now(),
        startLat: lat,
        startLng: lng
      });
    } catch {
      breaks.push({ start: Date.now() });
    }
  }
  render();
}

/**
 * Prompt the user to enter fuel data and record it to the session.
 * Location is captured via geolocation or manual input if geolocation fails.
 */
async function addFuel() {
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
  try {
    const { lat, lng } = await getCurrentPositionOrPrompt();
    currentSession!.fuelLogs.push({
      time: Date.now(),
      amount,
      cost,
      lat,
      lng
    });
  } catch {
    currentSession!.fuelLogs.push({
      time: Date.now(),
      amount,
      cost,
      lat: 0,
      lng: 0
    });
  }
  render();
}

/**
 * End the current session. Stops geolocation tracking, computes
 * aggregated data, prompts the user to confirm the session
 * information, and persists the log. The log is queued for
 * synchronisation if the network is unavailable.
 * Location is captured via geolocation or manual input if geolocation fails.
 */
async function endSession() {
  if (!currentSession) return;
  // Stop watching position
  if (currentSession.watchId !== undefined) {
    clearWatch(currentSession.watchId);
  }
  // Get final position (geolocation or manual)
  let endLat = 0;
  let endLng = 0;
  let endTimestamp = Date.now();
  try {
    const { lat, lng } = await getCurrentPositionOrPrompt();
    endLat = lat;
    endLng = lng;
    endTimestamp = Date.now();
  } catch {
    // If location fails, leave endLat/endLng as zero and timestamp already set
  }
  const endCoord: Coordinate = { lat: endLat, lng: endLng, timestamp: endTimestamp };
  currentSession.coords.push(endCoord);
  const totalDistance = currentSession.distance;
  const totalBreak = totalBreakMs(currentSession);
  const totalRest = totalRestMs(currentSession);
  const drivingMs = Date.now() - currentSession.startTime - totalBreak - totalRest;
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
  // Automatically set departure and arrival names to Google Maps URLs using
  // the recorded coordinates. This avoids requiring the user to enter
  // these names manually. If the start coordinate is missing (unlikely),
  // leave the field blank.
  if (currentSession.startCoord) {
    const startLat = currentSession.startCoord.lat;
    const startLng = currentSession.startCoord.lng;
    record.departureName = `https://www.google.com/maps?q=${startLat},${startLng}`;
  }
  record.arrivalName = `https://www.google.com/maps?q=${endCoord.lat},${endCoord.lng}`;

  // Prompt only for an optional user note (e.g. comments). If the user
  // enters text, trim it and set it; otherwise leave note empty for now
  const userNote = prompt('備考（任意）：', '');
  if (userNote !== null && userNote.trim() !== '') {
    record.note = userNote.trim();
  }

  // Summarise rest time and detailed event history into the note field.
  const restMinutes = Math.floor(totalRest / 60000);
  const notes: string[] = [];
  if (restMinutes > 0) {
    notes.push(`休息合計:${restMinutes}分`);
  }
  // Append details of each break with timestamps and coordinates
  currentSession.breaks.forEach((brk, idx) => {
    const sTime = new Date(brk.start).toISOString();
    const eTime = brk.end ? new Date(brk.end).toISOString() : '';
    const sCoord = brk.startLat !== undefined ? `(${brk.startLat.toFixed(5)},${(brk.startLng ?? 0).toFixed(5)})` : '';
    const eCoord = brk.endLat !== undefined ? `(${brk.endLat.toFixed(5)},${(brk.endLng ?? 0).toFixed(5)})` : '';
    notes.push(`休憩${idx + 1}:${sTime}${sCoord}-${eTime}${eCoord}`);
  });
  // Append details of each rest
  currentSession.rests.forEach((rest, idx) => {
    const sTime = new Date(rest.start).toISOString();
    const eTime = rest.end ? new Date(rest.end).toISOString() : '';
    const sCoord = rest.startLat !== undefined ? `(${rest.startLat.toFixed(5)},${(rest.startLng ?? 0).toFixed(5)})` : '';
    const eCoord = rest.endLat !== undefined ? `(${rest.endLat.toFixed(5)},${(rest.endLng ?? 0).toFixed(5)})` : '';
    notes.push(`休息${idx + 1}:${sTime}${sCoord}-${eTime}${eCoord}`);
  });
  // Append details of each fuel stop
  currentSession.fuelLogs.forEach((fuel, idx) => {
    const t = new Date(fuel.time).toISOString();
    notes.push(`給油${idx + 1}:${t}(${fuel.lat.toFixed(5)},${fuel.lng.toFixed(5)}) ${fuel.amount}L ¥${fuel.cost ?? 0}`);
  });
  // Combine existing note (entered by user) with automatic notes
  record.note = [record.note, ...notes].filter(Boolean).join(' | ');

  // Persist the log locally and queue for sync if offline
  await saveLog(record, !navigator.onLine);
  await sendPendingIfOnline();
  // Reset session state
  currentSession = null;
  render();
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
 * Compute the total rest time in milliseconds for a session.
 */
function totalRestMs(session: SessionState): number {
  return session.rests.reduce((sum, r) => {
    const end = r.end || Date.now();
    return sum + (end - r.start);
  }, 0);
}

/**
 * Format a duration specified in milliseconds into a string with hours, minutes
 * and seconds. This helper is used to display timers with second-level
 * precision in the UI.
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}時間${m}分${s}秒`;
}

/**
 * Toggle rest: start a new rest if none is active, otherwise end the current
 * rest period. Rest periods mirror breaks but record separate
 * timestamps and coordinates. When starting or ending a rest the
 * current GPS position is captured; on error the user can input
 * coordinates manually.
 */
async function toggleRest() {
  if (!currentSession) return;
  const rests = currentSession.rests;
  if (rests.length > 0 && rests[rests.length - 1].end === undefined) {
    // End ongoing rest
    try {
      const { lat, lng } = await getCurrentPositionOrPrompt();
      rests[rests.length - 1].end = Date.now();
      rests[rests.length - 1].endLat = lat;
      rests[rests.length - 1].endLng = lng;
    } catch {
      rests[rests.length - 1].end = Date.now();
    }
  } else {
    // Start new rest
    try {
      const { lat, lng } = await getCurrentPositionOrPrompt();
      rests.push({
        start: Date.now(),
        startLat: lat,
        startLng: lng
      });
    } catch {
      rests.push({ start: Date.now() });
    }
  }
  render();
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

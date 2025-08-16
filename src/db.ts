/*
 * db.ts
 *
 * This module manages all IndexedDB operations for the transport log PWA.
 * We use two object stores: one for persisted logs and one for pending logs
 * that need to be sent to the server. The pending store is used when
 * network connectivity is unavailable; once connectivity is restored,
 * the pending logs are sent via the service worker or main thread.
 */

const DB_NAME = 'transport-log-db';
const DB_VERSION = 1;
const STORE_LOGS = 'logs';
const STORE_PENDING = 'pending';

export interface LogRecord {
  id?: number;
  date: string;
  departureName?: string;
  arrivalName?: string;
  departureTime: string;
  arrivalTime?: string;
  drivingMinutes: number;
  breakMinutes: number;
  distanceKm: number;
  fuelLitres: number;
  fuelCost: number;
  departureLat: number;
  departureLng: number;
  arrivalLat: number;
  arrivalLng: number;
  note?: string;
}

/**
 * Open (or create) the IndexedDB database. If the stores do not exist
 * they are created in the upgrade callback.
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = event => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_LOGS)) {
        db.createObjectStore(STORE_LOGS, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_PENDING)) {
        db.createObjectStore(STORE_PENDING, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Save a log record. If `pending` is true the record is saved into the
 * pending store to be sent later when connectivity is restored. All
 * records are stored into the main logs store regardless.
 */
export async function saveLog(record: LogRecord, pending: boolean = false): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_LOGS, STORE_PENDING], 'readwrite');
    tx.objectStore(STORE_LOGS).add(record);
    if (pending) {
      tx.objectStore(STORE_PENDING).add(record);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Retrieve all stored logs (not pending logs). Useful for the history view.
 */
export async function getAllLogs(): Promise<LogRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOGS, 'readonly');
    const store = tx.objectStore(STORE_LOGS);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as LogRecord[]);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Retrieve all pending records that have not yet been sent to the server.
 */
export async function getPendingLogs(): Promise<LogRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readonly');
    const store = tx.objectStore(STORE_PENDING);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as LogRecord[]);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Clear all pending logs after they have been successfully sent.
 */
export async function clearPendingLogs(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    tx.objectStore(STORE_PENDING).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Delete a log record by its ID from both the logs store and the pending
 * store. When a user deletes a past log from the UI we remove it
 * entirely from local storage. If the record was pending, removing
 * it from the pending store prevents it from being sent later.
 * @param id The auto-incremented ID of the log to delete
 */
export async function deleteLogById(id: number): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_LOGS, STORE_PENDING], 'readwrite');
    tx.objectStore(STORE_LOGS).delete(id);
    tx.objectStore(STORE_PENDING).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
// Tema

// ───────────────────────────────────────────
// TEMA — se guarda en localStorage para respuesta instantánea
//        y se sincroniza con Supabase para que persista entre
//        dispositivos. La fuente de verdad al cargar es Supabase.
// ───────────────────────────────────────────
const btn = document.getElementById("themeToggle");

function applyTheme(isLight) {
  document.body.classList.toggle("light", isLight);
  localStorage.setItem("theme", isLight ? "light" : "dark");
}

function loadThemeFromState() {
  const t = state.config?.theme;
  // Si todavía no hay valor en Supabase, respetamos localStorage
  // (primer arranque del usuario en cualquier dispositivo).
  if (t === 'light' || t === 'dark') {
    applyTheme(t === 'light');
  } else if (localStorage.getItem("theme") === "light") {
    document.body.classList.add("light");
  }
}

btn.addEventListener("click", () => {
  const newIsLight = !document.body.classList.contains("light");
  applyTheme(newIsLight);
  // Persistir en el estado que se sincroniza
  if (!state.config) state.config = {};
  state.config.theme = newIsLight ? 'light' : 'dark';
  save();
});

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
let state = {
  projects: [],
  tasks: [],
  events: [],
  reminders: [],
  log: [],
  activeTimer: null, // { id, type, start, paused, pausedMs }
};

// ───────────────────────────────────────────
// SUPABASE — backend compartido, datos separados por cuenta
// ───────────────────────────────────────────
// SUPABASE_URL y SUPABASE_ANON_KEY son públicos (están pensados para ir
// embebidos en el cliente). Lo que protege los datos de cada usuario es
// la Row Level Security definida en supabase/schema.sql.
const SUPABASE_URL = 'https://scfeluwbaanzxataizbz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_slMXuckeD-_SWT6T7OLfBA_bg0pe5V8';

const supabaseClient = (SUPABASE_URL.includes('TU-PROYECTO') || !window.supabase)
  ? null
  : window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;      // { id, email, name }
let authMode = 'login';      // 'login' | 'signup'
let realtimeChannels = [];

let syncState = { status: 'idle', lastSync: null, lastError: null };
const LOCAL_CACHE_KEY = 'workflow_v2';

function sheetsEnabled() {
  return !!(supabaseClient && currentUser);
}

// ── AUTH ──────────────────────────────────
function toggleAuthMode() {
  authMode = authMode === 'login' ? 'signup' : 'login';
  document.getElementById('authTitle').textContent = authMode === 'login' ? 'Iniciar sesión' : 'Crear cuenta';
  document.getElementById('authSubmitBtn').textContent = authMode === 'login' ? 'Iniciar sesión' : 'Crear cuenta';
  document.getElementById('authToggleBtn').textContent = authMode === 'login' ? '¿No tenés cuenta? Registrate' : '¿Ya tenés cuenta? Iniciá sesión';
  document.getElementById('authError').textContent = '';
}

async function handleAuthSubmit() {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errEl = document.getElementById('authError');
  errEl.textContent = '';

  if (!supabaseClient) {
    errEl.textContent = 'Falta configurar SUPABASE_URL / SUPABASE_ANON_KEY en index.js';
    return;
  }
  if (!email || !password) {
    errEl.textContent = 'Completá email y contraseña';
    return;
  }
  if (password.length < 6) {
    errEl.textContent = 'La contraseña necesita al menos 6 caracteres';
    return;
  }

  const btn = document.getElementById('authSubmitBtn');
  btn.disabled = true;
  try {
    if (authMode === 'login') {
      const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } else {
      const { data, error } = await supabaseClient.auth.signUp({ email, password });
      if (error) throw error;
      if (data.user && !data.session) {
        errEl.style.color = 'var(--accent)';
        errEl.textContent = '✓ Cuenta creada. Revisá tu email para confirmarla y después iniciá sesión.';
        return;
      }
    }
    // El listener onAuthStateChange se encarga de cerrar el gate y cargar los datos
  } catch (err) {
    errEl.style.color = 'var(--red)';
    errEl.textContent = err.message || 'Error al iniciar sesión';
  } finally {
    btn.disabled = false;
  }
}

function openAuthGateForLogin() {
  authMode = 'login';
  const titleEl = document.getElementById('authTitle');
  const submitEl = document.getElementById('authSubmitBtn');
  const toggleEl = document.getElementById('authToggleBtn');
  const errorEl = document.getElementById('authError');

  if (titleEl) titleEl.textContent = 'Iniciar sesión';
  if (submitEl) submitEl.textContent = 'Iniciar sesión';
  if (toggleEl) toggleEl.textContent = '¿No tenés cuenta? Registrate';
  if (errorEl) errorEl.textContent = '';

  showAuthGate();

  const emailInput = document.getElementById('authEmail');
  if (emailInput) setTimeout(() => { emailInput.focus(); emailInput.select(); }, 50);
}

function updateAuthActionButton() {
  const btn = document.getElementById('authActionBtn');
  if (!btn) return;
  if (currentUser) {
    btn.textContent = 'Cerrar sesión';
    btn.className = 'btn btn-red btn-sm';
  } else {
    btn.textContent = 'Iniciar sesión';
    btn.className = 'btn btn-accent btn-sm';
  }
  btn.onclick = () => handleAuthAction();
}

function handleAuthAction() {
  if (currentUser) signOut();
  else openAuthGateForLogin();
}

async function signOut() {
  if (!supabaseClient) return;
  showLoadingOverlay('Cerrando sesión…', 'Guardando cambios pendientes');
  try {
    // Subimos lo pendiente antes de cerrar (si falla, se pierde sólo
    // lo que no se llegó a subir; avisamos).
    if (sheetsEnabled() && computeDiff().count > 0) {
      const ok = await pushToSheets();
      if (!ok) toast('⚠ Algunos cambios no se pudieron subir antes de cerrar sesión', 'warn');
    }
    await supabaseClient.auth.signOut();
  } catch (err) {
    console.error('Error al cerrar sesión:', err);
    toast('Error al cerrar sesión', 'warn');
  } finally {
    await new Promise(r => setTimeout(r, 300));
    hideLoadingOverlay();
  }
}

function showAuthGate() { document.getElementById('authGate').classList.add('open'); }
function hideAuthGate() { document.getElementById('authGate').classList.remove('open'); }

const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText    = document.querySelector('#loadingOverlay .loading-text');
const loadingSub     = document.getElementById('loadingSub');

function showLoadingOverlay(msg, sub) {
  if (loadingText && msg) loadingText.textContent = msg;
  if (loadingSub && sub)  loadingSub.textContent  = sub;
  if (loadingOverlay)     loadingOverlay.classList.add('visible');
}
function hideLoadingOverlay() {
  if (loadingOverlay) loadingOverlay.classList.remove('visible');
}

function setCurrentUser(session) {
  const email = session.user.email || '';
  currentUser = { id: session.user.id, email, name: email.split('@')[0] };
}

// Se llama al abrir la app con sesión ya iniciada o justo después de
// loguearse. Es idempotente: si ya estamos inicializados para ese
// usuario no hace nada (Supabase a veces emite SIGNED_IN repetido).
let signedInUid = null;
async function onSignedIn(session) {
  if (signedInUid === session.user.id) { setCurrentUser(session); return; }
  signedInUid = session.user.id;
  setCurrentUser(session);
  hideAuthGate();
  document.getElementById('headerUserEmail').textContent = currentUser.email;
  document.getElementById('datosUserEmail').textContent  = currentUser.email;
  document.title = `${currentUser.name} - Productividad`;
  updateAuthActionButton();

  ensureSnapshotForUser(currentUser.id);
  renderAll();

  const hasLocalData = state.tasks.length || state.events.length || state.reminders.length || state.log.length;
  if (hasLocalData) {
    // Hay datos locales: los mostramos YA y sincronizamos en segundo plano.
    loadFromSheets({ silent: true }).then(ok => {
      if (ok && state.config?.theme) applyTheme(state.config.theme === 'light');
    });
  } else {
    // Primer login en este dispositivo: esperamos los datos (tope 8s).
    showLoadingOverlay('Sincronizando…', 'Bajando tus datos');
    await Promise.race([
      loadFromSheets({ silent: true }),
      new Promise(resolve => setTimeout(resolve, 8000))
    ]);
    hideLoadingOverlay();
    if (state.config?.theme) applyTheme(state.config.theme === 'light');
  }

  startRealtime();
}

function onSignedOut() {
  currentUser = null;
  signedInUid = null;
  clearTimeout(syncDebounceTimer);
  stopRealtime();

  // Limpiar TODO el estado visible para que no quede nada de la cuenta anterior
  state = { projects: [], tasks: [], events: [], reminders: [], log: [], activeTimer: null };
  applyDefaults();
  synced = emptySnapshot(null);
  initialPullDone = false;
  try {
    localStorage.removeItem(LOCAL_CACHE_KEY);
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch (e) {}

  const headerUserEmail = document.getElementById('headerUserEmail');
  const datosUserEmail = document.getElementById('datosUserEmail');
  if (headerUserEmail) headerUserEmail.textContent = '';
  if (datosUserEmail) datosUserEmail.textContent = '—';
  document.title = 'Productividad';
  updateAuthActionButton();
  renderAll();
  showAuthGate();
  setSyncStatus('disabled');
}

if (supabaseClient) {
  supabaseClient.auth.getSession().then(({ data }) => {
    if (data.session) onSignedIn(data.session);
    else { showAuthGate(); updateAuthActionButton(); setSyncStatus('disabled'); }
  });

  // TOKEN_REFRESHED / USER_UPDATED sólo renuevan el usuario interno:
  // nunca recargan datos (antes eso pisaba cambios sin subir).
  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || !session) {
      if (signedInUid) onSignedOut();
      return;
    }
    if (event === 'SIGNED_IN' && session.user.id !== signedInUid) {
      onSignedIn(session);
      return;
    }
    setCurrentUser(session);
  });
} else {
  console.warn('Supabase no está configurado (ver SUPABASE_URL/SUPABASE_ANON_KEY en index.js)');
}

// ═══════════════════════════════════════════
// SINCRONIZACIÓN
// ═══════════════════════════════════════════
// Modelo anterior: cada cambio subía TODO el estado y la base borraba y
// reinsertaba todas las filas (save_full_state). Con dos dispositivos
// abiertos, el que tenía datos viejos pisaba al otro (tareas que
// desaparecían / reaparecían), y cada push generaba cientos de eventos
// DELETE+INSERT en Realtime que disparaban pulls a mitad de camino.
//
// Modelo nuevo (por registro):
//  · `synced` guarda cómo está cada registro en el servidor según lo
//    último que sabemos (snapshot). Se persiste en localStorage.
//  · Subir = comparar `state` contra el snapshot y mandar sólo lo que
//    cambió (upsert) o se borró (delete por id).
//  · Bajar = merge registro por registro: si un registro tiene cambios
//    locales sin subir, gana el local; si no, gana el servidor.
//  · Realtime aplica cada fila que llega con la misma regla, sin hacer
//    un pull completo.
const COLLECTIONS = ['projects', 'tasks', 'events', 'reminders', 'log'];
// Tablas que todavía no existen en Supabase (ej. no se corrió la
// migración de proyectos): se guardan sólo localmente hasta que existan.
const missingTables = new Set();
function isMissingTableError(err) {
  const m = (err && (err.message || '')) + ' ' + (err && err.code || '');
  return /PGRST205|42P01|Could not find the table|does not exist/i.test(m);
}
const SNAPSHOT_KEY = 'workflow_v2_synced';
const SKIPCOLS_KEY = 'workflow_v2_skipcols';
const LOG_MAX = 3000;

let synced = emptySnapshot(null);
let initialPullDone = false;    // al menos un pull exitoso en esta sesión
let syncDebounceTimer = null;
let pushInFlight = false;
let pushAgain = false;
let pushSeq = 0;                // se incrementa en cada push (para invalidar pulls viejos)
let pullInFlight = null;        // promesa del pull en curso
let pullAgain = false;
let retryDelay = 0;
let lastPullAt = 0;
let hasPendingLocalChange = false;

// Columnas que la base todavía no tiene (por ejemplo si no se corrió la
// migración del kanban). Se quitan antes de subir y se conservan localmente.
let skippedColumns = {};
try { skippedColumns = JSON.parse(localStorage.getItem(SKIPCOLS_KEY) || '{}'); } catch (e) {}

function emptySnapshot(uid) {
  return { uid, migrated: false, projects: {}, tasks: {}, events: {}, reminders: {}, log: {}, config: null, timer: null };
}

// Serialización estable: claves ordenadas, sin null/undefined ni claves
// internas (_xxx). Dos registros "iguales" dan siempre el mismo string.
function norm(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(norm).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter(k => v[k] !== null && v[k] !== undefined && k[0] !== '_' && k !== 'user_id').sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + norm(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function saveSnapshot() {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(synced)); } catch (e) {}
}

function loadSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (raw) synced = { ...emptySnapshot(null), ...JSON.parse(raw) };
  } catch (e) { synced = emptySnapshot(null); }
}

// Si el snapshot es de otro usuario (o no existe: primera vez con esta
// versión), el próximo pull hace una "migración": el servidor manda.
function ensureSnapshotForUser(uid) {
  if (synced.uid !== uid) {
    synced = emptySnapshot(uid);
    saveSnapshot();
  }
}

function computeDiff() {
  const d = { upserts: {}, deletes: {}, config: null, timer: null, count: 0 };
  if (!synced.migrated) return d; // hasta el primer pull no sabemos qué hay en el servidor
  for (const c of COLLECTIONS) {
    if (missingTables.has(c)) continue;
    const snap = synced[c] || {};
    const seen = new Set();
    const ups = [];
    for (const rec of state[c] || []) {
      if (!rec || !rec.id || seen.has(rec.id)) continue;
      seen.add(rec.id);
      const s = norm(rec);
      if (snap[rec.id] !== s) ups.push({ rec, s });
    }
    const dels = Object.keys(snap).filter(id => !seen.has(id));
    if (ups.length) { d.upserts[c] = ups; d.count += ups.length; }
    if (dels.length) { d.deletes[c] = dels; d.count += dels.length; }
  }
  const cfg = norm(state.config || {});
  if (cfg !== synced.config) { d.config = cfg; d.count++; }
  const tmr = norm(state.activeTimer || null);
  if (tmr !== synced.timer) { d.timer = tmr; d.count++; }
  return d;
}

function applyDefaults() {
  if (!state.projects) state.projects = [];
  if (!state.tasks) state.tasks = [];
  if (!state.events) state.events = [];
  if (!state.reminders) state.reminders = [];
  if (!state.log) state.log = [];
  if (!state.config) state.config = { regenHour: '07:00', lastRegen: null, skipWeekends: true };
  if (state.config.skipWeekends === undefined) state.config.skipWeekends = true;
  if (state.activeTimer === undefined) state.activeTimer = null;
  // Protección: nunca dos registros con el mismo id en una colección
  for (const c of COLLECTIONS) {
    const seen = new Set();
    state[c] = state[c].filter(r => r && r.id && !seen.has(r.id) && seen.add(r.id));
  }
}

function load() {
  // Caché local: instantáneo, nunca falla, evita pantallas vacías.
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch (e) {}
  applyDefaults();
  loadSnapshot();
}

function saveLocalOnly() {
  try { localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(state)); } catch (e) {}
}

function save() {
  if (state.log.length > LOG_MAX) state.log = state.log.slice(0, LOG_MAX);
  saveLocalOnly();           // siempre primero, síncrono, sin red
  scheduleSyncToSheets();
}

function scheduleSyncToSheets(delay) {
  if (!sheetsEnabled()) { setSyncStatus('disabled'); return; }
  hasPendingLocalChange = true;
  renderSyncIndicator();
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => pushToSheets(), delay ?? 800);
}

function stripSkipped(table, rec) {
  const skip = skippedColumns[table] || [];
  const row = {};
  for (const k of Object.keys(rec)) {
    if (k[0] === '_' || skip.includes(k)) continue;
    row[k] = rec[k];
  }
  return row;
}

async function upsertRows(table, rows, onConflict) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const payload = rows.map(r => ({ ...stripSkipped(table, r), user_id: currentUser.id }));
    const { error } = await supabaseClient.from(table).upsert(payload, { onConflict });
    if (!error) return;
    // Columna inexistente en la base → la salteamos y reintentamos
    const m = /'([^']+)' column/.exec(error.message || '');
    if ((error.code === 'PGRST204' || /column/i.test(error.message || '')) && m) {
      skippedColumns[table] = [...new Set([...(skippedColumns[table] || []), m[1]])];
      try { localStorage.setItem(SKIPCOLS_KEY, JSON.stringify(skippedColumns)); } catch (e) {}
      console.warn(`[Sync] La tabla ${table} no tiene la columna "${m[1]}". Se guarda sólo localmente. Corré supabase/migracion_kanban.sql.`);
      continue;
    }
    throw error;
  }
  throw new Error('Demasiadas columnas desconocidas en ' + table);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function pushToSheets(opts) {
  opts = opts || {};
  if (!sheetsEnabled()) {
    if (opts.manual) toast('Iniciá sesión primero', 'warn');
    return false;
  }
  if (!synced.migrated) {
    // Todavía no hicimos el primer pull: subir ahora podría resucitar
    // datos viejos. El pull reprograma el push al terminar.
    if (!pullInFlight) loadFromSheets({ silent: true });
    return false;
  }
  if (pushInFlight) { pushAgain = true; return false; }

  const d = computeDiff();
  if (d.count === 0) {
    hasPendingLocalChange = false;
    setSyncStatus('synced');
    return true;
  }

  pushInFlight = true;
  pushSeq++;
  setSyncStatus('syncing');
  const uid = currentUser.id;

  try {
    for (const c of COLLECTIONS) {
      if (!synced[c]) synced[c] = {};
      for (const part of chunk(d.upserts[c] || [], 400)) {
        await upsertRows(c, part.map(u => u.rec), 'user_id,id');
        part.forEach(u => { synced[c][u.rec.id] = u.s; });
      }
      for (const ids of chunk(d.deletes[c] || [], 200)) {
        const { error } = await supabaseClient.from(c).delete().eq('user_id', uid).in('id', ids);
        if (error) throw error;
        ids.forEach(id => { delete synced[c][id]; });
      }
    }
    if (d.config !== null) {
      await upsertRows('user_config', [{ config: state.config || {} }], 'user_id');
      synced.config = d.config;
    }
    if (d.timer !== null) {
      await upsertRows('active_timer', [{ timer: state.activeTimer || null }], 'user_id');
      synced.timer = d.timer;
    }
    saveSnapshot();
    retryDelay = 0;
    hasPendingLocalChange = computeDiff().count > 0;
    setSyncStatus('synced');
    if (opts.manual) toast('✓ Sincronizado', 'success');
    return true;
  } catch (err) {
    saveSnapshot(); // lo que sí se subió queda registrado
    console.error('[Sync] push falló:', err);
    setSyncStatus('error', err.message || String(err));
    if (opts.manual) toast('⚠ No se pudo sincronizar: ' + (err.message || err), 'warn');
    // Reintento con espera creciente (5s, 10s, 20s… hasta 60s)
    retryDelay = Math.min(retryDelay ? retryDelay * 2 : 5000, 60000);
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => pushToSheets(), retryDelay);
    return false;
  } finally {
    pushInFlight = false;
    if (pushAgain) {
      pushAgain = false;
      clearTimeout(syncDebounceTimer);
      syncDebounceTimer = setTimeout(() => pushToSheets(), 50);
    }
  }
}

async function fetchAllRows(table, uid, pageSize = 1000) {
  const all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseClient
      .from(table).select('*').eq('user_id', uid)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}

// Igual que fetchAllRows, pero si la tabla no existe devuelve null en vez de fallar
async function fetchOptionalTable(table, uid) {
  try {
    const rows = await fetchAllRows(table, uid);
    missingTables.delete(table);
    return rows;
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    if (!missingTables.has(table)) console.warn(`[Sync] La tabla "${table}" no existe en Supabase. Corré supabase/migracion_proyectos.sql. Mientras tanto se guarda sólo en este dispositivo.`);
    missingTables.add(table);
    return null;
  }
}

async function fetchTablesFromSupabase(uid) {
  const [projects, tasks, events, reminders, log, cfgR, timerR] = await Promise.all([
    fetchOptionalTable('projects', uid),
    fetchAllRows('tasks', uid),
    fetchAllRows('events', uid),
    fetchAllRows('reminders', uid),
    fetchAllRows('log', uid),
    supabaseClient.from('user_config').select('*').eq('user_id', uid).maybeSingle(),
    supabaseClient.from('active_timer').select('*').eq('user_id', uid).maybeSingle(),
  ]);
  if (cfgR.error) throw cfgR.error;
  if (timerR.error) throw timerR.error;
  return { projects, tasks, events, reminders, log, config: cfgR.data ? cfgR.data.config : undefined, timer: timerR.data ? timerR.data.timer : undefined };
}

function stripRow(row) {
  const { user_id, ...rest } = row;
  return rest;
}

// Merge de una colección. Devuelve el nuevo array local y el snapshot.
function mergeCollection(c, remoteRows, mode) {
  const snap = synced[c] || {};
  const local = state[c] || [];
  const localById = new Map(local.map(r => [r.id, r]));
  const remoteIds = new Set();
  const out = [];
  const newSnap = {};

  for (const row of remoteRows) {
    const rec = stripRow(row);
    if (!rec.id || remoteIds.has(rec.id)) continue;
    remoteIds.add(rec.id);
    const loc = localById.get(rec.id);
    // {...loc, ...rec}: conserva campos que la base no tiene como columna
    const merged = loc ? { ...loc, ...rec } : rec;
    newSnap[rec.id] = norm(merged);
    const known = Object.prototype.hasOwnProperty.call(snap, rec.id);
    const localDirty = mode === 'normal' && (loc ? norm(loc) !== snap[rec.id] : known);
    if (localDirty) {
      if (loc) out.push(loc);   // cambio local sin subir: gana el local
      // (si !loc es un borrado local pendiente: no lo agregamos)
    } else {
      out.push(merged);
    }
  }

  for (const loc of local) {
    if (remoteIds.has(loc.id)) continue;
    const known = Object.prototype.hasOwnProperty.call(snap, loc.id);
    if (mode === 'keepLocal') out.push(loc);          // servidor vacío: subimos lo local
    else if (mode === 'normal' && !known) out.push(loc); // creado acá, todavía no subido
    // si era conocido y ya no está en el servidor → se borró en otro dispositivo
  }

  if (c === 'log') out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return { out, newSnap };
}

// Merge de config / timer (una fila por usuario)
function mergeSingle(key, remoteVal, mode) {
  if (remoteVal === undefined) return; // no hay fila en el servidor: se subirá la local
  const stateKey = key === 'config' ? 'config' : 'activeTimer';
  const localDirty = mode === 'normal' && synced[key] !== null
    && norm(key === 'config' ? (state.config || {}) : (state.activeTimer || null)) !== synced[key];
  if (key === 'config') {
    const merged = { ...(state.config || {}), ...(remoteVal || {}) };
    if (localDirty) synced.config = norm(remoteVal || {});
    else { state.config = merged; synced.config = norm(merged); }
  } else {
    if (!localDirty) state[stateKey] = remoteVal || null;
    synced.timer = norm(remoteVal || null);
  }
}

async function loadFromSheets(opts) {
  opts = opts || {};
  if (!sheetsEnabled()) {
    if (opts.manual) toast('Iniciá sesión primero', 'warn');
    return false;
  }
  if (pullInFlight) { pullAgain = true; return pullInFlight; }

  pullInFlight = (async () => {
    const seqAtStart = pushSeq;
    setSyncStatus('syncing');
    try {
      const uid = currentUser.id;
      const remote = await fetchTablesFromSupabase(uid);
      if (!currentUser || currentUser.id !== uid) return false;

      // Si mientras bajábamos se subió algo, estos datos pueden ser
      // anteriores a nuestro propio cambio: los descartamos y repetimos.
      if (pushInFlight || pushSeq !== seqAtStart) { pullAgain = true; return false; }

      const remoteEmpty = !remote.tasks.length && !remote.events.length && !remote.reminders.length && !remote.log.length;
      let mode = 'normal';
      if (!synced.migrated) mode = remoteEmpty ? 'keepLocal' : 'remoteWins';

      for (const c of COLLECTIONS) {
        if (remote[c] === null) continue; // tabla inexistente: queda lo local
        const { out, newSnap } = mergeCollection(c, remote[c], mode);
        state[c] = out;
        synced[c] = newSnap;
      }
      if (mode !== 'normal') { synced.config = null; synced.timer = null; }
      mergeSingle('config', remote.config, mode);
      mergeSingle('timer', remote.timer, mode);

      synced.migrated = true;
      applyDefaults();
      saveSnapshot();
      saveLocalOnly();
      initialPullDone = true;
      lastPullAt = Date.now();

      setSyncStatus('synced');
      if (opts.manual) toast('✓ Datos actualizados', 'success');
      renderAll();

      // Cambios locales pendientes (o datos locales a migrar) → subir
      if (computeDiff().count > 0) scheduleSyncToSheets(300);
      else hasPendingLocalChange = false;
      return true;
    } catch (err) {
      console.error('[Sync] pull falló:', err);
      setSyncStatus('error', err.message || String(err));
      if (!opts.silent) toast('⚠ Sin conexión, usando datos guardados localmente', 'warn');
      return false;
    }
  })();

  try {
    return await pullInFlight;
  } finally {
    pullInFlight = null;
    if (pullAgain) { pullAgain = false; schedulePull(400); }
  }
}

let pullTimer = null;
function schedulePull(delay) {
  clearTimeout(pullTimer);
  pullTimer = setTimeout(() => {
    if (pushInFlight) { schedulePull(500); return; }
    loadFromSheets({ silent: true });
  }, delay || 0);
}

async function manualSync() {
  toast('Sincronizando…', 'success');
  if (computeDiff().count > 0) await pushToSheets({ manual: true });
  await loadFromSheets({ manual: true });
}

// ── REALTIME: cambios en otro dispositivo llegan al instante ──
let rtRenderTimer = null;
function scheduleRtRender() {
  clearTimeout(rtRenderTimer);
  rtRenderTimer = setTimeout(() => {
    if (uiBusy) { scheduleRtRender(); return; }
    renderAll();
  }, 150);
}

function applyRealtimeRow(payload) {
  if (!currentUser || !synced.migrated) return;
  const table = payload.table;
  const type = payload.eventType;

  if (COLLECTIONS.includes(table)) {
    const snap = synced[table];
    if (type === 'DELETE') {
      const id = payload.old && payload.old.id;
      if (!id) return;
      if (payload.old.user_id && payload.old.user_id !== currentUser.id) return;
      const loc = state[table].find(r => r.id === id);
      const localDirty = loc && norm(loc) !== snap[id];
      delete snap[id];
      if (!localDirty) state[table] = state[table].filter(r => r.id !== id);
    } else {
      const row = payload.new;
      if (!row || !row.id || (row.user_id && row.user_id !== currentUser.id)) return;
      const rec = stripRow(row);
      const idx = state[table].findIndex(r => r.id === rec.id);
      const loc = idx >= 0 ? state[table][idx] : null;
      const known = Object.prototype.hasOwnProperty.call(snap, rec.id);
      // !loc && known → lo borramos acá y todavía no se subió: no resucitar
      const localDirty = loc ? norm(loc) !== snap[rec.id] : known;
      const merged = loc ? { ...loc, ...rec } : rec;
      snap[rec.id] = norm(merged);
      if (!localDirty) {
        if (idx >= 0) state[table][idx] = merged;
        else if (table === 'log') state.log.unshift(merged);
        else state[table].push(merged);
      }
    }
  } else if (table === 'active_timer' || table === 'user_config') {
    const row = payload.new;
    if (!row || (row.user_id && row.user_id !== currentUser.id)) return;
    if (table === 'active_timer') mergeSingle('timer', type === 'DELETE' ? null : (row.timer ?? null), 'normal');
    else if (row.config) mergeSingle('config', row.config, 'normal');
  } else return;

  saveSnapshot();
  saveLocalOnly();
  scheduleRtRender();
}

function stopRealtime() {
  if (!supabaseClient) return;
  realtimeChannels.forEach(ch => { try { supabaseClient.removeChannel(ch); } catch (e) {} });
  realtimeChannels = [];
}

function startRealtime() {
  if (!supabaseClient || !currentUser) return;
  stopRealtime();
  const uid = currentUser.id;
  // Un solo canal con todas las tablas
  const ch = supabaseClient.channel('rt-all-' + uid);
  ['tasks', 'events', 'reminders', 'log', 'user_config', 'active_timer'].forEach(table => {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${uid}` }, applyRealtimeRow);
  });
  // Proyectos en un canal aparte: si la tabla todavía no existe, que no
  // rompa la suscripción del resto.
  const chProjects = supabaseClient.channel('rt-projects-' + uid)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'projects', filter: `user_id=eq.${uid}` }, applyRealtimeRow)
    .subscribe();
  realtimeChannels.push(chProjects);
  ch.subscribe((status, err) => {
    if (err) console.error('[RT] error:', err);
    // Al (re)conectar hacemos un pull para recuperar lo que se perdió
    // mientras estuvo desconectado (móvil en segundo plano, etc.)
    if (status === 'SUBSCRIBED' && initialPullDone) loadFromSheets({ silent: true });
  });
  realtimeChannels.push(ch);
}

function setSyncStatus(status, errorMsg) {
  syncState.status = status;
  syncState.lastError = errorMsg || null;
  if (status === 'synced') syncState.lastSync = new Date();
  renderSyncIndicator();
}

function renderSyncIndicator() {
  const pending = hasPendingLocalChange && syncState.status !== 'syncing';
  const map = {
    idle:     ['●', 'var(--text3)', 'Iniciando…'],
    disabled: ['○', 'var(--text3)', 'Sin sesión (solo local)'],
    syncing:  ['◐', 'var(--amber)', 'Sincronizando…'],
    synced:   ['●', 'var(--accent)', syncState.lastSync ? 'Sincronizado · ' + syncState.lastSync.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : 'Sincronizado'],
    error:    ['●', 'var(--red)', 'Sin conexión (cambios guardados en este equipo)'],
  };
  let [dot, color, label] = map[syncState.status] || map.idle;
  if (pending && syncState.status === 'synced') { dot = '◐'; color = 'var(--amber)'; label = 'Cambios por subir…'; }
  const html = `<span style="color:${color}">${dot}</span> <span class="sync-label">${label}</span>`;
  ['syncIndicator', 'syncIndicatorDatos', 'syncIndicatorDatos2', 'syncIndicatorMobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.title = syncState.lastError || label; el.innerHTML = html; }
  });
}

// Puesto en true mientras se arrastra una tarjeta: posterga re-renders
let uiBusy = false;

// Escapa texto del usuario antes de meterlo en HTML
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Ubicación del Pomodoro (responsive): en pantallas angostas la barra
// lateral se oculta, así que el pomodoro pasa al Dashboard.
const pomodoroContainer = document.getElementById('pomodoroMain');
const pomodoroOriginal = document.getElementById('pomodoroContainer');
const pomodoroMovil = document.getElementById('pomodoroMovil');
const mqNarrow = window.matchMedia('(max-width: 1170px)');

function moverPomodoro() {
  if (!pomodoroContainer || !pomodoroOriginal || !pomodoroMovil) return;
  const target = mqNarrow.matches ? pomodoroMovil : pomodoroOriginal;
  if (pomodoroContainer.parentElement !== target) target.appendChild(pomodoroContainer);
}
moverPomodoro();
mqNarrow.addEventListener('change', moverPomodoro);


// ================================
// POMODORO (vinculado a la tarea activa)
// ================================

const valoresDefault = {
    corto: 5,
    descanso: 15,
    largo: 25
};

function obtenerMinutos() {
    const raw = tiempos[modoActual].value;

    // Si el input está vacío, devolvemos el default para los cálculos
    // pero NO tocamos el input (así el usuario puede seguir tipeando)
    if (raw === '') return valoresDefault[modoActual];

    const valor = Number(raw);
    if (Number.isNaN(valor)) return valoresDefault[modoActual];

    return valor < 0 ? 0 : valor;
}




// Display del tiempo
const tiempo = document.getElementById("tiempo");

// Inputs de configuración
const tiem_corto = document.getElementById("tiem-corto");
const tiem_largo = document.getElementById("tiem-largo");
const tiem_desc  = document.getElementById("tiem-desc");

// Tabs
const tabs = document.querySelectorAll(".tab");

// Relación modo -> input
const tiempos = {
    corto:    tiem_corto,
    largo:    tiem_largo,
    descanso: tiem_desc
};

// Modo por defecto
let modoActual = "corto";

function actualizarTiempo() {
    const minutos = obtenerMinutos();
    tiempo.textContent = `${String(minutos).padStart(2, "0")}:00`;
}


// Cambio de pestañas
tabs.forEach(tab => {
    tab.addEventListener("click", () => {
        tabs.forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        modoActual = tab.dataset.tipo;
        reiniciarTemporizador();
    });
});

// Si cambia cualquier input, actualiza solo si ese modo está siendo mostrado
Object.entries(tiempos).forEach(([modo, input]) => {
    input.addEventListener("input", () => {
        if (modo === modoActual) actualizarTiempo();
    });
});

actualizarTiempo();

// Estado interno del pomodoro
let segundosRestantes = 0;
let intervalo = null;

function esModoDescanso() {
    return modoActual === 'descanso';
}

function mostrarTiempo() {
    const minutos = Math.floor(segundosRestantes / 60);
    const segundos = segundosRestantes % 60;
    tiempo.textContent =
        `${String(minutos).padStart(2, "0")}:${String(segundos).padStart(2, "0")}`;
}

function reiniciarTemporizador() {
    clearInterval(intervalo);
    intervalo = null;
    segundosRestantes = obtenerMinutos() * 60;
    mostrarTiempo();
}

// Tick del pomodoro cuando está vinculado a una tarea
function tickPomodoroVinculado() {
    // Si el timer activo se cerró desde otro lado (botón ■ de la tarea,
    // o la app), frenamos el pomodoro también
    if (!state.activeTimer) {
        clearInterval(intervalo);
        intervalo = null;
        reiniciarTemporizador();
        return;
    }

    // Si el timer está pausado, el pomodoro también queda en pausa
    if (state.activeTimer.paused) return;

    if (segundosRestantes <= 0) {
        clearInterval(intervalo);
        intervalo = null;
        const t = state.activeTimer;
        stopTimer(t.id, t.type);   // registra la sesión y suma a totalMs
        toast('🍅 Pomodoro terminado · sesión guardada', 'success');
        reiniciarTemporizador();
        return;
    }

    segundosRestantes--;
    mostrarTiempo();
}

// Iniciar
function iniciarTemporizador() {
  const sonPom = new Audio('media/BellSound.mpeg');
    if (intervalo) return; // ya está corriendo

    // Modo descanso: timer independiente, NO descuenta de tareas
    if (esModoDescanso()) {
        intervalo = setInterval(() => {
            if (segundosRestantes <= 0) {
                clearInterval(intervalo);
                intervalo = null;
                sonPom.play().catch(() => {});
                toast('☕ ¡Descanso terminado!', 'success');
                reiniciarTemporizador();
                return;
            }
            segundosRestantes--;
            mostrarTiempo();
        }, 1000);
        return;
    }

    // Modo corto/largo: necesita haber una tarea activa
    if (!state.activeTimer) {
        toast('Iniciá una tarea o eventualidad primero', 'warn');
        return;
    }

    // Si el timer está pausado, lo reanudamos
    if (state.activeTimer.paused) resumeTimer();

    // Arranca el countdown del pomodoro en paralelo
    intervalo = setInterval(tickPomodoroVinculado, 1000);
}

// Pausar
function pausarTemporizador() {
    clearInterval(intervalo);
    intervalo = null;

    // Si estamos en modo corto/largo y hay un timer activo, también lo pausamos
    if (!esModoDescanso() && state.activeTimer && !state.activeTimer.paused) {
        pauseTimer();
    }
}

// Reset: solo resetea el display del pomodoro,
// NO detiene el timer de la tarea (igual que antes)
function resetTemporizador() {
    clearInterval(intervalo);
    intervalo = null;
    reiniciarTemporizador();
}

// Botones Reloj
document.getElementById("pomStartBtn").addEventListener("click", iniciarTemporizador);
document.getElementById("pomPauseBtn").addEventListener("click", pausarTemporizador);
document.getElementById("pomResetBtn").addEventListener("click", resetTemporizador);


// ═══════════════════════════════════════════
// CLOCK
// ═══════════════════════════════════════════
function tickClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('dateLabel').textContent =
    now.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
}
setInterval(tickClock, 1000);
tickClock();

// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════
const viewTitles = {
  dashboard: 'Dashboard', tasks: 'Tareas estándar',
  events: 'Eventualidades', calendar: 'Calendario',
  reminders: 'Recordatorios', analytics: 'Analytics', projects: 'Proyectos', log: 'Historial', datos: 'Gestión de datos'
};
const viewOrder = ['dashboard','tasks','events','calendar','reminders','analytics','log','datos'];
let currentView = 'dashboard';
function showView(v) {
  currentView = v;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById('view-' + v).classList.add('active');
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === v));
  // "Más" en la barra inferior queda activo para las vistas secundarias
  const more = document.getElementById('bnMore');
  if (more) more.classList.toggle('active', !['dashboard', 'tasks', 'events', 'calendar'].includes(v));
  closeModal('moreSheet');
  document.getElementById('headerTitle').textContent = viewTitles[v] || v;
  window.scrollTo({ top: 0 });
  if (v === 'analytics') { renderAnalytics(); return; }
  if (v === 'datos') {
    const el = document.getElementById('skipWeekendsToggle');
    if (el) el.checked = state.config?.skipWeekends !== false;
  }
  renderAll();
}

// ═══════════════════════════════════════════
// TIMER ENGINE
// ═══════════════════════════════════════════
let timerInterval = null;

function getElapsed(timer) {
  if (!timer) return 0;
  const now = Date.now();
  let elapsed = timer.paused ? timer.pausedMs : (now - timer.start) + (timer.pausedMs || 0);
  return elapsed;
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(x => String(x).padStart(2, '0')).join(':');
}

function startTimer(id, type) {
  if (state.activeTimer) {
    const cur = state.activeTimer;
    // log the previous session
    const elapsed = getElapsed(cur);
    logSession(cur.id, cur.type, elapsed);
    updateItemTime(cur.id, cur.type, elapsed);
    stopTimerSilent();
  }
  state.activeTimer = { id, type, start: Date.now(), paused: false, pausedMs: 0 };
  const it = (type === 'task' ? state.tasks : state.events).find(x => x.id === id);
  if (it && !it.done) it.status = 'doing';
  save();
  startTicking();
  toast('Temporizador iniciado', 'success');
  renderAll();
}

function pauseTimer() {
  if (!state.activeTimer || state.activeTimer.paused) return;
  const elapsed = Date.now() - state.activeTimer.start + (state.activeTimer.pausedMs || 0);
  state.activeTimer.pausedMs = elapsed;
  state.activeTimer.paused = true;

  // Si el pomodoro está corriendo y vinculado a esta tarea, lo frenamos también
  if (intervalo && !esModoDescanso()) {
    clearInterval(intervalo);
    intervalo = null;
  }

  save();
  toast('⏸ Pausado', 'warn');
  renderAll();
}

function resumeTimer() {
  if (!state.activeTimer || !state.activeTimer.paused) return;
  state.activeTimer.start = Date.now();
  state.activeTimer.paused = false;

  // Si el pomodoro está vinculado y todavía le queda tiempo,
  // lo volvemos a arrancar en paralelo
  if (!esModoDescanso() && segundosRestantes > 0
      && segundosRestantes < obtenerMinutos() * 60) {
    intervalo = setInterval(tickPomodoroVinculado, 1000);
  }

  save();
  toast('▶ Reanudado', 'success');
  renderAll();
}

function stopTimer(id, type) {
  if (!state.activeTimer || state.activeTimer.id !== id) return;
  const elapsed = getElapsed(state.activeTimer);
  logSession(id, type, elapsed);
  updateItemTime(id, type, elapsed);
  state.activeTimer = null;
  clearInterval(timerInterval);
  timerInterval = null;
  save();
  toast('✓ Sesión guardada: ' + fmtMs(elapsed), 'success');
  renderAll();
}

function stopTimerSilent() {
  state.activeTimer = null;
  clearInterval(timerInterval);
  timerInterval = null;
}

function startTicking() {
  clearInterval(timerInterval);
  const tick = () => {
    const at = state.activeTimer;
    if (!at) { stopTicking(); return; }
    const txt = fmtMs(getElapsed(at));
    document.querySelectorAll('[data-timer-live]').forEach(el => { el.textContent = txt; });
    document.querySelectorAll('[data-today-base]').forEach(el => { el.textContent = fmtMs(+el.dataset.todayBase + getElapsed(at)); });
    const base = currentUser ? currentUser.name + ' - Productividad' : 'Productividad';
    document.title = at.paused ? base : '⏱ ' + txt + ' · ' + base;
  };
  tick();
  timerInterval = setInterval(tick, 500);
}

function stopTicking() {
  clearInterval(timerInterval);
  timerInterval = null;
  document.title = currentUser ? currentUser.name + ' - Productividad' : 'Productividad';
}

// Llamado en cada render: si el timer activo llegó desde otro dispositivo
// (pull o realtime) arrancamos el tick acá también. Antes sólo arrancaba
// al tocar ▶ en ESTE dispositivo, por eso en el móvil quedaba congelado.
function ensureTicking() {
  if (state.activeTimer) { if (!timerInterval) startTicking(); }
  else if (timerInterval) stopTicking();
}

function updateItemTime(id, type, ms) {
  const arr = type === 'task' ? state.tasks : state.events;
  const item = arr.find(x => x.id === id);
  if (item) {
    item.totalMs = (item.totalMs || 0) + ms;
    save();
  }
}

function logSession(id, type, ms) {
  const arr = type === 'task' ? state.tasks : state.events;
  const item = arr.find(x => x.id === id);
  if (!item) return;
  state.log.unshift({
    id: uid(), taskId: id, type,
    name: item.name,
    freq: item.freq || '',
    ms, date: new Date().toISOString()
  });
  if (state.log.length > 500) state.log = state.log.slice(0, 500);
  save();
}

// ═══════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// PROYECTOS
// ═══════════════════════════════════════════
const PROJECT_COLORS = {
  green: 'var(--accent)', blue: 'var(--blue)', purple: 'var(--purple)',
  amber: 'var(--amber)', red: 'var(--red)', gray: 'var(--text2)',
};
let currentProjectId = null; // proyecto abierto en la vista de detalle

function projectById(id) { return id ? state.projects.find(p => p.id === id) : null; }
function projectColor(p) { return PROJECT_COLORS[p?.color] || PROJECT_COLORS.green; }
function activeProjects() {
  return state.projects.filter(p => p.status !== 'archived')
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function projectChip(projectId) {
  const p = projectById(projectId);
  if (!p) return '';
  const col = projectColor(p);
  return `<span class="tag tag-project" style="color:${col};border-color:color-mix(in srgb, ${col} 35%, transparent);background:color-mix(in srgb, ${col} 10%, transparent)" onclick="event.stopPropagation();openProject('${p.id}')" title="Abrir proyecto">📁 ${esc(p.name)}</span>`;
}

// Completa los <select> de proyecto (modales y filtros) sin perder lo elegido
function fillProjectSelects() {
  const opts = activeProjects().map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const sets = [
    ['nt-project', '<option value="">Sin proyecto</option>'],
    ['ne-project', '<option value="">Sin proyecto</option>'],
    ['filterProject', '<option value="">Todos los proyectos</option><option value="__none">Sin proyecto</option>'],
    ['boardProject', '<option value="">Todos los proyectos</option><option value="__none">Sin proyecto</option>'],
  ];
  for (const [id, head] of sets) {
    const el = document.getElementById(id);
    if (!el) continue;
    const prev = el.value;
    el.innerHTML = head + opts;
    if ([...el.options].some(o => o.value === prev)) el.value = prev;
  }
}

function matchesProjectFilter(item, filter) {
  if (!filter) return true;
  if (filter === '__none') return !projectById(item.projectId);
  return item.projectId === filter;
}

function openNewProjectModal(id) {
  const p = typeof id === 'string' ? projectById(id) : null;
  document.getElementById('np-id').value = p ? p.id : '';
  document.getElementById('np-title').textContent = p ? 'Editar proyecto' : 'Nuevo proyecto';
  document.getElementById('np-name').value = p ? p.name : '';
  document.getElementById('np-notes').value = p ? (p.notes || '') : '';
  document.getElementById('np-due').value = p ? (p.due || '') : '';
  const color = p?.color || 'green';
  document.querySelectorAll('#np-colors [data-color]').forEach(b => b.classList.toggle('active', b.dataset.color === color));
  document.getElementById('newProjectModal').classList.add('open');
  document.getElementById('np-name').focus();
}

function pickProjectColor(btn) {
  document.querySelectorAll('#np-colors [data-color]').forEach(b => b.classList.toggle('active', b === btn));
}

function saveProject() {
  const name = document.getElementById('np-name').value.trim();
  if (!name) { toast('Ingresá un nombre', 'warn'); return; }
  const id = document.getElementById('np-id').value;
  const data = {
    name,
    notes: document.getElementById('np-notes').value.trim(),
    due: document.getElementById('np-due').value || null,
    color: document.querySelector('#np-colors [data-color].active')?.dataset.color || 'green',
  };
  if (id) {
    Object.assign(projectById(id), data);
    toast('Proyecto actualizado ✓', 'success');
  } else {
    state.projects.push({ id: uid(), ...data, status: 'active', createdAt: new Date().toISOString() });
    toast('Proyecto creado ✓', 'success');
  }
  save();
  closeModal('newProjectModal');
  renderAll();
}

function toggleArchiveProject(id) {
  const p = projectById(id);
  if (!p) return;
  p.status = p.status === 'archived' ? 'active' : 'archived';
  save(); renderAll();
  toast(p.status === 'archived' ? 'Proyecto archivado' : 'Proyecto reactivado', 'success');
}

function deleteProject(id) {
  const p = projectById(id);
  if (!p) return;
  const n = state.tasks.filter(t => t.projectId === id).length + state.events.filter(e => e.projectId === id).length;
  const msg = n
    ? `¿Eliminar el proyecto "${p.name}"? Sus ${n} tarea(s) no se borran: quedan "sin proyecto".`
    : `¿Eliminar el proyecto "${p.name}"?`;
  if (!confirm(msg)) return;
  state.tasks.forEach(t => { if (t.projectId === id) t.projectId = null; });
  state.events.forEach(e => { if (e.projectId === id) e.projectId = null; });
  state.projects = state.projects.filter(x => x.id !== id);
  if (currentProjectId === id) currentProjectId = null;
  save(); renderAll();
}

function setItemProject(id, type, projectId) {
  const item = findItem(id, type);
  if (!item) return;
  item.projectId = projectId || null;
  save(); renderAll();
  const p = projectById(projectId);
  toast(p ? `Asignada a 📁 ${p.name}` : 'Quitada del proyecto', 'success');
}

function openProject(id) {
  currentProjectId = id;
  showView('projects');
}
function closeProject() {
  currentProjectId = null;
  renderProjects();
}

function projectStats(p) {
  const tasks = state.tasks.filter(t => t.projectId === p.id);
  const events = state.events.filter(e => e.projectId === p.id);
  const all = [...tasks, ...events];
  const done = all.filter(x => x.done).length;
  const ms = all.reduce((a, x) => a + (x.totalMs || 0), 0)
    + (state.activeTimer && all.some(x => x.id === state.activeTimer.id) ? getElapsed(state.activeTimer) : 0);
  const overdue = tasks.filter(t => !t.done && t.due && t.due < today()).length;
  return { tasks, events, total: all.length, done, pending: all.length - done, ms, overdue,
           pct: all.length ? Math.round(done / all.length * 100) : 0 };
}

function renderProjects() {
  const grid = document.getElementById('projectGrid');
  const detail = document.getElementById('projectDetail');
  if (!grid || !detail) return;
  const count = document.getElementById('projectCount');
  if (count) count.textContent = activeProjects().length;

  const p = projectById(currentProjectId);
  document.getElementById('projectListHead').style.display = p ? 'none' : '';
  grid.style.display = p ? 'none' : '';
  detail.style.display = p ? '' : 'none';

  if (!p) {
    const showArchived = document.getElementById('projectShowArchived')?.checked;
    const list = state.projects
      .filter(x => showArchived || x.status !== 'archived')
      .sort((a, b) => (a.status === 'archived') - (b.status === 'archived') || (a.name || '').localeCompare(b.name || ''));
    grid.innerHTML = list.length ? list.map(x => {
      const st = projectStats(x);
      const col = projectColor(x);
      const dueTxt = x.due ? `<span class="task-due ${x.due < today() && st.pending ? 'overdue' : ''}">🎯 ${fmtDate(x.due)}</span>` : '';
      return `
      <div class="project-card ${x.status === 'archived' ? 'archived' : ''}" style="--pc:${col}" onclick="openProject('${x.id}')">
        <div class="project-card-head">
          <span class="project-dot"></span>
          <div class="project-name">${esc(x.name)}</div>
          ${x.status === 'archived' ? '<span class="tag tag-done">Archivado</span>' : ''}
        </div>
        ${x.notes ? `<div class="project-notes">${esc(x.notes)}</div>` : ''}
        <div class="project-progress"><div style="width:${st.pct}%"></div></div>
        <div class="project-meta">
          <span>${st.done}/${st.total} hechas · ${st.pct}%</span>
          <span>⏱ ${fmtMs(st.ms)}</span>
        </div>
        <div class="project-meta">
          ${st.overdue ? `<span style="color:var(--red)">⚠ ${st.overdue} vencida${st.overdue > 1 ? 's' : ''}</span>` : '<span></span>'}
          ${dueTxt}
        </div>
      </div>`;
    }).join('') : `<div class="empty" style="grid-column:1/-1"><div class="empty-icon">📁</div>Todavía no hay proyectos.<br><br><button class="btn btn-accent" onclick="openNewProjectModal()">+ Crear el primero</button></div>`;
    return;
  }

  const st = projectStats(p);
  const col = projectColor(p);
  const filter = document.getElementById('projectTaskFilter')?.value || 'pending';
  const sortItems = arr => arr.sort((a, b) => (a.item.done - b.item.done) || ((a.item.due || a.item.date || '') < (b.item.due || b.item.date || '') ? -1 : 1));
  let items = sortItems([...st.tasks.map(item => ({ item, type: 'task' })), ...st.events.map(item => ({ item, type: 'event' }))]);
  if (filter === 'pending') items = items.filter(e => !e.item.done);
  if (filter === 'done') items = items.filter(e => e.item.done);

  detail.innerHTML = `
    <button class="btn btn-sm" onclick="closeProject()">← Proyectos</button>
    <div class="project-hero" style="--pc:${col}">
      <div class="project-hero-main">
        <div class="project-card-head"><span class="project-dot"></span><div class="project-hero-name">${esc(p.name)}</div>
          ${p.status === 'archived' ? '<span class="tag tag-done">Archivado</span>' : ''}</div>
        ${p.notes ? `<div class="project-notes" style="-webkit-line-clamp:unset">${esc(p.notes)}</div>` : ''}
        <div class="project-progress" style="margin-top:12px"><div style="width:${st.pct}%"></div></div>
        <div class="project-meta">
          <span>${st.done}/${st.total} hechas · ${st.pct}%</span>
          <span>⏱ ${fmtMs(st.ms)} invertido</span>
          ${p.due ? `<span>🎯 Entrega ${fmtDate(p.due)}</span>` : ''}
        </div>
      </div>
      <div class="project-hero-actions">
        <button class="btn btn-accent btn-sm" onclick="openNewTaskModal('${p.id}')">+ Tarea</button>
        <button class="btn btn-sm" onclick="openNewProjectModal('${p.id}')">✎ Editar</button>
        <button class="btn btn-sm" onclick="toggleArchiveProject('${p.id}')">${p.status === 'archived' ? '↺ Reactivar' : '🗄 Archivar'}</button>
        <button class="btn btn-sm btn-red" onclick="deleteProject('${p.id}')">✕</button>
      </div>
    </div>
    <div class="section-head">
      <div class="section-title">Tareas del proyecto <span class="count-badge">${items.length}</span></div>
      <select id="projectTaskFilter" onchange="renderProjects()" style="width:auto;padding:6px 10px;font-size:11px;">
        <option value="pending" ${filter === 'pending' ? 'selected' : ''}>Pendientes</option>
        <option value="done" ${filter === 'done' ? 'selected' : ''}>Completadas</option>
        <option value="all" ${filter === 'all' ? 'selected' : ''}>Todas</option>
      </select>
    </div>
    ${items.length ? items.map(e => renderTaskItem(e.item, e.type)).join('')
      : `<div class="empty"><div class="empty-icon">📁</div>${filter === 'pending' ? 'No hay tareas pendientes en este proyecto.' : 'Sin tareas.'}<br><span style="font-size:11px">Creá una con "+ Tarea" o asigná una existente desde el menú ⋯ de su tarjeta en el tablero.</span></div>`}`;
}

function openNewTaskModal(projectId) {
  fillProjectSelects();
  document.getElementById('nt-project').value = typeof projectId === 'string' ? projectId : (currentView === 'projects' && currentProjectId) || '';
  document.getElementById('nt-name').value = '';
  document.getElementById('nt-freq').value = 'sinfreq';
  document.getElementById('nt-due').value = today();
  document.getElementById('nt-notes').value = '';
  document.getElementById('newTaskModal').classList.add('open');
  document.getElementById('nt-name').focus();
}
function saveNewTask() {
  const name = document.getElementById('nt-name').value.trim();
  if (!name) { toast('Ingresá un nombre', 'warn'); return; }
  state.tasks.push({
    id: uid(), name,
    freq: document.getElementById('nt-freq').value,
    due: document.getElementById('nt-due').value,
    notes: document.getElementById('nt-notes').value,
    projectId: document.getElementById('nt-project').value || null,
    done: false, totalMs: 0,
    createdAt: new Date().toISOString()
  });
  save();
  closeModal('newTaskModal');
  toast('Tarea creada ✓', 'success');
  renderAll();
}
function deleteTask(id) {
  if (!confirm('¿Eliminar esta tarea?')) return;
  state.tasks = state.tasks.filter(t => t.id !== id);
  if (state.activeTimer?.id === id) stopTimerSilent();
  save(); renderAll();
}

// ═══════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════
function openNewEventModal() {
  fillProjectSelects();
  document.getElementById('ne-project').value = (currentView === 'projects' && currentProjectId) || '';
  document.getElementById('ne-name').value = '';
  document.getElementById('ne-prio').value = 'low';
  document.getElementById('ne-date').value = today();
  document.getElementById('ne-notes').value = '';
  document.getElementById('newEventModal').classList.add('open');
  document.getElementById('ne-name').focus();
}
function saveNewEvent() {
  const name = document.getElementById('ne-name').value.trim();
  if (!name) { toast('Ingresá una descripción', 'warn'); return; }
  
  const event = {
    id: uid(), name,
    prio: document.getElementById('ne-prio').value,
    date: document.getElementById('ne-date').value,
    notes: document.getElementById('ne-notes').value,
    projectId: document.getElementById('ne-project').value || null,
    done: false, totalMs: 0,
    createdAt: new Date().toISOString()
  };

  state.events.push(event);

  save();
// inicio automatico de evento
  startTimer(event.id,'event');

  closeModal('newEventModal');
  toast('Eventualidad registrada ✓', 'success');
  renderAll();
}
function deleteEvent(id) {
  if (!confirm('¿Eliminar?')) return;
  state.events = state.events.filter(e => e.id !== id);
  if (state.activeTimer?.id === id) stopTimerSilent();
  save(); renderAll();
}

// ═══════════════════════════════════════════
// REMINDERS
// ═══════════════════════════════════════════
function openReminderModal() {
  document.getElementById('rm-text').value = '';
  document.getElementById('rm-date').value = today();
  document.getElementById('rm-time').value = '';
  document.getElementById('reminderModal').classList.add('open');
  document.getElementById('rm-text').focus();
}
function saveReminder() {
  const text = document.getElementById('rm-text').value.trim();
  if (!text) { toast('Ingresá el recordatorio', 'warn'); return; }
  state.reminders.push({
    id: uid(), text,
    date: document.getElementById('rm-date').value,
    time: document.getElementById('rm-time').value,
    done: false
  });
  save();
  closeModal('reminderModal');
  toast('Recordatorio guardado ✓', 'success');
  renderAll();
}
function dismissReminder(id) {
  const r = state.reminders.find(x => x.id === id);
  if (r) { r.done = true; save(); renderAll(); }
}
function deleteReminder(id) {
  state.reminders = state.reminders.filter(r => r.id !== id);
  save(); renderAll();
}

// ═══════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════
// Fecha LOCAL (antes usaba UTC: desde las 21hs en Argentina "hoy" ya era mañana)
function localISODate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function dayOf(iso) { return iso ? localISODate(new Date(iso)) : ''; }
function today() { return localISODate(new Date()); }
function tomorrow() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return localISODate(d);
}
function fmtDate(d) {
  if (!d) return '';
  const parts = d.split('-');
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}
function dueClass(due, done) {
  if (!due || done) return '';
  if (due < today()) return 'overdue';
  if (due === today()) return 'today';
  return '';
}
function dueLabel(due, done) {
  if (!due) return '';
  if (done) return fmtDate(due); // completada: solo muestra la fecha sin alerta
  if (due < today()) return '⚠ Vencida';
  if (due === today()) return '⏰ Hoy';
  if (due === tomorrow()) return '↗ Mañana';
  return fmtDate(due);
}
function freqTag(freq) {
  const map = { sinfreq: ['tag-sinfreq','Sin frecuencia'], daily: ['tag-daily','Diaria'], weekly: ['tag-weekly','Semanal'], biweekly: ['tag-biweekly','Quincenal'], monthly: ['tag-monthly','Mensual'] };
  const [cls, lbl] = map[freq] || ['',''];
  return `<span class="tag ${cls}">${lbl}</span>`;
}
function prioColor(p) { return { high: 'var(--red)', medium: 'var(--amber)', low: 'var(--accent)' }[p] || 'var(--text3)'; }

function renderTaskItem(item, type) {
  const at = state.activeTimer;
  const isRunning = at && at.id === item.id && !at.paused;
  const isPaused = at && at.id === item.id && at.paused;
  const statusCls = isRunning ? 'running' : isPaused ? 'paused' : item.done ? 'done' : '';
  const totalFmt = fmtMs(item.totalMs || 0);

  let timerHtml = '';
  if (isRunning) {
    timerHtml = `
      <div class="timer-display" data-timer-live>${fmtMs(getElapsed(at))}</div>
      <div class="timer-controls">
        <button class="btn btn-sm" onclick="pauseTimer()">⏸ Pausar</button>
        <button class="btn btn-sm btn-red" onclick="stopTimer('${item.id}','${type}')">■ Detener</button>
      </div>`;
  } else if (isPaused) {
    timerHtml = `
      <div class="timer-display paused" data-timer-live>${fmtMs(getElapsed(at))}</div>
      <div class="timer-controls">
        <button class="btn btn-sm btn-accent" onclick="resumeTimer()">▶ Continuar</button>
        <button class="btn btn-sm btn-red" onclick="stopTimer('${item.id}','${type}')">■ Detener</button>
      </div>`;
  }

  const typeTag = type === 'task' ? freqTag(item.freq) :
    `<span class="tag tag-event" style="border-color:${prioColor(item.prio)}33;color:${prioColor(item.prio)};background:${prioColor(item.prio)}11;">⚡ ${item.prio === 'high' ? 'Urgente' : item.prio === 'medium' ? 'Media' : 'Baja'}</span>`;

  const dueStr = type === 'task' ? item.due : item.date;

  return `
  <div class="task-item ${statusCls}" id="ti-${item.id}">
    <div class="task-check ${item.done ? 'checked' : ''}" onclick="toggleDone('${item.id}','${type}')">
      ${item.done ? '✓' : ''}
    </div>
    <div class="task-body">
      <div class="task-name" style="${item.done ? 'text-decoration:line-through;opacity:0.5' : ''}">${esc(item.name)}</div>
      <div class="task-info">
        ${typeTag}
        ${currentView === 'projects' ? '' : projectChip(item.projectId)}
        <span class="task-due ${dueClass(dueStr, item.done)}">${dueLabel(dueStr, item.done)}</span>
        ${item.totalMs > 0 ? `<span class="task-timer-val">⏱ ${totalFmt}</span>` : ''}
      </div>
      ${item.notes ? `<div class="task-notes">${esc(item.notes)}</div>` : ''}
      ${timerHtml}
    </div>
    <div class="task-actions">
      ${!item.done && !isRunning && !isPaused ? `<button class="btn btn-sm btn-accent" onclick="startTimer('${item.id}','${type}')">▶ Iniciar</button>` : ''}
      <button class="btn btn-sm btn-icon" onclick="${type === 'task' ? `deleteTask('${item.id}')` : `deleteEvent('${item.id}')`}" title="Eliminar">✕</button>
    </div>
  </div>`;
}

function renderTasks() {
  const freq = document.getElementById('filterFreq')?.value || '';
  const status = document.getElementById('filterStatus')?.value || '';
  let items = state.tasks;
  const projF = document.getElementById('filterProject')?.value || '';
  if (projF) items = items.filter(t => matchesProjectFilter(t, projF));
  if (freq === 'sinfreq') items = items.filter(t => !t.freq || t.freq === 'sinfreq');
  else if (freq) items = items.filter(t => t.freq === freq);
  if (status === 'pending') items = items.filter(t => !t.done);
  else if (status === 'done') items = items.filter(t => t.done);
  else if (status === 'all') { /* mostrar todo */ }
  else {
    // Vista por defecto: pendientes de hoy/futuras + completadas de hoy
    // Vista por defecto: pendientes (incluidas las vencidas) + completadas hoy
    items = items.filter(t => !t.done || dayOf(t.completedAt) === today() || (t.done && t.due === today()));
  }
  // sort: overdue first, then by due date, done last
  items.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (a.due || '') < (b.due || '') ? -1 : 1;
  });
  const el = document.getElementById('taskList');
  if (!el) return;
  el.innerHTML = items.length ? items.map(t => renderTaskItem(t, 'task')).join('') :
    '<div class="empty"><div class="empty-icon">✓</div>No hay tareas. Creá una con el botón superior.</div>';
  document.getElementById('taskCount').textContent = state.tasks.filter(t => !t.done && t.due === today()).length;
}

function renderEvents() {
  let items = [...state.events].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const po = { high: 0, medium: 1, low: 2 };
    return (po[a.prio] || 1) - (po[b.prio] || 1);
  });
  const el = document.getElementById('eventList');
  const status = document.getElementById('eventStatus')?.value || '';
  if (status === 'pending') {items = items.filter(e => !e.done);}
  if (status === 'done') {items = items.filter(e => e.done);}
  if (status === 'all') { }
  if (!el) return;
  el.innerHTML = items.length ? items.map(e => renderTaskItem(e, 'event')).join('') :
    '<div class="empty"><div class="empty-icon">⚡</div>No hay eventualidades registradas.</div>';
  document.getElementById('eventCount').textContent = state.events.filter(e => !e.done).length;
}

// ═══════════════════════════════════════════
// DASHBOARD + TABLERO KANBAN
// ═══════════════════════════════════════════
const KCOLS = [
  { id: 'todo',    title: 'Por hacer', icon: '○', hint: 'Arrastrá acá lo que viene' },
  { id: 'doing',   title: 'En curso',  icon: '▶', hint: 'Lo que estás haciendo ahora' },
  { id: 'waiting', title: 'En espera', icon: '⏸', hint: 'Bloqueado o esperando a alguien' },
  { id: 'done',    title: 'Hecho',     icon: '✓', hint: 'Soltá acá para completar' },
];
const BOARD_PREF_KEY = 'workflow_board_prefs';
let boardPrefs = { scope: 'today', type: 'all', q: '' };
try { boardPrefs = { ...boardPrefs, ...JSON.parse(localStorage.getItem(BOARD_PREF_KEY) || '{}'), q: '' }; } catch (e) {}
if (!boardPrefs.project) boardPrefs.project = '';

function saveBoardPrefs() {
  try { localStorage.setItem(BOARD_PREF_KEY, JSON.stringify({ scope: boardPrefs.scope, type: boardPrefs.type, project: boardPrefs.project })); } catch (e) {}
}

function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localISODate(d);
}

function itemStatus(item) {
  if (item.done) return 'done';
  const at = state.activeTimer;
  if (at && at.id === item.id && !at.paused) return 'doing'; // timer corriendo = en curso
  const s = item.status;
  return (s === 'doing' || s === 'waiting') ? s : 'todo';
}

function findItem(id, type) {
  return (type === 'task' ? state.tasks : state.events).find(x => x.id === id);
}

function boardEntries() {
  const t = today();
  const scope = boardPrefs.scope;
  const q = (boardPrefs.q || '').trim().toLowerCase();
  const limit = scope === 'today' ? t : scope === 'week' ? addDaysISO(t, 7) : null;
  const doneFrom = scope === 'today' ? t : scope === 'week' ? addDaysISO(t, -7) : addDaysISO(t, -30);

  let list = [];
  if (boardPrefs.type !== 'event') list.push(...state.tasks.map(item => ({ item, type: 'task' })));
  if (boardPrefs.type !== 'task') list.push(...state.events.map(item => ({ item, type: 'event' })));

  list = list.filter(({ item, type }) => {
    if (q && !((item.name || '') + ' ' + (item.notes || '')).toLowerCase().includes(q)) return false;
    if (!matchesProjectFilter(item, boardPrefs.project)) return false;
    const st = itemStatus(item);
    if (st === 'done') {
      const d = dayOf(item.completedAt) || (type === 'task' ? item.due : item.date) || '';
      return d >= doneFrom;
    }
    if (st !== 'todo') return true;         // en curso / en espera: siempre visibles
    if (type === 'event') return true;      // eventualidades pendientes: siempre
    if (!limit || !item.due) return true;
    return item.due <= limit;
  });

  const prioRank = { high: 0, medium: 1, low: 2 };
  const freqRank = { sinfreq: 1, daily: 0, weekly: 2, biweekly: 3, monthly: 4 };
  const groupRank = ({ item, type }) => type === 'event' ? -1 : (freqRank[item.freq] ?? 9);
  const isOverdue = ({ item, type }) => type === 'task' && itemStatus(item) !== 'done' && !!item.due && item.due < t;
  const due = e => (e.type === 'task' ? e.item.due : e.item.date) || '9999';
  list.sort((a, b) => {
    const ga = groupRank(a), gb = groupRank(b);
    if (ga !== gb) return ga - gb;          // 1º: grupo (frecuencia)
    const va = isOverdue(a), vb = isOverdue(b);
    if (va !== vb) return va ? -1 : 1;      // 2º: dentro del grupo, vencidas arriba
    if (a.type === 'task') {
      const fa = freqRank[a.item.freq] ?? 9, fb = freqRank[b.item.freq] ?? 9;
      if (fa !== fb) return fa - fb;
    }
    const oa = a.item.sortOrder ?? Infinity, ob = b.item.sortOrder ?? Infinity;
    if (oa !== ob) return oa - ob;
    if (a.type !== b.type) return a.type === 'event' ? -1 : 1; // urgencias primero
    if (a.type === 'event') {
      const p = (prioRank[a.item.prio] ?? 1) - (prioRank[b.item.prio] ?? 1);
      if (p) return p;
    }
    return due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : 0;
  });
  return list;
}

function renderKanbanCard({ item, type }) {
  const at = state.activeTimer;
  const isActive = at && at.id === item.id;
  const isRunning = isActive && !at.paused;
  const st = itemStatus(item);
  const dueStr = type === 'task' ? item.due : item.date;
  const overdue = st !== 'done' && type === 'task' && dueStr && dueStr < today();

  const tag = type === 'task'
    ? freqTag(item.freq)
    : `<span class="tag tag-event" style="border-color:${prioColor(item.prio)}55;color:${prioColor(item.prio)};background:${prioColor(item.prio)}14;">⚡ ${item.prio === 'high' ? 'Urgente' : item.prio === 'medium' ? 'Media' : 'Baja'}</span>`;

  const timeHtml = isActive
    ? `<span class="kcard-time live ${at.paused ? 'paused' : ''}" data-timer-live>${fmtMs(getElapsed(at))}</span>`
    : (item.totalMs > 0 ? `<span class="kcard-time">⏱ ${fmtMs(item.totalMs)}</span>` : '<span></span>');

  let playBtn = '';
  if (st !== 'done') {
    if (isRunning) playBtn = `<button class="kbtn" data-act="pause" title="Pausar">⏸</button>`;
    else if (isActive) playBtn = `<button class="kbtn kbtn-accent" data-act="resume" title="Continuar">▶</button>`;
    else playBtn = `<button class="kbtn" data-act="start" title="Iniciar timer">▶</button>`;
  }

  return `
  <div class="kcard ${isRunning ? 'running' : isActive ? 'paused' : ''} ${overdue ? 'overdue' : ''} ${st === 'done' ? 'is-done' : ''}"
       data-id="${item.id}" data-type="${type}">
    <div class="kcard-top">
      ${tag}
      ${dueStr ? `<span class="task-due ${dueClass(dueStr, item.done)}">${type === 'event' ? fmtDate(dueStr) : dueLabel(dueStr, item.done)}</span>` : ''}
    </div>
    <div class="kcard-title">${esc(item.name)}</div>
    ${projectChip(item.projectId) ? `<div class="kcard-project">${projectChip(item.projectId)}</div>` : ''}
    ${item.notes ? `<div class="kcard-notes">${esc(item.notes)}</div>` : ''}
    <div class="kcard-foot">
      ${timeHtml}
      <div class="kcard-actions">
        ${playBtn}
        <button class="kbtn ${st === 'done' ? 'kbtn-accent' : ''}" data-act="done" title="${st === 'done' ? 'Reabrir' : 'Completar'}">✓</button>
        <button class="kbtn" data-act="menu" title="Más opciones">⋯</button>
      </div>
    </div>
  </div>`;
}

function renderKanban() {
  const el = document.getElementById('kanbanBoard');
  if (!el) return;
  const entries = boardEntries();
  const byCol = Object.fromEntries(KCOLS.map(c => [c.id, []]));
  entries.forEach(e => byCol[itemStatus(e.item)].push(e));

  el.innerHTML = KCOLS.map(c => `
    <section class="kcol kcol-${c.id}" data-col="${c.id}">
      <header class="kcol-head">
        <span class="kcol-icon">${c.icon}</span>
        <span class="kcol-title">${c.title}</span>
        <span class="count-badge">${byCol[c.id].length}</span>
        ${c.id === 'todo' ? `<button class="kcol-add" onclick="openNewTaskModal()" title="Nueva tarea">+</button>` : ''}
      </header>
      <div class="kcol-body" data-col="${c.id}">
        ${byCol[c.id].map(renderKanbanCard).join('') || `<div class="kcol-empty">${c.hint}</div>`}
      </div>
    </section>`).join('');

  // Indicadores de columna (móvil)
  const dots = document.getElementById('kanbanDots');
  if (dots) dots.innerHTML = KCOLS.map(c => `<button data-goto="${c.id}">${c.title} <b>${byCol[c.id].length}</b></button>`).join('');

  document.querySelectorAll('#boardScope [data-scope]').forEach(b => b.classList.toggle('active', b.dataset.scope === boardPrefs.scope));
  document.querySelectorAll('#boardType [data-type]').forEach(b => b.classList.toggle('active', b.dataset.type === boardPrefs.type));
}

function renderFocusCard() {
  const el = document.getElementById('activeTasksArea');
  if (!el) return;
  const at = state.activeTimer;
  const item = at ? findItem(at.id, at.type) : null;
  if (at && item) {
    const tag = at.type === 'task' ? freqTag(item.freq) : `<span class="tag tag-event">⚡ Eventualidad</span>`;
    el.innerHTML = `
      <div class="focus-card ${at.paused ? 'paused' : 'running'}">
        <div class="focus-info">
          <div class="focus-label">${at.paused ? '⏸ En pausa' : '● En curso ahora'}</div>
          <div class="focus-name">${esc(item.name)}</div>
          <div class="task-info">${tag}${item.totalMs > 0 ? `<span class="task-timer-val">acumulado ${fmtMs(item.totalMs)}</span>` : ''}</div>
        </div>
        <div class="focus-timer ${at.paused ? 'paused' : ''}" data-timer-live>${fmtMs(getElapsed(at))}</div>
        <div class="focus-actions">
          ${at.paused
            ? `<button class="btn btn-accent" onclick="resumeTimer()">▶ Continuar</button>`
            : `<button class="btn" onclick="pauseTimer()">⏸ Pausar</button>`}
          <button class="btn" onclick="stopTimer('${item.id}','${at.type}')">■ Detener</button>
          <button class="btn btn-accent-outline" onclick="toggleDone('${item.id}','${at.type}')">✓ Completar</button>
        </div>
      </div>`;
    return;
  }
  // Sin timer: sugerimos la próxima
  const next = boardEntries().find(e => itemStatus(e.item) !== 'done');
  el.innerHTML = `
    <div class="focus-card idle">
      <div class="focus-info">
        <div class="focus-label">Nada en curso</div>
        <div class="focus-name">${next ? esc(next.item.name) : '¡Todo al día! 🎉'}</div>
        ${next ? `<div class="task-info"><span class="focus-hint">Siguiente sugerida</span></div>` : ''}
      </div>
      ${next ? `<div class="focus-actions"><button class="btn btn-accent" onclick="startTimer('${next.item.id}','${next.type}')">▶ Empezar</button></div>` : ''}
    </div>`;
}

function renderDashboard() {
  const t = today();
  const todayTasks = state.tasks.filter(x => x.due === t || (x.done && dayOf(x.completedAt) === t));
  const todayDone  = todayTasks.filter(x => x.done).length;
  const totalToday = todayTasks.length;
  const overdue = state.tasks.filter(x => !x.done && x.due && x.due < t).length;
  const openEvents = state.events.filter(e => !e.done);
  const todayLogs = state.log.filter(l => dayOf(l.date) === t);
  let todayMs = todayLogs.reduce((a, b) => a + (b.ms || 0), 0);
  if (state.activeTimer) todayMs += getElapsed(state.activeTimer);
  const pct = totalToday ? Math.round(todayDone / totalToday * 100) : 0;
  const rems = state.reminders.filter(r => !r.done && r.date >= t);

  const hello = document.getElementById('dashHello');
  if (hello) {
    const h = new Date().getHours();
    const saludo = h < 12 ? 'Buen día' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
    hello.textContent = `${saludo}${currentUser ? ', ' + currentUser.name : ''}`;
  }
  const sub = document.getElementById('dashSub');
  if (sub) sub.textContent = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

  document.getElementById('statsGrid').innerHTML = `
    <div class="stat">
      <div class="stat-row"><div class="stat-val">${todayDone}<span class="stat-of">/${totalToday}</span></div><div class="stat-pct">${pct}%</div></div>
      <div class="stat-label">Tareas de hoy</div>
      <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
      ${overdue ? `<div class="stat-sub" style="color:var(--red)">${overdue} vencida${overdue > 1 ? 's' : ''}</div>` : ''}
    </div>
    <div class="stat" onclick="showView('events')" style="cursor:pointer">
      <div class="stat-val">${openEvents.length}</div>
      <div class="stat-label">Eventualidades abiertas</div>
      <div class="stat-sub" style="color:var(--red)">${openEvents.filter(e => e.prio === 'high').length} urgentes</div>
    </div>
    <div class="stat">
      <div class="stat-val" ${state.activeTimer && !state.activeTimer.paused ? `data-today-base="${todayMs - getElapsed(state.activeTimer)}"` : ''}>${fmtMs(todayMs)}</div>
      <div class="stat-label">Tiempo productivo hoy</div>
      <div class="stat-sub">${todayLogs.length} sesion${todayLogs.length === 1 ? '' : 'es'}</div>
    </div>
    <div class="stat" onclick="showView('reminders')" style="cursor:pointer">
      <div class="stat-val">${rems.length}</div>
      <div class="stat-label">Recordatorios</div>
      ${rems[0] ? `<div class="stat-sub" style="color:var(--blue)">${esc(rems[0].text.slice(0, 28))}${rems[0].text.length > 28 ? '…' : ''}</div>` : ''}
    </div>`;

  renderFocusCard();
  renderKanban();

  const remEl = document.getElementById('dashReminders');
  if (remEl) {
    remEl.innerHTML = rems.slice(0, 6).map(r => `
      <div class="rem-chip">
        <div>
          <div class="reminder-text">${esc(r.text)}</div>
          <div class="reminder-time">${fmtDate(r.date)}${r.time ? ' · ' + r.time : ''}</div>
        </div>
        <button class="btn btn-sm" onclick="dismissReminder('${r.id}')" title="Listo">✓</button>
      </div>`).join('') || '<div class="kcol-empty" style="padding:12px">Sin recordatorios activos</div>';
  }
}

// ── Acciones sobre tarjetas ─────────────────
function moveItem(id, type, toCol, beforeId) {
  const item = findItem(id, type);
  if (!item) return;
  const from = itemStatus(item);

  // Reordenar: tomamos el orden visible de la columna destino
  const colEntries = boardEntries().filter(e => itemStatus(e.item) === toCol && e.item.id !== id);
  let idx = beforeId ? colEntries.findIndex(e => e.item.id === beforeId) : -1;
  if (idx < 0) idx = colEntries.length;
  colEntries.splice(idx, 0, { item, type });
  colEntries.forEach((e, i) => { e.item.sortOrder = (i + 1) * 10; });

  if (from === toCol) { save(); renderAll(); return; }

  const at = state.activeTimer;
  const isActive = at && at.id === id;

  if (toCol === 'done') {
    item.status = 'done';
    if (!item.done) { toggleDone(id, type); return; }
  } else {
    item.status = toCol;
    if (item.done) {
      toggleDone(id, type); // reabrir
      item.status = toCol;
    }
    if (isActive && toCol === 'waiting' && !at.paused) pauseTimer();
    if (isActive && toCol === 'todo') stopTimer(id, type);
  }
  save();
  renderAll();
}

function cardAction(act, id, type, anchor) {
  const item = findItem(id, type);
  if (!item) return;
  if (act === 'start') startTimer(id, type);
  else if (act === 'pause') pauseTimer();
  else if (act === 'resume') resumeTimer();
  else if (act === 'done') {
    if (!item.done) item.status = 'done';
    else item.status = 'todo';
    toggleDone(id, type);
  }
  else if (act === 'menu') openCardMenu(id, type, anchor);
}

function openCardMenu(id, type, anchor) {
  closeCardMenu();
  const item = findItem(id, type);
  if (!item) return;
  const st = itemStatus(item);
  const menu = document.createElement('div');
  menu.className = 'card-menu';
  menu.id = 'cardMenu';
  menu.innerHTML = `
    <div class="card-menu-title">${esc(item.name)}</div>
    <div class="card-menu-sec">Mover a</div>
    ${KCOLS.filter(c => c.id !== st).map(c => `<button data-move="${c.id}">${c.icon} ${c.title}</button>`).join('')}
    <div class="card-menu-sep"></div>
    <div class="card-menu-sec">Proyecto</div>
    <select class="card-menu-select" data-project>
      <option value="">Sin proyecto</option>
      ${activeProjects().map(p => `<option value="${p.id}" ${p.id === item.projectId ? 'selected' : ''}>📁 ${esc(p.name)}</option>`).join('')}
    </select>
    <div class="card-menu-sep"></div>
    <button data-del="1" class="danger">✕ Eliminar</button>`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = top + 'px';
  menu.querySelector('[data-project]').addEventListener('change', e => {
    closeCardMenu();
    setItemProject(id, type, e.target.value);
  });
  menu.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    closeCardMenu();
    if (b.dataset.move) moveItem(id, type, b.dataset.move);
    if (b.dataset.del) type === 'task' ? deleteTask(id) : deleteEvent(id);
  });
  setTimeout(() => document.addEventListener('pointerdown', outsideMenu, true), 0);
}
function outsideMenu(e) {
  const m = document.getElementById('cardMenu');
  if (m && !m.contains(e.target)) closeCardMenu();
}
function closeCardMenu() {
  document.getElementById('cardMenu')?.remove();
  document.removeEventListener('pointerdown', outsideMenu, true);
}

// ── Drag & drop (mouse y touch, con Pointer Events) ──
// Mouse: arrastrar directamente. Touch: mantener apretado ~0,3s y arrastrar
// (así el scroll normal del tablero sigue funcionando).
(function initKanbanDnD() {
  const board = document.getElementById('kanbanBoard');
  if (!board) return;

  let drag = null; // { card, id, type, startX, startY, pointerId, ghost, offX, offY, active, timer }

  board.addEventListener('click', e => {
    const btn = e.target.closest('.kbtn');
    if (!btn) return;
    const card = btn.closest('.kcard');
    e.stopPropagation();
    cardAction(btn.dataset.act, card.dataset.id, card.dataset.type, btn);
  });

  board.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button, a, input')) return;
    const card = e.target.closest('.kcard');
    if (!card) return;
    drag = {
      card, id: card.dataset.id, type: card.dataset.type,
      startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
      pointerId: e.pointerId, active: false, touch: e.pointerType !== 'mouse',
    };
    if (drag.touch) {
      drag.timer = setTimeout(() => { if (drag) beginDrag(); }, 280);
    }
  });

  window.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX; drag.y = e.clientY;
    const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (!drag.active) {
      if (drag.touch) { if (dist > 10) cancelDrag(); } // fue un scroll
      else if (dist > 5) beginDrag();
      return;
    }
    e.preventDefault();
    moveGhost();
    placeHolder();
    autoScroll();
  }, { passive: false });

  board.addEventListener('contextmenu', e => { if (e.target.closest('.kcard')) e.preventDefault(); });
  // En iOS/Android hay que frenar el scroll nativo mientras arrastramos
  window.addEventListener('touchmove', e => { if (drag && drag.active) e.preventDefault(); }, { passive: false });

  window.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pointerId) endDrag(); });
  window.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.pointerId) { if (drag.active) endDrag(); else cancelDrag(); } });

  function beginDrag() {
    const r = drag.card.getBoundingClientRect();
    drag.active = true;
    drag.offX = drag.startX - r.left;
    drag.offY = drag.startY - r.top;
    const ghost = drag.card.cloneNode(true);
    ghost.classList.add('kcard-ghost');
    ghost.style.width = r.width + 'px';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.card.classList.add('kcard-placeholder');
    document.body.classList.add('is-dragging');
    uiBusy = true;
    closeCardMenu();
    if (navigator.vibrate && drag.touch) navigator.vibrate(15);
    moveGhost();
  }

  function moveGhost() {
    drag.ghost.style.transform = `translate(${drag.x - drag.offX}px, ${drag.y - drag.offY}px) rotate(2deg)`;
  }

  function placeHolder() {
    const under = document.elementFromPoint(drag.x, drag.y);
    const body = under && (under.closest('.kcol-body') || under.closest('.kcol')?.querySelector('.kcol-body'));
    document.querySelectorAll('.kcol.drop-target').forEach(c => c.classList.remove('drop-target'));
    if (!body) return;
    body.closest('.kcol').classList.add('drop-target');
    body.querySelector('.kcol-empty')?.remove();
    const cards = [...body.querySelectorAll('.kcard:not(.kcard-placeholder)')];
    const before = cards.find(c => {
      const r = c.getBoundingClientRect();
      return drag.y < r.top + r.height / 2;
    });
    if (before) { if (before.previousElementSibling !== drag.card) body.insertBefore(drag.card, before); }
    else if (body.lastElementChild !== drag.card) body.appendChild(drag.card);
  }

  function autoScroll() {
    const edge = 50;
    // horizontal (tablero en móvil)
    const br = board.getBoundingClientRect();
    if (drag.x < br.left + edge) board.scrollLeft -= 12;
    else if (drag.x > br.right - edge) board.scrollLeft += 12;
    // vertical (página)
    if (drag.y < edge) window.scrollBy(0, -12);
    else if (drag.y > window.innerHeight - edge - 70) window.scrollBy(0, 12);
  }

  function endDrag() {
    clearTimeout(drag.timer);
    const d = drag;
    drag = null;
    if (!d.active) return;
    d.ghost.remove();
    document.body.classList.remove('is-dragging');
    document.querySelectorAll('.kcol.drop-target').forEach(c => c.classList.remove('drop-target'));
    const body = d.card.parentElement;
    const toCol = body && body.dataset.col;
    const next = d.card.nextElementSibling;
    const beforeId = next && next.classList.contains('kcard') ? next.dataset.id : null;
    d.card.classList.remove('kcard-placeholder');
    uiBusy = false;
    if (toCol) moveItem(d.id, d.type, toCol, beforeId);
    else renderAll();
  }

  function cancelDrag() {
    clearTimeout(drag.timer);
    drag = null;
  }

  // Filtros del tablero
  document.getElementById('boardScope')?.addEventListener('click', e => {
    const b = e.target.closest('[data-scope]'); if (!b) return;
    boardPrefs.scope = b.dataset.scope; saveBoardPrefs(); renderDashboard();
  });
  document.getElementById('boardType')?.addEventListener('click', e => {
    const b = e.target.closest('[data-type]'); if (!b) return;
    boardPrefs.type = b.dataset.type; saveBoardPrefs(); renderDashboard();
  });
  document.getElementById('boardProject')?.addEventListener('change', e => {
    boardPrefs.project = e.target.value; saveBoardPrefs(); renderDashboard();
  });
  document.getElementById('boardSearch')?.addEventListener('input', e => {
    boardPrefs.q = e.target.value; renderKanban();
  });
  document.getElementById('kanbanDots')?.addEventListener('click', e => {
    const b = e.target.closest('[data-goto]'); if (!b) return;
    const col = board.querySelector(`.kcol[data-col="${b.dataset.goto}"]`);
    if (col) board.scrollTo({ left: col.offsetLeft - board.offsetLeft - 4, behavior: 'smooth' });
  });
})();

// Busca y elimina tareas duplicadas (mismo nombre, frecuencia y vencimiento,
// pendientes) que pudieron quedar de los problemas de sincronización anteriores.
function cleanDuplicateTasks() {
  const seen = new Map();
  const remove = new Set();
  state.tasks.forEach(t => {
    if (t.done) return;
    const key = [t.name, t.freq, t.due].join('|');
    const prev = seen.get(key);
    if (!prev) { seen.set(key, t); return; }
    // conservamos la que tiene más tiempo registrado
    const keep = (t.totalMs || 0) > (prev.totalMs || 0) ? t : prev;
    const drop = keep === t ? prev : t;
    keep.totalMs = Math.max(keep.totalMs || 0, drop.totalMs || 0);
    remove.add(drop.id);
    seen.set(key, keep);
  });
  if (!remove.size) { toast('No se encontraron tareas duplicadas', 'success'); return; }
  if (!confirm(`Se encontraron ${remove.size} tarea(s) duplicada(s). ¿Eliminarlas?`)) return;
  if (state.activeTimer && remove.has(state.activeTimer.id)) stopTimerSilent();
  state.tasks = state.tasks.filter(t => !remove.has(t.id));
  save(); renderAll();
  toast(`✓ ${remove.size} duplicada(s) eliminada(s)`, 'success');
}

// Barra inferior móvil: menú "Más" y botón flotante
function openMoreSheet() { document.getElementById('moreSheet').classList.add('open'); }
function toggleFab(force) {
  const f = document.getElementById('fab');
  if (!f) return;
  f.classList.toggle('open', force ?? !f.classList.contains('open'));
}
function fabAction(fn) { toggleFab(false); fn(); }


function renderReminders() {
  const el = document.getElementById('reminderList');
  if (!el) return;
  const rems = [...state.reminders].sort((a, b) => (a.date + (a.time||'')) < (b.date + (b.time||'')) ? -1 : 1);
  el.innerHTML = rems.length ? rems.map(r => `
    <div class="reminder-item" style="${r.done ? 'opacity:0.4' : ''}">
      <div style="flex:1">
        <div class="reminder-text" style="${r.done ? 'text-decoration:line-through' : ''}">${esc(r.text)}</div>
        <div class="reminder-time">${fmtDate(r.date)}${r.time ? ' · ' + r.time : ''}</div>
      </div>
      <div style="display:flex;gap:4px;">
        ${!r.done ? `<button class="btn btn-sm" onclick="dismissReminder('${r.id}')">✓ Listo</button>` : ''}
        <button class="btn btn-sm btn-red" onclick="deleteReminder('${r.id}')">✕</button>
      </div>
    </div>`).join('') :
    '<div class="empty"><div class="empty-icon">◎</div>No hay recordatorios. Agregá uno.</div>';
}

function renderLog() {
  const el = document.getElementById('logList');
  if (!el) return;
  el.innerHTML = state.log.length ? state.log.slice(0, 50).map(l => `
    <div class="log-entry">
      <div class="log-dot" style="background:${l.type === 'task' ? 'var(--accent)' : 'var(--red)'}"></div>
      <div style="flex:1">${esc(l.name)}</div>
      <div style="color:var(--accent)">${fmtMs(l.ms)}</div>
      <div style="color:var(--text3);min-width:80px;text-align:right">${new Date(l.date).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>
    </div>`).join('') :
    '<div class="empty">Sin sesiones registradas aún.</div>';

  // time report
  const reportEl = document.getElementById('timeReport');
  const allItems = [...state.tasks.filter(t => t.totalMs > 0), ...state.events.filter(e => e.totalMs > 0)]
    .sort((a, b) => b.totalMs - a.totalMs);
  reportEl.innerHTML = allItems.length ? allItems.map(item => `
    <div class="card" style="padding:12px 16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="font-size:13px;">${esc(item.name)}</div>
        <div style="font-family:var(--font-display);font-size:14px;font-weight:600;color:var(--accent)">${fmtMs(item.totalMs)}</div>
      </div>
    </div>`).join('') : '<div class="empty">Sin tiempo registrado aún.</div>';
}

function clearLog() {
  if (!confirm('¿Limpiar el historial completo? El tiempo acumulado en tareas se conserva.')) return;
  state.log = [];
  save(); renderLog();
  toast('Historial limpiado', 'success');
}

// ═══════════════════════════════════════════
// CALENDAR
// ═══════════════════════════════════════════
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();

function renderCalendar() {
  const el = document.getElementById('calGrid');
  if (!el) return;
  const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  document.getElementById('calTitle').textContent = `${months[calMonth]} ${calYear}`;

  const days = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const first = new Date(calYear, calMonth, 1).getDay();
  const last = new Date(calYear, calMonth + 1, 0).getDate();
  const prevLast = new Date(calYear, calMonth, 0).getDate();

  let html = days.map(d => `<div class="cal-day-head">${d}</div>`).join('');

  const allItems = [
    ...state.tasks.map(t => ({ ...t, _type: 'task', _date: t.due })),
    ...state.events.map(e => ({ ...e, _type: 'event', _date: e.date })),
    ...state.reminders.filter(r => !r.done).map(r => ({ ...r, _type: 'reminder', _date: r.date }))
  ];

  const todayStr = today();

  // prev month
  for (let i = first - 1; i >= 0; i--) {
    html += `<div class="cal-day other-month"><div class="cal-day-num">${prevLast - i}</div></div>`;
  }
  for (let d = 1; d <= last; d++) {
    const ds = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = ds === todayStr;
    const dayItems = allItems.filter(x => x._date === ds);
    const dots = dayItems.slice(0, 3).map(x => {
      const col = x._type === 'task' ? 'var(--accent)' : x._type === 'event' ? 'var(--red)' : 'var(--blue)';
      return `<div class="cal-dot" style="background:${col}18;color:${col};border:1px solid ${col}33;">${esc((x.name || x.title || x.text || "Sin nombre").slice(0,14))}${(x.name || x.title || x.text || "").length > 14?'…':''}</div>`;
    }).join('');
    html += `<div class="cal-day ${isToday ? 'today' : ''}" onclick="showDayDetail('${ds}')">
      <div class="cal-day-num">${d}</div>${dots}
    </div>`;
  }
  // fill rest
  const total = first + last;
  const remaining = total % 7 === 0 ? 0 : 7 - (total % 7);
  for (let i = 1; i <= remaining; i++) {
    html += `<div class="cal-day other-month"><div class="cal-day-num">${i}</div></div>`;
  }
  el.innerHTML = html;
}

function showDayDetail(ds) {
  const allItems = [
    ...state.tasks.filter(t => t.due === ds).map(t => ({ ...t, _type: 'task' })),
    ...state.events.filter(e => e.date === ds).map(e => ({ ...e, _type: 'event' })),
    ...state.reminders.filter(r => r.date === ds && !r.done).map(r => ({ ...r, _type: 'reminder' }))
  ];
  const el = document.getElementById('calDayDetail');
  if (!allItems.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="section-head"><div class="section-title">📅 ${fmtDate(ds)}</div></div>` +
    allItems.map(item => {
      if (item._type === 'reminder') return `<div class="reminder-item"><div><div class="reminder-text">◎ ${esc(item.text)}</div></div></div>`;
      return renderTaskItem(item, item._type);
    }).join('');
}

function changeMonth(dir) {
  calMonth += dir;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
}

// ═══════════════════════════════════════════
// MODAL + TOAST
// ═══════════════════════════════════════════
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
});

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ═══════════════════════════════════════════
// EXPORT / IMPORT / DATOS
// ═══════════════════════════════════════════

function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'productividad_backup_' + today() + '.json';
  a.click(); URL.revokeObjectURL(a.href);
  toast('Backup JSON exportado ✓', 'success');
}

function exportCSV() {
  // Historial de sesiones
  const rows = [['Fecha', 'Hora', 'Tarea', 'Tipo', 'Frecuencia', 'Duración (hh:mm:ss)', 'Duración (min)']];
  [...state.log].reverse().forEach(l => {
    const d = new Date(l.date);
    rows.push([
      d.toLocaleDateString('es-AR'),
      d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
      '"' + (l.name || '').replace(/"/g, '""') + '"',
      l.type === 'task' ? 'Tarea' : 'Eventualidad',
      freqLabel(l.freq || ''),
      fmtMs(l.ms),
      Math.round(l.ms / 60000)
    ]);
  });
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'historial_sesiones_' + today() + '.csv';
  a.click(); URL.revokeObjectURL(a.href);
  toast('CSV de historial exportado ✓ (abre en Excel)', 'success');
}

function exportCSVTareas() {
  // Lista de tareas + eventualidades con tiempo acumulado
  const rows = [['Nombre', 'Tipo', 'Frecuencia', 'Vencimiento', 'Estado', 'Tiempo total (hh:mm:ss)', 'Tiempo total (min)', 'Creada']];
  state.tasks.forEach(t => {
    rows.push([
      '"' + t.name.replace(/"/g, '""') + '"',
      'Tarea',
      freqLabel(t.freq || ''),
      fmtDate(t.due),
      t.done ? 'Completada' : 'Pendiente',
      fmtMs(t.totalMs || 0),
      Math.round((t.totalMs || 0) / 60000),
      fmtDate((t.createdAt || '').slice(0, 10))
    ]);
  });
  state.events.forEach(e => {
    rows.push([
      '"' + e.name.replace(/"/g, '""') + '"',
      'Eventualidad',
      { high: 'Urgente', medium: 'Media', low: 'Baja' }[e.prio] || '',
      fmtDate(e.date),
      e.done ? 'Completada' : 'Pendiente',
      fmtMs(e.totalMs || 0),
      Math.round((e.totalMs || 0) / 60000),
      fmtDate((e.createdAt || '').slice(0, 10))
    ]);
  });
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tareas_' + today() + '.csv';
  a.click(); URL.revokeObjectURL(a.href);
  toast('CSV de tareas exportado ✓', 'success');
}

function importJSON(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.tasks && !data.log) { toast('Archivo JSON inválido', 'warn'); return; }
      if (!confirm('⚠ Esto reemplaza TODOS los datos actuales. ¿Continuar?')) { input.value = ''; return; }
      state = {
        projects: [], tasks: [], events: [], reminders: [], log: [], activeTimer: null,
        ...data
      };
      save(); renderAll();
      toast('Datos importados correctamente ✓', 'success');
    } catch (err) {
      toast('Error al leer el archivo JSON', 'warn');
    }
    input.value = '';
  };
  reader.readAsText(file);
}

function resetAll() {
  if (!confirm('¿Borrar TODOS los datos permanentemente?')) return;
  if (!confirm('Segunda confirmación: esta acción es irreversible.')) return;
  state = { projects: [], tasks: [], events: [], reminders: [], log: [], activeTimer: null };
  save(); renderAll();
  toast('Datos borrados', 'warn');
}

// ═══════════════════════════════════════════
// RECURRENCIAS AUTOMÁTICAS
// ═══════════════════════════════════════════
const FREQ_DAYS = { sinfreq: 0, daily: 1, weekly: 7, biweekly: 15, monthly: 30 };

// Si cae sábado (6) o domingo (0), corre la fecha al lunes siguiente.
function skipWeekend(d) {
  const day = d.getDay(); // 0=domingo, 6=sábado
  if (day === 6) d.setDate(d.getDate() + 2);      // sábado -> lunes
  else if (day === 0) d.setDate(d.getDate() + 1); // domingo -> lunes
  return d;
}

function nextDueDate(base, freq) {
  if (!base || !FREQ_DAYS[freq]) return null;
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() + FREQ_DAYS[freq]);
  if (state.config?.skipWeekends !== false) skipWeekend(d);
  return localISODate(d);
}

function toggleSkipWeekends() {
  const el = document.getElementById('skipWeekendsToggle');
  state.config.skipWeekends = !!el.checked;
  save();
  toast(state.config.skipWeekends
    ? '✓ Las próximas fechas van a evitar sábados y domingos'
    : 'Las próximas fechas pueden caer cualquier día, incluido fin de semana', 'success');
}

// Corrige, de una sola vez, las tareas pendientes (no eventualidades)
// que ya quedaron con fecha de sábado o domingo, corriéndolas al lunes.
function fixWeekendTasks() {
  let count = 0;
  state.tasks.forEach(t => {
    if (t.done || !t.due) return;
    const d = new Date(t.due + 'T00:00:00');
    const day = d.getDay();
    if (day === 6 || day === 0) {
      skipWeekend(d);
      t.due = localISODate(d);
      count++;
    }
  });
  if (count > 0) {
    save();
    renderAll();
    toast(`✓ ${count} tarea${count === 1 ? '' : 's'} corrida${count === 1 ? '' : 's'} al lunes`, 'success');
  } else {
    toast('No hay tareas pendientes en fin de semana', 'success');
  }
}

// Genera la próxima instancia de UNA tarea recurrente completada
function spawnNext(item) {
  const nextDue = nextDueDate(item.due, item.freq, item.completedAt);
  if (!nextDue) return false;
  const yaExiste = state.tasks.some(t =>
  t.name === item.name && t.freq === item.freq && t.due === nextDue && !t.done
);
  if (yaExiste) return false;
  state.tasks.push({
    id: uid(),
    name: item.name,
    freq: item.freq,
    due: nextDue,
    notes: item.notes || '',
    projectId: item.projectId || null,
    done: false,
    totalMs: 0,
    createdAt: new Date().toISOString(),
    generatedFrom: item.id
  });
  return true;
}

// Guarda la hora configurada
function saveRegenHour() {
  const val = document.getElementById('regenHourInput').value;
  state.config.regenHour = val || '07:00';
  save();
  updateRegenStatus();
  toast('Hora de regeneración guardada: ' + (val || '07:00'), 'success');
}

function updateRegenStatus() {
  const el = document.getElementById('regenStatus');
  if (!el) return;
  const input = document.getElementById('regenHourInput');
  if (input) input.value = state.config.regenHour || '07:00';
  const last = state.config.lastRegen
    ? 'Última regeneración: ' + new Date(state.config.lastRegen).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : 'Nunca regenerado automáticamente.';
  el.textContent = last;
}


// toggleDone con generación al completar
function toggleDone(id, type) {
  const arr = type === 'task' ? state.tasks : state.events;
  const item = arr.find(x => x.id === id);
  if (!item) return;

  const wasUndone = !item.done;
  const now = today(); // fecha de hoy como string "YYYY-MM-DD"
  item.done = !item.done;
  if (item.done) item.completedAt = new Date().toISOString();
  else item.completedAt = null;

  if (wasUndone && type === 'task' && item.freq && FREQ_DAYS[item.freq]) {
    const nextDue = nextDueDate(now, item.freq); // pasa "hoy" directo
    const yaExiste = state.tasks.some(t =>
      t.name === item.name && t.freq === item.freq && t.due === nextDue && !t.done
    );
    if (!yaExiste) {
      state.tasks.push({
        id: uid(), name: item.name, freq: item.freq,
        due: nextDue, notes: item.notes || '',
        projectId: item.projectId || null,
        done: false, totalMs: 0,
        createdAt: new Date().toISOString(),
        generatedFrom: item.id
      });
      toast('↗ Próxima ' + freqLabel(item.freq).toLowerCase() + ' generada: ' + fmtDate(nextDue), 'success');
    }
  }

  if (item.done && state.activeTimer?.id === id) {
    stopTimer(id, type);
    return;
  }
  save(); renderAll();
}

// ═══════════════════════════════════════════
// REPORTE POR DÍA
// ═══════════════════════════════════════════
function freqLabel(f) {
  return { sinfreq: 'Sin frecuencia', daily: 'Diaria', weekly: 'Semanal', biweekly: 'Quincenal', monthly: 'Mensual' }[f] || (f || '—');
}

function openDayReport() {
  const ds = document.getElementById('dayViewDate').value;
  if (!ds) { toast('Seleccioná una fecha', 'warn'); return; }
  const area = document.getElementById('dayReportArea');
  const dayLog = state.log.filter(l => dayOf(l.date) === ds);
  const dayTasks = state.tasks.filter(t => t.due === ds);
  const dayEvents = state.events.filter(e => e.date === ds);
  const totalMs = dayLog.reduce((a, b) => a + b.ms, 0);

  if (!dayLog.length && !dayTasks.length && !dayEvents.length) {
    area.innerHTML = `<div class="empty" style="padding:20px 0">Sin actividad registrada para ${fmtDate(ds)}</div>`;
    return;
  }

  let html = `<div style="background:var(--bg3);border-radius:var(--r2);padding:16px;margin-bottom:12px;">
    <div style="font-family:var(--font-display);font-size:13px;font-weight:600;margin-bottom:6px;">📅 ${fmtDate(ds)}</div>
    <div style="font-size:12px;color:var(--text2);">
      Tiempo total: <span style="color:var(--accent);font-family:var(--font-display)">${fmtMs(totalMs)}</span>
      &nbsp;·&nbsp; ${dayLog.length} sesión${dayLog.length !== 1 ? 'es' : ''}
    </div>
  </div>`;

  if (dayLog.length) {
    html += `<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Sesiones del día</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px;">
      <thead><tr>
        <th style="text-align:left;padding:6px 10px;color:var(--text3);border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;">Tarea</th>
        <th style="text-align:left;padding:6px 10px;color:var(--text3);border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;">Tipo</th>
        <th style="text-align:left;padding:6px 10px;color:var(--text3);border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;">Duración</th>
        <th style="text-align:left;padding:6px 10px;color:var(--text3);border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;">Hora</th>
      </tr></thead><tbody>`;
    dayLog.forEach(l => {
      html += `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid var(--border)">${esc(l.name)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid var(--border)">${l.type === 'task' ? freqTag(l.freq) : '<span class="tag tag-event" style="font-size:9px">Eventual</span>'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid var(--border);color:var(--accent);font-family:var(--font-display)">${fmtMs(l.ms)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text3)">${new Date(l.date).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}</td>
      </tr>`;
    });
    html += '</tbody></table>';
  }

  if (dayTasks.length) {
    html += `<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Tareas con vencimiento ese día</div>`;
    dayTasks.forEach(t => {
      html += `<div style="background:var(--bg3);border-radius:var(--r);padding:10px 14px;margin-bottom:6px;display:flex;align-items:center;gap:10px;">
        <span style="font-size:16px">${t.done ? '✓' : '○'}</span>
        <div>
          <div style="font-size:13px">${esc(t.name)}</div>
          <div style="font-size:11px;color:var(--text3)">${freqLabel(t.freq)} · ${t.done ? 'Completada' : 'Pendiente'} · ⏱ ${fmtMs(t.totalMs || 0)}</div>
        </div>
      </div>`;
    });
  }

  area.innerHTML = html;
}

// ═══════════════════════════════════════════
// RENDER ALL
// ═══════════════════════════════════════════
function renderAll() {
  if (uiBusy) return; // se re-renderiza al soltar la tarjeta
  ensureTicking();
  fillProjectSelects();
  renderProjects();
  renderDashboard();
  renderTasks();
  renderEvents();
  renderCalendar();
  renderReminders();
  renderLog();
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
load();
loadThemeFromState();
renderAll();
renderSyncIndicator();
// La carga desde Supabase la dispara onSignedIn() cuando se resuelve la sesión.

// ───────────────────────────────────────────
// AUTO-SYNC ENTRE DISPOSITIVOS (respaldo del realtime)
// ───────────────────────────────────────────
// Realtime ya aplica los cambios al instante. Esto es la red de
// seguridad para cuando el dispositivo pierde la conexión (móvil en
// segundo plano, PC que se durmió): al volver a la pestaña, al
// recuperar la red y cada 60s se hace un pull. El merge por registro
// hace que un pull nunca pise cambios locales sin subir, así que ya no
// hace falta bloquearlo con modales abiertos ni timers corriendo.
function autoPull(minGapMs) {
  if (!sheetsEnabled() || document.visibilityState !== 'visible') return;
  if (Date.now() - lastPullAt < (minGapMs || 0)) return;
  // Si quedó algo sin subir (por ejemplo, el móvil se durmió a mitad), subirlo primero
  if (computeDiff().count > 0) pushToSheets().then(() => schedulePull(0));
  else schedulePull(0);
}
setInterval(() => autoPull(55000), 60000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { ensureTicking(); renderAll(); autoPull(3000); }
  else if (sheetsEnabled() && computeDiff().count > 0) pushToSheets(); // antes de que el SO congele la pestaña
});
window.addEventListener('online', () => autoPull(0));
window.addEventListener('focus', () => autoPull(15000));
window.addEventListener('pagehide', () => { if (sheetsEnabled() && computeDiff().count > 0) pushToSheets(); });


// ATAJOS
function guardarTarea() {
  const gTarea = document.querySelector(".modal-overlay.open");
  if (!gTarea) return;
  switch (gTarea.id) {
    case 'authGate':
      handleAuthSubmit();
      break;
    case 'newTaskModal':
      saveNewTask();
      break;
    case 'newEventModal':
      saveNewEvent();
      break;
    case 'reminderModal':
      saveReminder();
      break;
  }
}
function cerrarModalAbierto() {
  const modal = document.querySelector(".modal-overlay.open");
  if (modal) {
    closeModal(modal.id);
  }
}
const shortcuts = {
    "alt+enter": guardarTarea,
  //  "ctrl+n": nuevaTarea,
    "f2": openNewEventModal,
    "f3": openReminderModal,
    "escape": cerrarModalAbierto,
  //  "delete": eliminarTarea,
    "alt+1": () => showView('dashboard'),
    "alt+2": () => showView('tasks'),
    "alt+3": () => showView('events'),
    "alt+4": () => showView('calendar'),
    "alt+5": () => showView('reminders'),
    "alt+6": () => showView('analytics')
};

document.addEventListener("keydown", e => {
    if (!e.key) return;  // ← protección
    
    const keys = [];
    if (e.ctrlKey) keys.push("ctrl");
    if (e.altKey) keys.push("alt");
    if (e.shiftKey) keys.push("shift");
    keys.push(e.key.toLowerCase());
    
    const combo = keys.join("+");
    if (shortcuts[combo]) {
        e.preventDefault();
        shortcuts[combo]();
    }
});



// ═══════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════

// Chart instance registry – destroy before recreate
const _charts = {};
function _destroyChart(id) {
  if (_charts[id]) { try { _charts[id].destroy(); } catch(e){} delete _charts[id]; }
}

function applyAnalyticsFilter() { renderAnalytics(); }

function clearAnalyticsFilter() {
  document.getElementById('analyticsFrom').value = '';
  document.getElementById('analyticsTo').value = '';
  initializeAnalyticsDates(); // vuelve al mes actual
  renderAnalytics();
}

function initializeAnalyticsDates() {
  const fromInput = document.getElementById('analyticsFrom');
  const toInput   = document.getElementById('analyticsTo');

  if (fromInput.value || toInput.value) return;

  const now = new Date();

  fromInput.value = new Date(
    now.getFullYear(),
    now.getMonth(),
    1
  ).toISOString().slice(0, 10);

  toInput.value = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0
  ).toISOString().slice(0, 10);
}

function getFilteredLogs() {
  const from = document.getElementById('analyticsFrom').value;
  const to   = document.getElementById('analyticsTo').value;

  return state.log.filter(l => {
    const d = dayOf(l.date);

    if (from && d < from) return false;
    if (to && d > to) return false;

    return true;
  });
}

function buildAnalyticsData() {
  const logs = getFilteredLogs();
  const totalMs = logs.reduce((s, l) => s + (l.ms || 0), 0);
  const sessions = logs.length;
  const uniqueNames = new Set(logs.map(l => l.name)).size;
  const eventCount = logs.filter(l => l.type === 'event').length;

// se agregan tipos de tareas
  const taskTypes = {};

  logs.forEach(log => {
    taskTypes[log.name] = log.type;
  });

  // Group by name
  const byName = {};
  logs.forEach(l => {
    if (!byName[l.name]) byName[l.name] = 0;
    byName[l.name] += (l.ms || 0);
  });
  const byNameSorted = Object.entries(byName).sort((a, b) => b[1] - a[1]);

  // Top task
  const topTask = byNameSorted[0] || null;

  // Event impact
  const eventMs = logs.filter(l => l.type === 'event').reduce((s, l) => s + (l.ms || 0), 0);

  // By day (chronological)
  const byDay = {};
  logs.forEach(l => {
    const d = dayOf(l.date);
    if (!byDay[d]) byDay[d] = 0;
    byDay[d] += (l.ms || 0);
  });
  const dayEntries = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]));

  // By freq
  const byFreq = { daily: 0, weekly: 0, biweekly: 0, monthly: 0, '': 0 };
  logs.forEach(l => {
    const k = l.freq && byFreq[l.freq] !== undefined ? l.freq : '';
    byFreq[k] += (l.ms || 0);
  });

  // By weekday (0=Sun…6=Sat → we reorder to Mon=0)
  const byWd = [0,0,0,0,0,0,0]; // Mon–Sun
  logs.forEach(l => {
    const wd = new Date(l.date).getDay(); // 0=Sun
    const idx = wd === 0 ? 6 : wd - 1;  // shift: Mon=0…Sun=6
    byWd[idx] += (l.ms || 0);
  });

  // Task vs event ms
  const taskMs  = logs.filter(l => l.type === 'task').reduce((s, l) => s + (l.ms || 0), 0);

  return { logs, totalMs, sessions, uniqueNames, eventCount,
           byNameSorted, topTask, eventMs, taskMs,
           dayEntries, byFreq, byWd, taskTypes };
}

function msToHours(ms) { return Math.round(ms / 36000) / 100; } // 2 decimals

function renderAnalyticsCards(d) {
  const kpiEl = document.getElementById('analyticsKpis');
  if (!kpiEl) return;
  kpiEl.innerHTML = `
    <div class="stat">
      <div class="stat-val">${fmtMs(d.totalMs)}</div>
      <div class="stat-label">Horas totales</div>
    </div>
    <div class="stat">
      <div class="stat-val">${d.sessions}</div>
      <div class="stat-label">Sesiones registradas</div>
    </div>
    <div class="stat">
      <div class="stat-val">${d.uniqueNames}</div>
      <div class="stat-label">Tareas únicas</div>
    </div>
    <div class="stat">
      <div class="stat-val" style="color:var(--red)">${d.eventCount}</div>
      <div class="stat-label">Eventualidades</div>
    </div>
  `;

  const pctTop  = d.totalMs > 0 && d.topTask ? Math.round(d.topTask[1] / d.totalMs * 100) : 0;
  const pctEvt  = d.totalMs > 0 ? Math.round(d.eventMs / d.totalMs * 100) : 0;
  const hlEl = document.getElementById('analyticsHighlights');
  if (!hlEl) return;
  hlEl.innerHTML = `
    <div class="card" style="border-color:var(--accent-dim);background:var(--accent-bg);">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--accent-dim);margin-bottom:8px;">🏆 Tarea con mayor inversión</div>
      ${d.topTask ? `
        <div style="font-family:var(--font-display);font-size:16px;font-weight:600;color:var(--accent);margin-bottom:4px;">${d.topTask[0]}</div>
        <div style="font-size:13px;color:var(--text2);">${fmtMs(d.topTask[1])} <span style="color:var(--text3);font-size:11px;">— ${pctTop}% del total</span></div>
        <div class="progress" style="margin-top:10px;"><div class="progress-fill" style="width:${pctTop}%"></div></div>
      ` : `<div class="empty" style="padding:10px 0;">Sin datos</div>`}
    </div>
    <div class="card" style="border-color:rgba(240,124,124,0.3);background:var(--red-bg);">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--red);margin-bottom:8px;">⚡ Impacto de eventualidades</div>
      <div style="font-family:var(--font-display);font-size:16px;font-weight:600;color:var(--red);margin-bottom:4px;">${fmtMs(d.eventMs)}</div>
      <div style="font-size:13px;color:var(--text2);">${pctEvt}% del tiempo total registrado</div>
      <div class="progress" style="margin-top:10px;"><div class="progress-fill" style="width:${pctEvt}%;background:var(--red);"></div></div>
    </div>
  `;
}

function renderAnalyticsRanking(d) {
  const el = document.getElementById('analyticsRanking');
  if (!el) return;
  const top10 = d.byNameSorted.slice(0, 10);
  if (!top10.length) {
    el.innerHTML = '<div class="empty" style="padding:20px;">Sin datos en el período seleccionado</div>';
    return;
  }
  const maxMs = top10[0][1];
  let html = '<table style="width:100%;border-collapse:collapse;">'
    + '<thead><tr>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;color:var(--text3);text-transform:uppercase;border-bottom:1px solid var(--border);">#</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;color:var(--text3);text-transform:uppercase;border-bottom:1px solid var(--border);">Tarea</th>'
    + '<th style="padding:10px 16px;text-align:right;font-size:10px;color:var(--text3);text-transform:uppercase;border-bottom:1px solid var(--border);">Horas</th>'
    + '<th style="padding:10px 16px;text-align:right;font-size:10px;color:var(--text3);text-transform:uppercase;border-bottom:1px solid var(--border);">Minutos</th>'
    + '<th style="padding:10px 32px 10px 16px;text-align:left;font-size:10px;color:var(--text3);text-transform:uppercase;border-bottom:1px solid var(--border);">Barra</th>'
    + '</tr></thead><tbody>';
  top10.forEach(([name, ms], i) => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const pct = Math.round(ms / maxMs * 100);
    const accent = i === 0 ? 'var(--accent)' : 'var(--accent-dim)';
    html += `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:10px 16px;font-size:11px;color:var(--text3);">${i + 1}</td>
      <td style="padding:10px 16px;font-size:12px;">${name}</td>
      <td style="padding:10px 16px;text-align:right;font-family:var(--font-display);font-size:13px;color:var(--accent);">${h}h</td>
      <td style="padding:10px 16px;text-align:right;font-family:var(--font-display);font-size:13px;color:var(--text2);">${m}m</td>
      <td style="padding:10px 32px 10px 16px;">
        <div style="height:4px;background:var(--bg4);border-radius:2px;">
          <div style="height:100%;width:${pct}%;background:${accent};border-radius:2px;"></div>
        </div>
      </td>
    </tr>`;
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderAnalyticsCharts(d) {
  const chartDefaults = {
    color: '#e8e4dc',
    plugins: { legend: { labels: { color: '#888', font: { family: 'DM Mono, monospace', size: 11 } } } },
  };
  const gridColor = 'rgba(42,42,42,0.8)';
  const tickColor = '#555';
  const axisFont = { family: 'DM Mono, monospace', size: 10 };

  // ── Chart 1: Horas por tarea (bar) ──
  _destroyChart('byTask');
  const top15 = d.byNameSorted.slice(0, 15);
  const c1 = document.getElementById('chartByTask');
  if (c1) {
    _charts['byTask'] = new Chart(c1, {
      type: 'bar',
      data: {
        labels: top15.map(([n]) => n.length > 22 ? n.slice(0, 20) + '…' : n),
        datasets: [{
          label: 'Horas',
          data: top15.map(([, ms]) => msToHours(ms)),
          backgroundColor: top15.map(([name])=> d.taskTypes[name] === 'event'
          ? 'rgb(240, 124, 124)'
          : 'rgba(200,240,124,0.7)'),
          borderColor: '#c8f07c',
          borderWidth: 1,
          borderRadius: 3,
        }]
      },
      options: {
        responsive: true, indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: tickColor, font: axisFont }, beginAtZero: true },
          y: { grid: { color: gridColor }, ticks: { color: '#e8e4dc', font: axisFont } }
        }
      }
    });
  }

  // ── Chart 2: Pie distribución ──
  _destroyChart('pie');
  const c2 = document.getElementById('chartPie');
  if (c2) {
    _charts['pie'] = new Chart(c2, {
      type: 'pie',
      data: {
        labels: ['Tareas', 'Eventualidades'],
        datasets: [{
          data: [msToHours(d.taskMs), msToHours(d.eventMs)],
          backgroundColor: ['rgba(200,240,124,0.75)', 'rgba(240,124,124,0.75)'],
          borderColor: ['#c8f07c', '#f07c7c'],
          borderWidth: 1,
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#888', font: axisFont, padding: 12 } },
          tooltip: {
            callbacks: {
              label: ctx => {
                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                const pct = total > 0 ? Math.round(ctx.parsed / total * 100) : 0;
                return ` ${ctx.label}: ${ctx.parsed.toFixed(2)}h (${pct}%)`;
              }
            }
          }
        }
      }
    });
  }

  // ── Chart 3: Evolución diaria (line) ──
  _destroyChart('daily');
  const c3 = document.getElementById('chartDaily');
  if (c3) {
    _charts['daily'] = new Chart(c3, {
      type: 'line',
      data: {
        labels: d.dayEntries.map(([date]) => fmtDate(date)),
        datasets: [{
          label: 'Horas',
          data: d.dayEntries.map(([, ms]) => msToHours(ms)),
          borderColor: '#c8f07c',
          backgroundColor: 'rgba(200,240,124,0.08)',
          pointBackgroundColor: '#c8f07c',
          pointRadius: 3,
          tension: 0.3,
          fill: true,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: tickColor, font: axisFont, maxTicksLimit: 20 } },
          y: { grid: { color: gridColor }, ticks: { color: tickColor, font: axisFont }, beginAtZero: true }
        }
      }
    });
  }

  // ── Chart 4: Por frecuencia (bar) ──
  _destroyChart('freq');
  const c4 = document.getElementById('chartFreq');
  if (c4) {
    const freqLabels = ['Sin frecuencia', 'Diaria', 'Semanal', 'Quincenal', 'Mensual'];
    const freqKeys   = ['sinfreq', 'daily', 'weekly', 'biweekly', 'monthly'];
    _charts['freq'] = new Chart(c4, {
      type: 'bar',
      data: {
        labels: freqLabels,
        datasets: [{
          label: 'Horas',
          data: freqKeys.map(k => msToHours(d.byFreq[k] || 0)),
          backgroundColor: ['rgba(200,240,124,0.7)','rgba(124,184,240,0.7)','rgba(176,124,240,0.7)','rgba(240,200,124,0.7)'],
          borderColor:      ['#c8f07c','#7cb8f0','#b07cf0','#f0c87c'],
          borderWidth: 1, borderRadius: 3,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: tickColor, font: axisFont } },
          y: { grid: { color: gridColor }, ticks: { color: tickColor, font: axisFont }, beginAtZero: true }
        }
      }
    });
  }

  // ── Chart 5: Por día de semana (bar) ──
  _destroyChart('weekday');
  const c5 = document.getElementById('chartWeekday');
  if (c5) {
    const wdLabels = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
    _charts['weekday'] = new Chart(c5, {
      type: 'bar',
      data: {
        labels: wdLabels,
        datasets: [{
          label: 'Horas',
          data: d.byWd.map(ms => msToHours(ms)),
          backgroundColor: 'rgba(124,184,240,0.65)',
          borderColor: '#7cb8f0',
          borderWidth: 1, borderRadius: 3,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: tickColor, font: axisFont } },
          y: { grid: { color: gridColor }, ticks: { color: tickColor, font: axisFont }, beginAtZero: true }
        }
      }
    });
  }
}

function renderAnalytics() {
  initializeAnalyticsDates();
  const data = buildAnalyticsData();
  renderAnalyticsCards(data);
  renderAnalyticsRanking(data);
  renderAnalyticsCharts(data);
}


shortcuts["escape"];
shortcuts["alt+1"];
shortcuts["alt+2"];
shortcuts["alt+3"];
shortcuts["alt+4"];
shortcuts["alt+5"];
shortcuts["alt+6"];
shortcuts["alt+enter"];

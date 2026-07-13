// Tema

const btn = document.getElementById("themeToggle");

// Cargar tema guardado
if (localStorage.getItem("theme") === "light") {
  document.body.classList.add("light");
}

btn.addEventListener("click", () => {
  document.body.classList.toggle("light");

  // Guardar preferencia
  const theme = document.body.classList.contains("light") ? "light" : "dark";
  localStorage.setItem("theme", theme);
});

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
let state = {
  tasks: [],
  events: [],
  reminders: [],
  log: [],
  activeTimer: null, // { id, type, start, paused, pausedMs }
};

// ───────────────────────────────────────────
// SUPABASE — backend compartido, datos separados por cuenta
// ───────────────────────────────────────────
// Un solo proyecto de Supabase para todo el equipo. Cada persona
// inicia sesión con su email/contraseña y "Row Level Security" en
// la base de datos hace que cada una vea y edite SOLO sus propias
// filas — automáticamente, sin tener que configurar nada más.
//
// SUPABASE_URL y SUPABASE_ANON_KEY son públicos (no son secretos:
// están pensados para ir embebidos en el código del cliente). Lo que
// protege los datos de cada usuario es la Row Level Security definida
// en schema.sql, no ocultar estos valores.
const SUPABASE_URL = 'https://scfeluwbaanzxataizbz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_slMXuckeD-_SWT6T7OLfBA_bg0pe5V8';

const supabaseClient = (SUPABASE_URL.includes('TU-PROYECTO'))
  ? null
  : window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;      // { id, email }
let authMode = 'login';      // 'login' | 'signup'
let realtimeChannels = [];

let syncState = { status: 'idle', lastSync: null, lastError: null };
let syncDebounceTimer = null;
let isApplyingRemoteState = false;
let pushInFlight = false;   // true mientras hay un push a Supabase en curso
let hasPendingLocalChange = false; // true si hay un cambio local sin confirmar todavía en Supabase
let lastPushAt = 0;         // timestamp del último push propio exitoso (para ignorar el eco de Realtime)
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
        btn.disabled = false;
        return;
      }
    }
    // El listener de abajo se encarga de cerrar el gate y cargar los datos
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
  if (emailInput) {
    setTimeout(() => {
      emailInput.focus();
      emailInput.select();
    }, 50);
  }
}

function updateAuthActionButton() {
  const btn = document.getElementById('authActionBtn');
  if (!btn) return;

  if (currentUser) {
    btn.textContent = 'Cerrar sesión';
    btn.className = 'btn btn-red btn-sm';
    btn.onclick = () => handleAuthAction();
  } else {
    btn.textContent = 'Iniciar sesión';
    btn.className = 'btn btn-accent btn-sm';
    btn.onclick = () => handleAuthAction();
  }
}

function handleAuthAction() {
  if (currentUser) {
    signOut();
  } else {
    openAuthGateForLogin();
  }
}

async function signOut() {
  if (!supabaseClient) return;

  // Mostrar overlay INMEDIATAMENTE para que el usuario vea feedback
  showLoadingOverlay('Cerrando sesión…', 'Guardando cambios locales');

  try {
    // 1) Si hay un push pendiente, intentamos subirlo antes de cerrar
    //    (no es bloqueante: si falla, los datos quedan en localStorage)
    if (hasPendingLocalChange && sheetsEnabled()) {
      await pushToSheets().catch(() => {});
    }

    // 2) Cerrar sesión en Supabase
    await supabaseClient.auth.signOut();
    // onSignedOut se va a disparar solo desde el listener
  } catch (err) {
    console.error('Error al cerrar sesión:', err);
    toast('Error al cerrar sesión', 'warn');
  } finally {
    // Pequeña pausa para que el usuario perciba el cambio
    await new Promise(r => setTimeout(r, 400));
    hideLoadingOverlay();
  }
}

function showAuthGate() {
  document.getElementById('authGate').classList.add('open');
}
function hideAuthGate() {
  document.getElementById('authGate').classList.remove('open');
}

// Se llama SOLO cuando de verdad hay que (re)cargar los datos de la
// cuenta: al abrir la app con sesión ya iniciada, o justo después de
// loguearse. NO se llama en cada renovación automática del token.

let isInitialSyncComplete = false;
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

async function onSignedIn(session) {
  currentUser = { id: session.user.id, email: session.user.email };
  hideAuthGate();
  document.getElementById('headerUserEmail').textContent = currentUser.email;
  document.getElementById('datosUserEmail').textContent  = currentUser.email;

  showLoadingOverlay('Sincronizando con Supabase…', 'No cierres esta ventana');

  const success = await loadFromSheets({ silent: true, force: true });

  if (success || localStorage.getItem(LOCAL_CACHE_KEY)) {
    isInitialSyncComplete = true;
  } else {
    isInitialSyncComplete = false;
    toast('⚠ No se pudieron cargar datos y no hay caché local. Reintentá más tarde.', 'warn');
  }

  hideLoadingOverlay();
  updateAuthActionButton();
  startRealtime();
}


function onSignedOut() {
  currentUser = null;
  isInitialSyncComplete = false;
  clearTimeout(syncDebounceTimer);
  realtimeChannels.forEach(ch => { try { supabaseClient.removeChannel(ch); } catch(e){} });
  realtimeChannels = [];

  // Limpiar TODO el estado visible para que no quede nada de la cuenta anterior
  state = {
    tasks: [],
    events: [],
    reminders: [],
    log: [],
    activeTimer: null,
  };
  applyDefaults();
  localStorage.removeItem(LOCAL_CACHE_KEY);  // ← clave: borra el caché de la cuenta anterior

  const headerUserEmail = document.getElementById('headerUserEmail');
  const datosUserEmail = document.getElementById('datosUserEmail');
  if (headerUserEmail) headerUserEmail.textContent = '';
  if (datosUserEmail) datosUserEmail.textContent = '—';

  updateAuthActionButton();
  renderAll();
  showAuthGate();
  setSyncStatus('disabled');
}

// ── scheduleSyncToSheets (REEMPLAZÁ el tuyo) ──
function scheduleSyncToSheets() {
  if (isApplyingRemoteState) return;
  if (!sheetsEnabled()) { setSyncStatus('disabled'); return; }

  // PROTECCIÓN CLAVE: no subir nada hasta que sepamos qué hay en la BD
  if (!isInitialSyncComplete) {
    console.warn('Push bloqueado: carga inicial no completada');
    return;
  }

  hasPendingLocalChange = true;
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => pushToSheets(), 1200);
}

if (supabaseClient) {
  // Carga inicial: única vez que se dispara sin importar nada más.
  supabaseClient.auth.getSession().then(({ data }) => {
    if (data.session) onSignedIn(data.session);
    else {
      showAuthGate();
      updateAuthActionButton();
    }
  });

  // Eventos posteriores: OJO acá es donde estaba el bug. Supabase emite
  // eventos como TOKEN_REFRESHED cada ~1 hora en segundo plano, y antes
  // esto disparaba una recarga completa de datos que pisaba cualquier
  // cambio reciente que todavía no se hubiera sincronizado (por eso
  // reaparecían tareas recién completadas, o se "reseteaba" el timer).
  // Ahora SOLO recargamos datos en un login/logout real.
  let lastKnownUserId = null;
  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || !session) {
      lastKnownUserId = null;
      onSignedOut();
      return;
    }
    if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED' || event === 'INITIAL_SESSION') {
      // Solo actualizamos el usuario/token interno, sin recargar datos.
      currentUser = { id: session.user.id, email: session.user.email };
      return;
    }
    // SIGNED_IN: puede ser un login real, o Supabase re-emitiendo el
    // mismo evento para la misma sesión (pasa al volver a una pestaña).
    // Solo recargamos si el usuario logueado cambió de verdad.
    if (session.user.id !== lastKnownUserId) {
      lastKnownUserId = session.user.id;
      onSignedIn(session);
    } else {
      currentUser = { id: session.user.id, email: session.user.email };
    }
  });
} else {
  console.warn('Supabase no está configurado todavía (ver SUPABASE_URL/SUPABASE_ANON_KEY en index.js)');
}

// ── DATOS: subir / bajar ──────────────────

// solo permite push cuando sepamos que el estado local

function applyDefaults() {
  if (!state.tasks) state.tasks = [];
  if (!state.events) state.events = [];
  if (!state.reminders) state.reminders = [];
  if (!state.log) state.log = [];
  if (!state.config) state.config = { regenHour: '07:00', lastRegen: null, skipWeekends: true };
  if (state.config.skipWeekends === undefined) state.config.skipWeekends = true;
}

function load() {
  // 1) Caché local: instantáneo, nunca falla, evita pantallas vacías.
  const raw = localStorage.getItem(LOCAL_CACHE_KEY);
  if (raw) {
    try { state = { ...state, ...JSON.parse(raw) }; } catch(e) {}
  }
  applyDefaults();
}

function save() {
  // Guardado local SIEMPRE primero (síncrono, no depende de la red).
  try { localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(state)); } catch(e) {}
  scheduleSyncToSheets();
}

function scheduleSyncToSheets() {
  if (isApplyingRemoteState) return;
  if (!sheetsEnabled()) { setSyncStatus('disabled'); return; }

  // ── PROTECCIÓN CLAVE ──
  // No subir nada a Supabase hasta que sepamos qué hay realmente
  // en la base remota. Si localStorage estaba vacío y todavía
  // no terminó la carga inicial, state.tasks = [] y subir eso
  // borraría toda la base.
  if (!isInitialSyncComplete) {
    console.warn('Sincronización en pausa: carga inicial en curso');
    return;
  }

  hasPendingLocalChange = true;
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => pushToSheets(), 1200);
}


// Sube TODO el estado en una sola llamada a una función de la base de
// datos (save_full_state, ver schema.sql) que hace el reemplazo dentro
// de una única transacción: o se guarda todo, o no se guarda nada — a
// diferencia del enfoque anterior (borrar tabla por tabla y reinsertar
// desde el navegador), que podía dejar datos borrados a mitad de camino
// si algo fallaba en el medio.
async function pushToSheets(opts) {
  opts = opts || {};
  if (!sheetsEnabled()) {
    if (opts.manual) toast('Iniciá sesión primero', 'warn');
    return false;
  }
  pushInFlight = true;
  setSyncStatus('syncing');
  try {
    const { error } = await supabaseClient.rpc('save_full_state', {
      p_tasks: state.tasks,
      p_events: state.events,
      p_reminders: state.reminders,
      p_log: state.log,
      p_config: state.config || {},
      p_active_timer: state.activeTimer || null,
    });
    if (error) throw error;

    hasPendingLocalChange = false;
    lastPushAt = Date.now();
    setSyncStatus('synced');
    if (opts.manual) toast('✓ Sincronizado con Supabase', 'success');
    return true;
  } catch (err) {
    setSyncStatus('error', err.message || String(err));
    if (opts.manual) toast('⚠ No se pudo sincronizar: ' + (err.message || err), 'warn');
    return false;
  } finally {
    pushInFlight = false;
  }
}

async function loadFromSheets(opts) {
  opts = opts || {};
  if (!sheetsEnabled()) {
    if (opts.manual) toast('Iniciá sesión primero', 'warn');
    return false;
  }

  // Protección: si hay un cambio local pendiente, no traer datos remotos
  if (!opts.force && (hasPendingLocalChange || pushInFlight)) {
    return false;
  }

  setSyncStatus('syncing');
  isApplyingRemoteState = true;    // ← movido ACÁ, así bloquea pushes desde el primer momento

  try {
    const uid = currentUser.id;
    const [tasksR, eventsR, remindersR, logR, cfgR, timerR] = await Promise.all([
      supabaseClient.from('tasks').select('*').eq('user_id', uid),
      supabaseClient.from('events').select('*').eq('user_id', uid),
      supabaseClient.from('reminders').select('*').eq('user_id', uid),
      supabaseClient.from('log').select('*').eq('user_id', uid),
      supabaseClient.from('user_config').select('*').eq('user_id', uid).maybeSingle(),
      supabaseClient.from('active_timer').select('*').eq('user_id', uid).maybeSingle(),
    ]);
    for (const r of [tasksR, eventsR, remindersR, logR, cfgR, timerR]) {
      if (r.error) throw r.error;
    }

    // Si mientras esperábamos la respuesta apareció un cambio local nuevo,
    // lo respetamos y descartamos lo que acabamos de traer.
    if (!opts.force && (hasPendingLocalChange || pushInFlight)) {
      setSyncStatus('synced');
      return false;
    }

    const strip = (rows) => (rows || []).map(({ user_id, ...rest }) => rest);
    const data = {
      tasks:     strip(tasksR.data),
      events:    strip(eventsR.data),
      reminders: strip(remindersR.data),
      log:       strip(logR.data),
      config:    (cfgR.data && cfgR.data.config) || { regenHour: '07:00', lastRegen: null },
      activeTimer: (timerR.data && timerR.data.timer) || null,
    };

    state = { ...state, ...data };
    applyDefaults();
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(state));

    setSyncStatus('synced');
    if (opts.manual) toast('✓ Datos cargados desde Supabase', 'success');
    renderAll();
    return true;
  } catch (err) {
    setSyncStatus('error', err.message || String(err));
    if (!opts.silent) toast('⚠ Sin conexión con Supabase, usando datos guardados localmente', 'warn');
    return false;
  } finally {
    // SIEMPRE se ejecuta, sin importar si hubo éxito, error o return temprano
    isApplyingRemoteState = false;
  }
}

async function manualSync() {
  toast('Sincronizando…', 'success');
  const ok = await pushToSheets({ manual: true });
  if (ok) await loadFromSheets({ silent: true, force: true });
}

// ── REALTIME: cambios en otro dispositivo llegan al instante ──
function stopRealtime() {
  realtimeChannels.forEach(ch => supabaseClient.removeChannel(ch));
  realtimeChannels = [];
}

function startRealtime() {
  if (!supabaseClient || !currentUser) return;
  stopRealtime();
  const uid = currentUser.id;

  // Cada sincronización borra y reinserta filas, y Realtime avisa
  // FILA POR FILA (no un solo aviso por sincronización). Sin agrupar
  // esto, una sync con 30 tareas dispara ~60 avisos casi simultáneos,
  // cada uno intentando recargar todo — eso era lo que hacía "saltar"
  // el indicador entre sincronizado/sin conexión.
  // Solución: juntamos todos los avisos que lleguen en una ráfaga y
  // recargamos UNA sola vez, 900ms después del último aviso.
  let realtimeDebounceTimer = null;
  function onRemoteChange() {
    // Si el aviso llegó a los pocos segundos de nuestro propio push,
    // es casi seguro el eco de nuestra propia sincronización (no un
    // cambio real de otro dispositivo) — lo ignoramos directamente.
    if (Date.now() - lastPushAt < 4000) return;
    clearTimeout(realtimeDebounceTimer);
    realtimeDebounceTimer = setTimeout(() => {
      if (safeToAutoPull()) loadFromSheets({ silent: true });
    }, 900);
  }

  ['tasks', 'events', 'reminders', 'log', 'user_config', 'active_timer'].forEach(table => {
    const ch = supabaseClient
      .channel('rt-' + table + '-' + uid)
      .on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${uid}` },
        onRemoteChange)
      .subscribe();
    realtimeChannels.push(ch);
  });
}

function setSyncStatus(status, errorMsg) {
  syncState.status = status;
  syncState.lastError = errorMsg || null;
  if (status === 'synced') syncState.lastSync = new Date();
  renderSyncIndicator();
}

function renderSyncIndicator() {
  const map = {
    idle:     ['●', 'var(--text3)', 'Iniciando…'],
    disabled: ['○', 'var(--text3)', 'Sin sesión (solo local)'],
    syncing:  ['◐', 'var(--amber)', 'Sincronizando…'],
    synced:   ['●', 'var(--accent)', syncState.lastSync ? 'Sincronizado · ' + syncState.lastSync.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}) : 'Sincronizado'],
    error:    ['●', 'var(--red)', 'Sin conexión (usando caché local)'],
  };
  const [dot, color, label] = map[syncState.status] || map.idle;
  const html = `<span style="color:${color}">${dot}</span> <span style="color:var(--text3)">${label}</span>`;
  ['syncIndicator', 'syncIndicatorDatos'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.title = syncState.lastError || ''; el.innerHTML = html; }
  });
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }


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
  reminders: 'Recordatorios', analytics: 'Analytics', log: 'Historial', datos: 'Gestión de datos'
};
const viewOrder = ['dashboard','tasks','events','calendar','reminders','analytics','log','datos'];
function showView(v) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('view-' + v).classList.add('active');
  const idx = viewOrder.indexOf(v);
  if (idx >= 0) document.querySelectorAll('.nav-item')[idx]?.classList.add('active');
  document.getElementById('headerTitle').textContent = viewTitles[v] || v;
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
  save();
  toast('⏸ Pausado', 'warn');
  renderAll();
}

function resumeTimer() {
  if (!state.activeTimer || !state.activeTimer.paused) return;
  state.activeTimer.start = Date.now();
  state.activeTimer.paused = false;
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
  timerInterval = setInterval(() => {
    if (!state.activeTimer || state.activeTimer.paused) return;
    document.querySelectorAll('[data-timer-live]').forEach(el => { el.textContent = fmtMs(getElapsed(state.activeTimer)); });
    const tc = document.getElementById('taskCount');
    if (tc) tc.textContent = state.tasks.filter(t => !t.done && t.due === today()).length;
  }, 500);
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
function openNewTaskModal() {
  document.getElementById('nt-name').value = '';
  document.getElementById('nt-freq').value = 'daily';
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
function toggleDone(id, type) {
  const arr = type === 'task' ? state.tasks : state.events;
  const item = arr.find(x => x.id === id);
  if (!item) return;
  item.done = !item.done;
  if (item.done && state.activeTimer?.id === id) {
    stopTimer(id, type);
    return;
  }
  save(); renderAll();
}

// ═══════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════
function openNewEventModal() {
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
function today() { return new Date().toISOString().slice(0, 10); }
function tomorrow() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
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
  const map = { daily: ['tag-daily','Diaria'], weekly: ['tag-weekly','Semanal'], biweekly: ['tag-biweekly','Quincenal'], monthly: ['tag-monthly','Mensual'] };
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
      <div class="task-name" style="${item.done ? 'text-decoration:line-through;opacity:0.5' : ''}">${item.name}</div>
      <div class="task-info">
        ${typeTag}
        <span class="task-due ${dueClass(dueStr, item.done)}">${dueLabel(dueStr, item.done)}</span>
        ${item.totalMs > 0 ? `<span class="task-timer-val">⏱ ${totalFmt}</span>` : ''}
      </div>
      ${item.notes ? `<div style="font-size:11px;color:var(--text3);margin-top:5px;">${item.notes}</div>` : ''}
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
  if (freq) items = items.filter(t => t.freq === freq);
  if (status === 'pending') items = items.filter(t => !t.done);
  else if (status === 'done') items = items.filter(t => t.done);
  else if (status === 'all') { /* mostrar todo */ }
  else {
    // Vista por defecto: pendientes de hoy/futuras + completadas de hoy
    items = items.filter(t =>
      (!t.done && t.due >= today()) ||
      (t.done && t.due === today()) &&
      (!t.done)
    );}
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

function renderDashboard() {
  // Stats: solo tareas con vencimiento HOY
  const todayTasks = state.tasks.filter(t => t.due === today());
  const todayDone  = todayTasks.filter(t => t.done).length;
  const totalToday = todayTasks.length;
  const totalEvents = state.events.filter(e => !e.done).length;
  const todayMs = state.log.filter(l => l.date.slice(0, 10) === today()).reduce((a, b) => a + b.ms, 0);

  document.getElementById('statsGrid').innerHTML = `
    <div class="stat">
      <div class="stat-val">${todayDone}/${totalToday}</div>
      <div class="stat-label">Tareas de hoy</div>
      <div class="progress"><div class="progress-fill" style="width:${totalToday ? Math.round(todayDone/totalToday*100) : 0}%"></div></div>
    </div>
    <div class="stat">
      <div class="stat-val">${totalEvents}</div>
      <div class="stat-label">Eventualidades activas</div>
      <div class="stat-sub" style="color:var(--red)">${state.events.filter(e => e.prio === 'high' && !e.done).length} urgentes</div>
    </div>
    <div class="stat">
      <div class="stat-val">${fmtMs(todayMs)}</div>
      <div class="stat-label">Tiempo productivo hoy</div>
      <div class="stat-sub">${state.log.filter(l => l.date.slice(0,10) === today()).length} sesiones</div>
    </div>
    <div class="stat">
      <div class="stat-val">${state.reminders.filter(r => !r.done && r.date >= today()).length}</div>
      <div class="stat-label">Recordatorios</div>
    </div>`;

  // active
  const activeEl = document.getElementById('activeTasksArea');
  if (state.activeTimer) {
    const arr = state.activeTimer.type === 'task' ? state.tasks : state.events;
    const item = arr.find(x => x.id === state.activeTimer.id);
    if (item) {
      activeEl.innerHTML = renderTaskItem(item, state.activeTimer.type);
      if (timerInterval) startTicking();
    }
  } else {
    activeEl.innerHTML = '<div class="empty"><div class="empty-icon">⏸</div>Ninguna tarea en curso</div>';
  }

  // urgent: vencidas o que vencen mañana, excluyendo las diarias de mañana
  // urgent: pendientes de hoy, vencidas, y mañana (excepto diarias)
  const urgent = state.tasks.filter(t =>
    !t.done && (
      t.due <= today() ||
      t.due === today() ||
      (t.due === tomorrow() && t.freq !== 'daily')
    )
  ).sort((a,b) => (a.due||'') < (b.due||'') ? -1 : 1);
  const urgEl = document.getElementById('urgentTasksArea');
  urgEl.innerHTML = urgent.length ? urgent.map(t => renderTaskItem(t, 'task')).join('') :
    '<div class="empty" style="padding:16px 0"><div style="color:var(--accent)">✓ Sin vencimientos urgentes</div></div>';

  // reminders
  const rems = state.reminders.filter(r => !r.done && r.date >= today()).slice(0, 3);
  const remEl = document.getElementById('dashReminders');
  remEl.innerHTML = rems.length ? rems.map(r => `
    <div class="reminder-item">
      <div>
        <div class="reminder-text">${r.text}</div>
        <div class="reminder-time">${fmtDate(r.date)}${r.time ? ' · ' + r.time : ''}</div>
      </div>
      <button class="btn btn-sm" onclick="dismissReminder('${r.id}')">✓</button>
    </div>`).join('') :
    '<div class="empty" style="padding:12px 0"><div style="color:var(--text3)">Sin recordatorios activos</div></div>';
}

function renderReminders() {
  const el = document.getElementById('reminderList');
  if (!el) return;
  const rems = [...state.reminders].sort((a, b) => (a.date + (a.time||'')) < (b.date + (b.time||'')) ? -1 : 1);
  el.innerHTML = rems.length ? rems.map(r => `
    <div class="reminder-item" style="${r.done ? 'opacity:0.4' : ''}">
      <div style="flex:1">
        <div class="reminder-text" style="${r.done ? 'text-decoration:line-through' : ''}">${r.text}</div>
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
      <div style="flex:1">${l.name}</div>
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
        <div style="font-size:13px;">${item.name}</div>
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
      return `<div class="cal-dot" style="background:${col}18;color:${col};border:1px solid ${col}33;">${(x.name || x.title || x.text || "Sin nombre").slice(0,14)}${(x.name || x.title || x.text || "").length > 14?'…':''}</div>`;
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
      if (item._type === 'reminder') return `<div class="reminder-item"><div><div class="reminder-text">◎ ${item.text}</div></div></div>`;
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
        tasks: [], events: [], reminders: [], log: [], activeTimer: null,
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
  state = { tasks: [], events: [], reminders: [], log: [], activeTimer: null };
  save(); renderAll();
  toast('Datos borrados', 'warn');
}

// ═══════════════════════════════════════════
// RECURRENCIAS AUTOMÁTICAS
// ═══════════════════════════════════════════
const FREQ_DAYS = { daily: 1, weekly: 7, biweekly: 15, monthly: 30 };

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
  return d.toISOString().slice(0, 10);
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
      t.due = d.toISOString().slice(0, 10);
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
  return { daily: 'Diaria', weekly: 'Semanal', biweekly: 'Quincenal', monthly: 'Mensual' }[f] || (f || '—');
}

function openDayReport() {
  const ds = document.getElementById('dayViewDate').value;
  if (!ds) { toast('Seleccioná una fecha', 'warn'); return; }
  const area = document.getElementById('dayReportArea');
  const dayLog = state.log.filter(l => l.date.slice(0, 10) === ds);
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
        <td style="padding:8px 10px;border-bottom:1px solid var(--border)">${l.name}</td>
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
          <div style="font-size:13px">${t.name}</div>
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
if (state.activeTimer && !state.activeTimer.paused) startTicking();
renderAll();
renderSyncIndicator();
// La carga inicial desde Supabase la dispara onAuthReady() una vez que
// se resuelve la sesión (ver bloque SUPABASE más arriba).

// ───────────────────────────────────────────
// AUTO-SYNC ENTRE DISPOSITIVOS (respaldo del realtime)
// ───────────────────────────────────────────
// Supabase Realtime ya empuja los cambios al instante (ver
// startRealtime()). Este polling cada 60s es solo una red de
// seguridad por si algún dispositivo pierde la conexión realtime
// (por ejemplo, se durmió y se despertó). Reglas:
//  - No pisa cambios si hay un timer corriendo en ESTE dispositivo
//    (para no cortar una sesión en curso).
//  - No sincroniza si hay un modal abierto (para no perder lo que
//    se está tipeando).
//  - Se pausa cuando la pestaña no está visible, para no gastar red.
function safeToAutoPull() {
  if (state.activeTimer) return false;
  const modalOpen = document.querySelector('.modal-overlay.open');
  if (modalOpen) return false;
  return true;
}

let autoSyncInterval = null;
function startAutoSync() {
  if (autoSyncInterval) clearInterval(autoSyncInterval);
  autoSyncInterval = setInterval(() => {
    if (document.visibilityState === 'visible' && sheetsEnabled() && safeToAutoPull()) {
      loadFromSheets({ silent: true });
    }
  }, 60000); // cada 60s, de respaldo
}
startAutoSync();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sheetsEnabled() && safeToAutoPull()) {
    loadFromSheets({ silent: true });
  }
});

// ATAJOS
function guardarTarea() {
  const gTarea = document.querySelector(".modal-overlay.open");
  switch (gTarea.id) {
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
    const d = l.date.slice(0, 10);

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
    const d = l.date.slice(0, 10);
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
    const freqLabels = ['Diaria', 'Semanal', 'Quincenal', 'Mensual'];
    const freqKeys   = ['daily', 'weekly', 'biweekly', 'monthly'];
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

/* Inter Club Sulmona - PWA (Netlify friendly)
   Storage: ONLINE (Netlify Blobs) + cache locale solo come fallback.
   Nota: quiz/eventi/bacheca/regolamento/punti/prenotazioni sono condivisi e si aggiornano per tutti i soci.
*/

const LS = {
  members: 'ics_members_v2',          // [{tessera, name}]
  points: 'ics_points_v2',            // {tessera: number}
  session: 'ics_session_v2',          // {tessera, name}
  // Multi-event
  events: 'ics_events_v3',            // [{id,title,date,capacity,note,createdAt}]
  bookings: 'ics_bookings_v3',        // {eventId: {tessera: {seats, at}}}
  // Legacy keys (migrazione)
  event: 'ics_event_v2',              // {id,title,date,capacity,note}
  bookingsLegacy: 'ics_bookings_v2',  // {tessera: {eventId, seats, at}}
  quiz: 'ics_quiz_v2',                // {id,q,opts:[...],correct}
  quizAnswers: 'ics_quiz_answers_v2', // {"tessera::quizId": {letter, correct, at}}
  ticketCfg: 'ics_ticket_cfg_v2',     // {label,url}
  pointsRules: 'ics_points_rules_v1', // string (una riga = un bullet)
  admin: 'ics_admin_v2',              // {pin}
  // Session-only: evita che l'admin resti loggato dopo aver chiuso il browser.
  adminSession: 'ics_admin_session_v1',
  // Shared (visibile a tutti): cache locale dell'ultimo data.json scaricato
  sharedCache: 'ics_shared_cache_v1',
  sharedDirty: 'ics_shared_dirty_v1',  backendDown: 'ics_backend_down_v1',
};

const $ = (id) => document.getElementById(id);

const load = (key, fallback) => {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));


// ===== ONLINE SYNC (Netlify Functions + Supabase) =====
// L'app resta identica, ma eventi/quiz/bacheca/punti/prenotazioni si sincronizzano per tutti i soci.
const API = {
  appData: '/.netlify/functions/appData',
};

function isOnline() {
  return (typeof navigator !== 'undefined') ? navigator.onLine : true;
}

async function apiGet(url) {
  const r = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: { 'Accept': 'application/json', 'Cache-Control': 'no-store' }
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}
async function apiPost(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }

  return await r.json();
}

async function mutateShared(body) {
  // body: {tessera, type, ...}
  return await apiPost('/.netlify/functions/mutate', body);
}

function buildAppDataPayload() {
  const c = getSharedCache();
  return {
    version: Number(c.version || 1),
    updatedAt: Date.now(),
    bulletin: (c.bulletin ?? '') + '',
    events: Array.isArray(c.events) ? c.events : [],
    quiz: c.quiz && typeof c.quiz === 'object' ? c.quiz : null,
    members: Array.isArray(getMembers()) ? getMembers() : [],
    pointsRulesText: (getPointsRulesText() ?? '') + '',
    ticketCfg: getTicketCfg() || { label: 'Biglietti Inter', url: 'https://www.inter.it/' },
    // Stato condiviso (legato alla tessera): serve per cambio telefono e per vedere posti rimasti
    points: getPoints() || {},
    bookings: getBookings() || {},
    quizAnswers: getQuizAnswers() || {},
  };
}

let _pushAppDataTimer = null;
async function pushAppDataNow() {
  // Admin-only (PIN)
  const admin = load(LS.admin, null);
  let pin = admin?.pin ? String(admin.pin) : '';

  // Fallback: se l'admin è loggato ma il PIN non è in localStorage, usa il PIN di default
  // (evita che eliminazioni/aggiornamenti restino solo locali e poi “ricompaiano” dal server)
  if (!pin && getAdminSession()) pin = '190894';
  if (!pin) return;
  const payload = buildAppDataPayload();
  const res = await apiPost(API.appData, { pin, payload });
  // Aggiorna cache con versione server
  if (res && res.payload) {
    const p = res.payload;
    // shared
    setSharedCache({
      ...(getSharedCache() || {}),
      version: p.version || payload.version,
      updatedAt: p.updatedAt || Date.now(),
      bulletin: p.bulletin ?? payload.bulletin,
      events: Array.isArray(p.events) ? p.events : payload.events,
      quiz: p.quiz ?? payload.quiz,
    }, true);
    // other
    if (Array.isArray(p.members)) setMembers(p.members);
    if (typeof p.pointsRulesText === 'string') setPointsRulesText(p.pointsRulesText);
    if (p.ticketCfg && typeof p.ticketCfg === 'object') save(LS.ticketCfg, p.ticketCfg);
    if (p.points && typeof p.points === 'object') setPoints(p.points);
    if (p.bookings && typeof p.bookings === 'object') setBookings(p.bookings);
    if (p.quizAnswers && typeof p.quizAnswers === 'object') setQuizAnswers(p.quizAnswers);
  }
  return res;
}
function schedulePushAppData() {
  if (_pushAppDataTimer) clearTimeout(_pushAppDataTimer);
  _pushAppDataTimer = setTimeout(async () => {
    _pushAppDataTimer = null;
    try {
      if (!isOnline()) return;
      await pushAppDataNow();
      toast('Aggiornato per tutti i soci');
    } catch (e) {
      console.warn('pushAppData error', e);
      toast('Salvato in locale. Online appena possibile.');
    }
  }, 350);
}

async function refreshAppData() {
  if (!isOnline()) return;
  try {
    const res = await apiGet(API.appData);
    setBackendDown(false);
    if (res && res.payload) {
      const p = res.payload;
      setSharedCache({
        ...(getSharedCache() || {}),
        version: p.version || 1,
        updatedAt: p.updatedAt || Date.now(),
        bulletin: p.bulletin ?? '',
        events: Array.isArray(p.events) ? p.events : [],
        quiz: p.quiz ?? null,
      }, true);
      if (Array.isArray(p.members)) setMembers(p.members);
      if (typeof p.pointsRulesText === 'string') setPointsRulesText(p.pointsRulesText);
      if (p.ticketCfg && typeof p.ticketCfg === 'object') save(LS.ticketCfg, p.ticketCfg);

      // Stato condiviso legato alla tessera (cambio telefono + posti rimasti + storico risposte)
      if (p.points && typeof p.points === 'object') setPoints(p.points);
      if (p.bookings && typeof p.bookings === 'object') setBookings(p.bookings);
      if (p.quizAnswers && typeof p.quizAnswers === 'object') setQuizAnswers(p.quizAnswers);
    }
  } catch (e) {
    setBackendDown(true);
    console.warn('refreshAppData error', e);
  }
}



window.addEventListener('online', () => { try { refreshAppData().then(()=>{ try{render();}catch{} }); } catch {} });

// Refresh when the app returns to foreground (PWA often stays open)
window.addEventListener('focus', () => { try { refreshAppData().then(()=>{ try{render();}catch{} }); } catch {} });
document.addEventListener('visibilitychange', () => {
  try {
    if (document.visibilityState === 'visible') refreshAppData().then(()=>{ try{render();}catch{} });
  } catch {}
});



// ===== Shared content (data.json) =====
function getSharedCache() {
  const base = { version: 1, updatedAt: 0, bulletin: '', events: [], quiz: null };
  const c = load(LS.sharedCache, base) || base;
  // Hardening
  c.events = Array.isArray(c.events) ? c.events : [];
  c.quiz = c.quiz && typeof c.quiz === 'object' ? c.quiz : null;
  c.bulletin = (c.bulletin ?? '') + '';
  c.updatedAt = Number(c.updatedAt || 0);
  c.version = Number(c.version || 1);
  return c;
}
function setSharedCache(next, markDirty=true) {
  save(LS.sharedCache, next);
  try {
    if (markDirty) localStorage.setItem(LS.sharedDirty, '1');
  } catch {}
}
function clearSharedDirty() {
  try { localStorage.removeItem(LS.sharedDirty); } catch {}
}
function isSharedDirty() {
  try { return localStorage.getItem(LS.sharedDirty) === '1'; } catch { return false; }
}

function setBackendDown(isDown) {
  try {
    if (isDown) localStorage.setItem(LS.backendDown, '1');
    else localStorage.removeItem(LS.backendDown);
  } catch {}
}
function isBackendDown() {
  try { return localStorage.getItem(LS.backendDown) === '1'; } catch { return false; }
}


// Scarica e aggiorna il contenuto condiviso (visibile a tutti)
async function syncSharedFromNetwork({ silent=false } = {}) {
  try {
    await refreshAppData();
    if (!silent) toast('Aggiornato');
  } catch (e) {
    console.warn('syncSharedFromNetwork', e);
  }
}

// Session storage (solo per mantenere l'admin dentro finché non chiude la pagina)
function getAdminSession() {
  try { return sessionStorage.getItem(LS.adminSession) === '1'; } catch { return false; }
}
function setAdminSession(on) {
  try {
    if (on) sessionStorage.setItem(LS.adminSession, '1');
    else sessionStorage.removeItem(LS.adminSession);
  } catch {}
}

const toast = (msg) => {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2200);
};

function normalizeTessera(s) {
  // Le tessere possono iniziare con lettere (S/J/O...).
  // Normalizzo rimuovendo spazi e portando tutto in MAIUSCOLO.
  return String(s ?? '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeName(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

// Seed iniziale: soci ATTIVI importati dal file Excel.
// Serve solo come prima configurazione: poi l'admin può aggiungere/modificare/importare.
// Formato: [{tessera, name}]
const SEED_MEMBERS = [{"tessera": "S00000960753", "name": "Alessandro Allega"}, {"tessera": "S00001009383", "name": "Francesco Angelone"}, {"tessera": "S00001098267", "name": "Giampiero Balassone"}, {"tessera": "S00000850011", "name": "Augusto Bevilacqua"}, {"tessera": "S00000617131", "name": "MATTEO CONSIGLIO"}, {"tessera": "S00000872923", "name": "Concezio Capaldo"}, {"tessera": "S00000871865", "name": "Antonio Capparuccia"}, {"tessera": "S00000658001", "name": "Francesco Civitareale"}, {"tessera": "S00001099019", "name": "Jacopo Corsetti"}, {"tessera": "J00001170335", "name": "Francesco Crisi"}, {"tessera": "S00000143863", "name": "CRISTIAN DI MEO"}, {"tessera": "S00000227235", "name": "ENRICO DIANA"}, {"tessera": "S00000240427", "name": "Federico De foglio"}, {"tessera": "S00001170172", "name": "Manuel Del signore"}, {"tessera": "S00000795679", "name": "Alessandro Di Camillo"}, {"tessera": "S00000214603", "name": "Valerio Di Fonso"}, {"tessera": "S00000143862", "name": "Luciano Di Meo"}, {"tessera": "S00000825127", "name": "Luca Maria Di Michele"}, {"tessera": "S00000669877", "name": "Davide Di Nino"}, {"tessera": "S00000169406", "name": "Simona Federica Di Pillo"}, {"tessera": "S00001112494", "name": "Daniel Di Stefano"}, {"tessera": "S00001164389", "name": "Aron Di paolo"}, {"tessera": "S00000550767", "name": "Domenico Di persio"}, {"tessera": "S00000870381", "name": "Alessio Falconio"}, {"tessera": "S00000105257", "name": "Domenico Fontana"}, {"tessera": "S00000616499", "name": "Beatrice Gavita"}, {"tessera": "S00000413515", "name": "Cristian Gavita"}, {"tessera": "S00000016584", "name": "Celestino Gentile"}, {"tessera": "S00001093739", "name": "Valentino Giampaolo"}, {"tessera": "S00001125394", "name": "vito Graceffo"}, {"tessera": "S00000308145", "name": "Francesco Grandi"}, {"tessera": "S00001158324", "name": "Marzia Guerrieri"}, {"tessera": "S00001166281", "name": "Dante L'erario"}, {"tessera": "S00000169415", "name": "Viviana Leombruno"}, {"tessera": "S00000318817", "name": "Andrea Leone"}, {"tessera": "S00000169862", "name": "Guerino Leone"}, {"tessera": "S00001165468", "name": "attilio Maiorano"}, {"tessera": "S00001094498", "name": "Benedetta Malvestuto Grilli"}, {"tessera": "S00001094809", "name": "Luigi Amedeo Malvestuto Grilli"}, {"tessera": "S00001048429", "name": "Samuel Marchetti"}, {"tessera": "S00000960731", "name": "Maurizio Mariani"}, {"tessera": "S00000711659", "name": "Andrea Marinucci"}, {"tessera": "S00001093455", "name": "Matteo Marinucci"}, {"tessera": "S00001166291", "name": "Antonio Mauro"}, {"tessera": "S00001164741", "name": "Antonio Mendozzi"}, {"tessera": "S00001170456", "name": "Andrea Montanaro"}, {"tessera": "S00001067459", "name": "Mariana Moroni"}, {"tessera": "S00000240818", "name": "Alessia Natale"}, {"tessera": "S00001092843", "name": "Anna maria Natale"}, {"tessera": "S00001009373", "name": "Azzurra Natale"}, {"tessera": "S00000133421", "name": "Giuseppe peter Natale"}, {"tessera": "S00001048525", "name": "ANDREA PAGANO"}, {"tessera": "S00001048519", "name": "VINCENZO PAGANO"}, {"tessera": "S00001170508", "name": "Patrizio Pacella"}, {"tessera": "S00001117246", "name": "Antonio Pagliaro"}, {"tessera": "S00001095400", "name": "Aurora Piccolo"}, {"tessera": "S00000105223", "name": "Angelo Pileri"}, {"tessera": "S00000318134", "name": "Fernando Polce"}, {"tessera": "S00001107436", "name": "concezio Polce Rino"}, {"tessera": "S00000268333", "name": "Andrea Ramunno"}, {"tessera": "S00001164397", "name": "Attilio Ramunno"}, {"tessera": "S00000711621", "name": "Daniele Rangoni"}, {"tessera": "S00000969079", "name": "Paolo Recanati"}, {"tessera": "S00000376821", "name": "Riccardo Roncone"}, {"tessera": "S00000275058", "name": "Francesco Rossi"}, {"tessera": "S00001128220", "name": "Matteo Concezio Sbraccia"}, {"tessera": "S00000820123", "name": "Carlo Sereno"}, {"tessera": "S00000678151", "name": "Matteo Settevendemmie"}, {"tessera": "S00000378817", "name": "Walter Sito"}, {"tessera": "S00001093006", "name": "Gianluca Spera"}, {"tessera": "S00001096057", "name": "Alessandro Spinosa"}, {"tessera": "S00000882423", "name": "Anna Spinosa"}, {"tessera": "S00000148659", "name": "Marco Tirimacco"}, {"tessera": "S00000837383", "name": "Matteo Tirimacco"}, {"tessera": "S00000208567", "name": "Bruno Tornifoglia"}, {"tessera": "S00000283237", "name": "Nicholas Toto"}, {"tessera": "S00001163560", "name": "Angelo Zappacosta"}, {"tessera": "S00001023125", "name": "Mariarita Zinatelli Arcieri"}, {"tessera": "S00001094602", "name": "Francesco Zinatelli arcieri"}, {"tessera": "S00001150658", "name": "alessandro agnitelli"}, {"tessera": "S00000589395", "name": "canjedo balaj"}, {"tessera": "S00001113575", "name": "jacopo bisignani"}, {"tessera": "J00001141274", "name": "adriano borri"}, {"tessera": "S00001131191", "name": "fabio cafarelli"}, {"tessera": "S00000738219", "name": "marco cicerone"}, {"tessera": "S00001056383", "name": "mauro d'angelo"}, {"tessera": "S00000863911", "name": "luigi del conte"}, {"tessera": "S00000118287", "name": "fabio di fonso"}, {"tessera": "S00000118292", "name": "jacopo di fonso"}, {"tessera": "S00001108982", "name": "ida di lisio"}, {"tessera": "S00000914881", "name": "davide di pardo"}, {"tessera": "S00000565485", "name": "andreas di stefano"}, {"tessera": "S00000565495", "name": "emilio di stefano"}, {"tessera": "S00001125402", "name": "piero fasciani"}, {"tessera": "S00001150962", "name": "fabio federico"}, {"tessera": "S00000240453", "name": "cristian fieramosca"}, {"tessera": "S00001150651", "name": "christian frattaroli"}, {"tessera": "S00000991417", "name": "Julian gatza"}, {"tessera": "S00001154792", "name": "silvio iafolla"}, {"tessera": "S00001067461", "name": "giulia la gatta"}, {"tessera": "S00001133420", "name": "clemente maiorano"}, {"tessera": "S00001150681", "name": "annamaria malvestuto grilli"}, {"tessera": "S00000872457", "name": "alberto manini"}, {"tessera": "S00001138407", "name": "fabio maurizi"}, {"tessera": "S00001164390", "name": "Domenico melchiorre"}, {"tessera": "J00000240816", "name": "antonio pipoli"}, {"tessera": "S00001133419", "name": "andrea primavera"}, {"tessera": "S00001138685", "name": "fulvio ricciardi"}, {"tessera": "S00001150969", "name": "gianni sbraccia"}, {"tessera": "S00001158322", "name": "angelo scipione"}, {"tessera": "S00001152920", "name": "annamaria susi"}, {"tessera": "S00001109011", "name": "dante daniele valeri"}, {"tessera": "S00000240825", "name": "diana valeriano"}, {"tessera": "S00001131648", "name": "raffaele verrocchi"}, {"tessera": "S00000714729", "name": "liridon ziberi"}];

function bootstrapDefaults() {
  if (!localStorage.getItem(LS.members)) {
    // Prima installazione: inizializzo con elenco soci ATTIVI.
    save(LS.members, Array.isArray(SEED_MEMBERS) ? SEED_MEMBERS : []);
  }
  if (!localStorage.getItem(LS.points)) save(LS.points, {});
  if (!localStorage.getItem(LS.events)) save(LS.events, []);
  if (!localStorage.getItem(LS.bookings)) save(LS.bookings, {});
  if (!localStorage.getItem(LS.quizAnswers)) save(LS.quizAnswers, {});

  if (!localStorage.getItem(LS.ticketCfg)) {
    save(LS.ticketCfg, { label: 'Biglietti Inter', url: 'https://www.inter.it/it/biglietteria' });
  }
  if (!localStorage.getItem(LS.admin)) {
    save(LS.admin, { pin: '190894' });
  }

  if (!localStorage.getItem(LS.pointsRules)) {
    save(LS.pointsRules, [
      '+10 punti ogni prenotazione',
      '−10 punti se annulli la prenotazione',
      '+2 punti se rispondi correttamente al quiz',
    ].join('\n'));
  }

  // Migrazione: evento singolo -> lista eventi
  try {
    const legacyEventRaw = localStorage.getItem(LS.event);
    const eventsRaw = localStorage.getItem(LS.events);
    const events = eventsRaw ? JSON.parse(eventsRaw) : [];
    if (legacyEventRaw && Array.isArray(events) && events.length === 0) {
      const legacyEvent = JSON.parse(legacyEventRaw);
      if (legacyEvent?.id) {
        save(LS.events, [{ ...legacyEvent, createdAt: Date.now() }]);
      }
    }
  } catch {}

  // Migrazione: prenotazioni vecchie -> prenotazioni per evento
  try {
    const legacyBookingsRaw = localStorage.getItem(LS.bookingsLegacy);
    const bookingsRaw = localStorage.getItem(LS.bookings);
    const bookings = bookingsRaw ? JSON.parse(bookingsRaw) : {};
    if (legacyBookingsRaw && bookingsRaw && Object.keys(bookings || {}).length === 0) {
      const legacy = JSON.parse(legacyBookingsRaw) || {};
      const out = {};
      Object.entries(legacy).forEach(([t, b]) => {
        if (!b?.eventId) return;
        out[b.eventId] = out[b.eventId] || {};
        out[b.eventId][normalizeTessera(t)] = { seats: Number(b.seats || 1), at: Number(b.at || Date.now()) };
      });
      save(LS.bookings, out);
    }
  } catch {}
}

function getSession() { return load(LS.session, null); }
function setSession(v) { save(LS.session, v); }
function clearSession() { localStorage.removeItem(LS.session); }

function getMembers() { return load(LS.members, []); }
function setMembers(v) { save(LS.members, v); }

function getPoints() { return load(LS.points, {}); }
function setPoints(v) { save(LS.points, v); }
function addPoints(tessera, delta) {
  const t = normalizeTessera(tessera);
  const pts = getPoints();
  pts[t] = (pts[t] || 0) + delta;
  if (pts[t] < 0) pts[t] = 0;
  setPoints(pts);
}

function getEvents() {
  const c = getSharedCache();
  // Se la cache condivisa ha già la proprietà `events` (anche vuota), è la fonte di verità.
  if (Array.isArray(c.events)) return c.events;
  // fallback legacy (vecchie versioni): migro in cache condivisa
  const legacy = load(LS.events, []);
  if (Array.isArray(legacy) && legacy.length) {
    setSharedCache({ ...c, events: legacy, updatedAt: c.updatedAt || Date.now() }, true);
    return legacy;
  }
  return [];
}
function setEvents(v) {
  const c = getSharedCache();
  const nextEvents = Array.isArray(v) ? v : [];
  const next = { ...c, events: nextEvents, updatedAt: Date.now() };
  setSharedCache(next, true);
  // Evita “resurrezioni” da storage legacy (vecchie versioni)
  try { localStorage.removeItem(LS.events); } catch {}
}
function getEventById(id) {
  const events = getEvents();
  return events.find(e => e && e.id === id) || null;
}

function getBookings() { return load(LS.bookings, {}); }
function setBookings(v) { save(LS.bookings, v); }

function getQuiz() {
  const c = getSharedCache();
  // Se la cache condivisa contiene già la chiave `quiz` (anche null), è la fonte di verità.
  if (c && Object.prototype.hasOwnProperty.call(c, 'quiz')) return c.quiz;
  const legacy = load(LS.quiz, null);
  if (legacy && typeof legacy === 'object') {
    setSharedCache({ ...c, quiz: legacy, updatedAt: c.updatedAt || Date.now() }, true);
    return legacy;
  }
  return null;
}
function setQuiz(v) {
  const c = getSharedCache();
  const next = { ...c, quiz: v && typeof v === 'object' ? v : null, updatedAt: Date.now() };
  setSharedCache(next, true);
}
// Rimozione quiz: nella versione sync il quiz vive nella cache condivisa (sharedCache),
// mentre LS.quiz è solo un legacy key. Se rimuovo solo LS.quiz, il quiz resta visibile.
function clearQuiz() {
  try { localStorage.removeItem(LS.quiz); } catch {}
  setQuiz(null);
}

function getBulletin() { return getSharedCache().bulletin || ''; }
function setBulletin(txt) {
  const c = getSharedCache();
  const next = { ...c, bulletin: (txt ?? '') + '', updatedAt: Date.now() };
  setSharedCache(next, true);
}

function getQuizAnswers() { return load(LS.quizAnswers, {}); }
function setQuizAnswers(v) { save(LS.quizAnswers, v); }

function getTicketCfg() { return load(LS.ticketCfg, { label: 'Biglietti Inter', url: 'https://www.inter.it/it/biglietteria' }); }
function setTicketCfg(v) { save(LS.ticketCfg, v); }

function getPointsRulesText() {
  return load(LS.pointsRules, [
    '+10 punti ogni prenotazione',
    '−10 punti se annulli la prenotazione',
    '+2 punti se rispondi correttamente al quiz',
  ].join('\n'));
}
function setPointsRulesText(v) { save(LS.pointsRules, String(v ?? '')); }

function show(viewId) {
  // Utility CSS: rende l'admin più compatto senza toccare le altre schermate.
  try {
    document.body.classList.toggle('is-admin', viewId === 'viewAdmin');
  } catch {}
  ['viewLogin', 'viewHome', 'viewAdmin'].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = (id !== viewId);
  });
}

function resetAllPointsAdmin() {
  // Reset totale punti fedeltà: 3 conferme + PIN.
  if (!confirm('ATTENZIONE: vuoi AZZERARE i punti fedeltà di TUTTI i soci?')) return;
  if (!confirm('Confermi davvero? Questa operazione NON si può annullare.')) return;
  if (!confirm('ULTIMA CONFERMA: sei sicuro al 100%?')) return;
  const pin = String(prompt('Inserisci PIN admin per confermare (190894):') || '').trim();
  if (pin !== '190894') {
    toast('PIN errato: operazione annullata');
    return;
  }
  setPoints({});
  toast('Punti azzerati per tutti');
  // Aggiorna UI
  if (isAdminViewOpen()) renderAdmin();
  if (!isAdminViewOpen()) render();
}

function sanitizeTesseraInput() {
  const el = $('loginTessera');
  if (!el) return;
  // Mantengo la digitazione comoda: rimuovo spazi e porto in MAIUSCOLO.
  const v = String(el.value || '').replace(/\s+/g, '').toUpperCase();
  if (el.value !== v) el.value = v;
}

function renderHome() {
  const sess = getSession();
  if (!sess?.tessera) return;

  const name = sess.name ? sess.name : 'Socio';
  $('hello').textContent = `Ciao, ${name} 👋`;
  $('memberInfo').textContent = `Tessera: ${sess.tessera} • Nome: ${name}`;

  const pts = getPoints();
  $('pointsValue').textContent = String(pts[normalizeTessera(sess.tessera)] || 0);

  // Backend status (se pubblicata senza Functions il contenuto resta vuoto)
  const ba = $('backendAlert');
  if (ba) {
    if (isBackendDown()) {
      ba.hidden = false;
      ba.innerHTML = `<b>⚠️ Contenuti non sincronizzati</b><br>Il contenuto condiviso (bacheca/eventi/quiz/punti) arriva dal backend. Se il sito è stato pubblicato con drag&drop, le Netlify Functions non vengono attivate e i soci vedono tutto vuoto.<br><br><b>Soluzione:</b> fai Deploy da Git (consigliato) oppure da Netlify CLI con build attiva, così le funzioni <code>/.netlify/functions</code> funzionano.`;
    } else {
      ba.hidden = true;
      ba.textContent = '';
    }
  }

  // Bacheca (testo condiviso)
  const b = getBulletin();
  const bb = $('bulletinBox');
  if (bb) {
    bb.innerHTML = '';
    if (!b.trim()) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = 'Nessuna comunicazione al momento.';
      bb.appendChild(p);
    } else {
      b.split(/\n+/).forEach(line => {
        const d = document.createElement('div');
        d.className = 'bulletLine';
        d.textContent = line;
        bb.appendChild(d);
      });
    }
  }

  // Ticket
  const tc = getTicketCfg();
  $('btnTicket').textContent = tc.label || 'Biglietti Inter';

  // Regolamento punti
  const rulesEl = $('pointsRulesList');
  if (rulesEl) {
    const raw = getPointsRulesText();
    const lines = String(raw || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    rulesEl.innerHTML = '';
    (lines.length ? lines : ['+10 punti ogni prenotazione', '−10 punti se annulli la prenotazione', '+2 punti se rispondi correttamente al quiz'])
      .forEach(line => {
        const li = document.createElement('li');
        li.textContent = line;
        rulesEl.appendChild(li);
      });
  }

  // Eventi (lista)
  const events = getEvents().slice().sort((a, b) => (Number(b.createdAt || 0) - Number(a.createdAt || 0)));
  const bookings = getBookings();
  const t = normalizeTessera(sess.tessera);
  const list = $('eventsList');
  if (list) {
    list.innerHTML = '';

    if (!events.length) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = 'Nessun evento pubblicato.';
      list.appendChild(p);
    } else {
      events.forEach(ev => {
        const evBookings = bookings[ev.id] || {};
        const my = evBookings[t] || null;
        const used = Object.values(evBookings).reduce((s, b) => s + (Number(b?.seats) || 0), 0);
        const cap = Number(ev.capacity) || 0;
        const left = cap ? Math.max(0, cap - used) : null;

        const card = document.createElement('div');
        card.className = 'item';

        const title = escapeHtml(ev.title || 'Evento');
        const date = escapeHtml(ev.date || '—');
        const note = escapeHtml(ev.note || '');
        const seatsTxt = cap ? `Posti: <b>${left}</b>/${cap}` : 'Posti: —';

        card.innerHTML = `
          <div class="item__title">${title}</div>
          <div class="item__meta"><span class="pill">${date}</span> <span class="pill">${seatsTxt}</span></div>
          ${note ? `<div class="small muted" style="margin-top:6px">${note}</div>` : ''}
          <div class="divider" style="margin:10px 0"></div>
          <div class="row" style="gap:10px; align-items:center; justify-content:space-between">
            <div class="small ${my ? 'ok' : 'muted'}">${my ? `Prenotato: <b>${my.seats}</b> posto ✅` : 'Nessuna prenotazione'}</div>
            <div class="grid" style="grid-template-columns:1fr 1fr; gap:8px; min-width:220px">
              <button class="primary" data-action="book" data-evid="${escapeHtml(ev.id)}">Prenota 1 posto</button>
              <button class="danger" data-action="cancel" data-evid="${escapeHtml(ev.id)}">Annulla</button>
            </div>
          </div>
        `;

        const btnBook = card.querySelector('button[data-action="book"]');
        const btnCancel = card.querySelector('button[data-action="cancel"]');

        // stato bottoni
        if (my) {
          btnBook.hidden = true;
          btnCancel.hidden = false;
        } else {
          btnBook.hidden = false;
          btnCancel.hidden = true;
          if (cap && left <= 0) {
            btnBook.disabled = true;
            btnBook.textContent = 'Posti esauriti';
          }
        }

        btnBook.addEventListener('click', () => bookEvent(ev.id));
        btnCancel.addEventListener('click', () => cancelEvent(ev.id));

        list.appendChild(card);
      });
    }
  }

  // Quiz
  const quiz = getQuiz();
  const ans = getQuizAnswers();

  if (!quiz) {
    $('quizTitle').textContent = 'Nessun quiz pubblicato';
    $('quizBox').hidden = true;
  } else {
    $('quizTitle').textContent = quiz.q || 'Quiz';
    $('quizBox').hidden = false;

    const statusPill = $('quizStatus');
    const resultBox = $('quizResult');
    if (resultBox) {
      resultBox.hidden = true;
      resultBox.textContent = '';
    }

    const key = `${normalizeTessera(sess.tessera)}::${quiz.id}`;
    const already = ans[key];

    const wrap = $('quizOptions');
    wrap.innerHTML = '';

    const letters = ['A', 'B', 'C', 'D'];
    letters.forEach((L, i) => {
      const optText = quiz.opts?.[i] ?? '';
      const btn = document.createElement('button');
      btn.className = 'option__btn';
      btn.textContent = `${L}) ${optText}`;
      // Stato: se già risposto, blocca e mostra feedback
      if (already) {
        btn.disabled = true;
        if (L === quiz.correct) btn.classList.add('correct');
        if (L === already.letter) btn.classList.add('selected');
        if (L === already.letter && !already.correct) btn.classList.add('wrong');
      } else {
        btn.disabled = false;
      }
      btn.addEventListener('click', () => selectQuiz(L));
      wrap.appendChild(btn);
    });

    const submitBtn = $('btnSubmitQuiz');
    submitBtn.disabled = true;
    submitBtn.dataset.choice = '';
    submitBtn.hidden = !!already;

    if (already) {
      if (statusPill) {
        statusPill.textContent = already.correct ? 'Risposto ✅' : 'Risposto ❌';
        statusPill.className = 'pill ' + (already.correct ? 'okBadge' : '');
      }

      const correctText = quiz.opts?.[(['A','B','C','D'].indexOf(quiz.correct))] ?? '';
      const chosenText = quiz.opts?.[(['A','B','C','D'].indexOf(already.letter))] ?? '';
      if (resultBox) {
        resultBox.hidden = false;
        resultBox.innerHTML = already.correct
          ? `Bravo! Hai risposto <b>${escapeHtml(already.letter)}</b> (${escapeHtml(chosenText)}). +2 punti.`
          : `Hai risposto <b>${escapeHtml(already.letter)}</b> (${escapeHtml(chosenText)}). Risposta corretta: <b>${escapeHtml(quiz.correct)}</b> (${escapeHtml(correctText)}).`;
      }

      $('quizHint').textContent = 'Hai già risposto: potrai rispondere solo al prossimo quiz.';
    } else {
      if (statusPill) {
        statusPill.textContent = 'Quiz attivo';
        statusPill.className = 'pill';
      }
      $('quizHint').textContent = 'Scegli una risposta e poi premi "Invia risposta". Dopo non potrai più rispondere fino al prossimo quiz.';
    }
  }
}

function renderAdmin() {
  // settings
  const tc = getTicketCfg();
  $('ticketLabel').value = tc.label || '';
  $('ticketLink').value = tc.url || '';

  // Regolamento punti
  const pr = $('pointsRules');
  if (pr) pr.value = getPointsRulesText() || '';

  // Bacheca
  const ba = $('bulletinAdmin');
  if (ba) ba.value = getBulletin() || '';
  // Eventi
  const events = getEvents().slice().sort((a, b) => (Number(b.createdAt || 0) - Number(a.createdAt || 0)));

  // dropdown eventi (admin)
  const selAdmin = $('eventAdminSelect');
  if (selAdmin) {
    selAdmin.innerHTML = '';
    if (!events.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Nessun evento';
      selAdmin.appendChild(opt);
    } else {
      events.forEach(ev => {
        const opt = document.createElement('option');
        opt.value = ev.id;
        opt.textContent = `${ev.title || 'Evento'}${ev.date ? ' • ' + ev.date : ''}`;
        selAdmin.appendChild(opt);
      });
    }
  }

  // dropdown evento per prenotazioni
  const selBook = $('bookingEventSelect');
  if (selBook) {
    const prev = selBook.value;
    selBook.innerHTML = '';
    if (!events.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Nessun evento';
      selBook.appendChild(opt);
    } else {
      events.forEach(ev => {
        const opt = document.createElement('option');
        opt.value = ev.id;
        opt.textContent = `${ev.title || 'Evento'}${ev.date ? ' • ' + ev.date : ''}`;
        selBook.appendChild(opt);
      });
      selBook.value = prev && events.some(e => e.id === prev) ? prev : events[0].id;
    }
  }

  // form "Crea nuovo evento" (lasciamo quello che c'è scritto)
  // Se i campi sono vuoti, metti placeholder puliti
  if (!$('eventAdminTitle').value) $('eventAdminTitle').value = '';
  if (!$('eventAdminDate').value) $('eventAdminDate').value = '';
  if (!$('eventAdminCapacity').value) $('eventAdminCapacity').value = '';
  if (!$('eventAdminNote').value) $('eventAdminNote').value = '';

  const quiz = getQuiz();
  $('quizQ').value = quiz?.q || '';
  $('quizA').value = quiz?.opts?.[0] || '';
  $('quizB').value = quiz?.opts?.[1] || '';
  $('quizC').value = quiz?.opts?.[2] || '';
  $('quizD').value = quiz?.opts?.[3] || '';
  $('quizCorrect').value = quiz?.correct || '';

  // allowed list textarea
  const members = getMembers();
  $('allowedList').value = members
    .slice()
    .sort((a, b) => normalizeTessera(a.tessera).localeCompare(normalizeTessera(b.tessera)))
    .map(m => `${normalizeTessera(m.tessera)}${m.name ? `, ${m.name}` : ''}`)
    .join('\n');

  // Editor rapido tessere (modifica nome / rimuovi)
  renderAllowedEditor(members);

  // preview list
  const list = $('memberList');
  if (list) {
    const pts = getPoints();
    list.innerHTML = '';

    if (!members.length) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = 'Nessuna tessera inserita.';
      list.appendChild(p);
    } else {
      members
        .slice()
        .sort((a, b) => normalizeTessera(a.tessera).localeCompare(normalizeTessera(b.tessera)))
        .forEach(m => {
          const row = document.createElement('div');
          row.className = 'row';
          row.style.alignItems = 'center';
          row.style.justifyContent = 'space-between';

          const left = document.createElement('div');
          const t = normalizeTessera(m.tessera);
          const name = m.name ? m.name : '—';
          left.innerHTML = `<div><b>${t}</b> • ${escapeHtml(name)}</div><div class="small muted">Punti: <b>${pts[t] || 0}</b></div>`;

          const right = document.createElement('div');
          right.className = 'grid';
          right.style.gridTemplateColumns = 'repeat(4, 1fr)';
          right.style.gap = '6px';
          right.style.minWidth = '220px';

          const mkBtn = (txt, delta, cls) => {
            const b = document.createElement('button');
            b.className = cls;
            b.textContent = txt;
            b.addEventListener('click', () => {
              addPoints(t, delta);
              toast(`Punti ${delta > 0 ? '+' : ''}${delta} a ${t}`);
              renderAdmin();
              // Non ricalcolo tutta la UI mentre sono nell'admin:
              // evita che la vista venga cambiata/"chiusa" su alcuni browser.
              if (!isAdminViewOpen()) render();
            });
            return b;
          };

          right.appendChild(mkBtn('+10', 10, 'secondary'));
          right.appendChild(mkBtn('+1', 1, 'secondary'));
          right.appendChild(mkBtn('-1', -1, 'ghost'));
          right.appendChild(mkBtn('-10', -10, 'ghost'));

          row.appendChild(left);
          row.appendChild(right);
          list.appendChild(row);
        });
    }
  }

  // Classifica punti (automatica)
  const leaderboard = $('leaderboardList');
  if (leaderboard) {
    const pts = getPoints();
    leaderboard.innerHTML = '';

    const rows = members
      .slice()
      .map(m => {
        const t = normalizeTessera(m.tessera);
        const name = m.name ? m.name : '—';
        return { tessera: t, name, points: Number(pts[t] || 0) };
      })
      .sort((a, b) => (b.points - a.points) || a.tessera.localeCompare(b.tessera));

    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = 'Nessun socio.';
      leaderboard.appendChild(p);
    } else {
      rows.forEach((r, idx) => {
        const item = document.createElement('div');
        item.className = 'item';
        item.innerHTML = `<div class="item__title">#${idx + 1} • ${escapeHtml(r.name)} <span class="muted">(${escapeHtml(r.tessera)})</span></div>
          <div class="item__meta">Punti: <b>${r.points}</b></div>`;
        leaderboard.appendChild(item);
      });
    }
  }

  // Prenotazioni evento (chi ha prenotato)
  const bookingList = $('bookingList');
  if (bookingList) {
    bookingList.innerHTML = '';
    const bookings = getBookings();
    const sel = $('bookingEventSelect');
    const evId = sel ? String(sel.value || '') : '';
    const ev = evId ? getEventById(evId) : null;

    if (!ev) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = 'Nessun evento selezionato.';
      bookingList.appendChild(p);
    } else {
      const evBookings = bookings[ev.id] || {};
      const booked = Object.entries(evBookings)
        .map(([tessera, b]) => {
          const m = members.find(mm => normalizeTessera(mm.tessera) === normalizeTessera(tessera));
          return {
            tessera: normalizeTessera(tessera),
            name: m?.name ? m.name : '—',
            seats: Number(b?.seats || 0),
            at: Number(b?.at || 0),
          };
        })
        .sort((a, b) => (a.at - b.at));

      if (!booked.length) {
        const p = document.createElement('p');
        p.className = 'muted small';
        p.textContent = 'Ancora nessuna prenotazione.';
        bookingList.appendChild(p);
      } else {
        const total = booked.reduce((s, r) => s + (r.seats || 0), 0);
        const cap = Number(ev.capacity) || 0;

        const head = document.createElement('div');
        head.className = 'notice';
        head.innerHTML = `<b>${escapeHtml(ev.title || 'Evento')}</b><br><span class="muted">${escapeHtml(ev.date || '—')}</span><br>Totale prenotati: <b>${total}</b>${cap ? ` / ${cap}` : ''}`;
        bookingList.appendChild(head);

        booked.forEach((r, idx) => {
          const item = document.createElement('div');
          item.className = 'item';
          const when = r.at ? new Date(r.at).toLocaleString('it-IT') : '—';
          item.innerHTML = `<div class="item__title">${idx + 1}. ${escapeHtml(r.name)} <span class="muted">(${escapeHtml(r.tessera)})</span></div>
            <div class="item__meta">Posti: <b>${r.seats}</b> • Prenotato: ${escapeHtml(when)}</div>`;
          bookingList.appendChild(item);
        });
      }
    }
  }
}

function savePointsRules() {
  const ta = $('pointsRules');
  if (!ta) return;
  const text = String(ta.value || '').replace(/\r\n/g, '\n').trim();
  if (!text) {
    toast('Inserisci almeno una riga');
    return;
  }
  setPointsRulesText(text);
  toast('Regolamento salvato');
  schedulePushAppData();
  // Aggiorna subito anche la vista soci se sei loggato
  try { renderHome(); } catch {}
}


function saveBulletinAdmin() {
  const ta = $('bulletinAdmin');
  if (!ta) return;
  const text = String(ta.value || '').replace(/\r\n/g, '\n').trim();
  setBulletin(text);
  toast('Bacheca salvata');
  schedulePushAppData();
  renderAdmin();
  if (!isAdminViewOpen()) render();
}





function renderAllowedEditor(members) {
  const box = $('allowedEditorList');
  const qEl = $('allowedSearch');
  if (!box) return;

  const q = (qEl?.value || '').trim().toLowerCase();
  const list = (Array.isArray(members) ? members : [])
    .slice()
    .sort((a, b) => normalizeTessera(a.tessera).localeCompare(normalizeTessera(b.tessera)))
    .filter(m => {
      if (!q) return true;
      const t = normalizeTessera(m.tessera).toLowerCase();
      const n = String(m.name || '').toLowerCase();
      return t.includes(q) || n.includes(q);
    });

  box.innerHTML = '';

  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = q ? 'Nessun risultato.' : 'Nessuna tessera inserita.';
    box.appendChild(p);
    return;
  }

  list.forEach(m => {
    const t = normalizeTessera(m.tessera);

    const item = document.createElement('div');
    item.className = 'item';

    const head = document.createElement('div');
    head.className = 'adminEditHead';
    head.innerHTML = `<div class="adminEditTitle"><b>${t}</b></div>`;

    const nameField = document.createElement('div');
    nameField.className = 'adminEditName';
    const nameInput = document.createElement('input');
    nameInput.value = m.name || '';
    nameInput.placeholder = 'Nome e Cognome';
    nameInput.autocomplete = 'off';

    const actions = document.createElement('div');
    actions.className = 'adminEditActions';

    const btnSave = document.createElement('button');
    btnSave.className = 'secondary';
    btnSave.textContent = 'Salva';
    btnSave.addEventListener('click', () => {
      const nextName = normalizeName(nameInput.value);
      const all = getMembers();
      const idx = all.findIndex(x => normalizeTessera(x.tessera) === t);
      if (idx >= 0) {
        all[idx] = { ...all[idx], name: nextName };
        setMembers(all);
        toast('Salvato');
        renderAdmin();
      }
    });

    const btnDel = document.createElement('button');
    btnDel.className = 'ghost';
    btnDel.textContent = 'Rimuovi';
    btnDel.addEventListener('click', () => {
      const all = getMembers().filter(x => normalizeTessera(x.tessera) !== t);
      setMembers(all);
      toast('Rimosso');
      renderAdmin();
    });

    actions.appendChild(btnSave);
    actions.appendChild(btnDel);
    nameField.appendChild(nameInput);

    item.appendChild(head);
    item.appendChild(nameField);
    item.appendChild(actions);
    box.appendChild(item);
  });
}

function render() {
  const sess = getSession();
  $('btnLogout').hidden = !sess?.tessera;

  if (!sess?.tessera) {
    $('brandSub').textContent = 'App Soci • Accesso con tessera';
    show('viewLogin');
    return;
  }

  $('brandSub').textContent = `Tessera ${sess.tessera}`;
  // Se l'admin è aperto, NON devo buttarti fuori ogni volta che aggiorno dati
  // (punti, liste, impostazioni, ecc.). Resto in admin finché non premi "Chiudi".
  if (isAdminViewOpen()) {
    show('viewAdmin');
    // Se ho già fatto login admin in questa sessione, tengo aperto il pannello.
    if (getAdminSession()) {
      $('adminLocked').hidden = true;
      $('adminPanel').hidden = false;
    }
    // Se sei già loggato come admin, aggiorno i contenuti; altrimenti lascio il lock.
    if (!$('adminPanel').hidden) renderAdmin();
    return;
  }

  show('viewHome');
  renderHome();
}

function login() {
  const tessera = normalizeTessera($('loginTessera').value);
  if (!tessera) { toast('Inserisci il numero tessera'); return; }

  const members = getMembers();
  const idx = members.findIndex(m => normalizeTessera(m.tessera) === tessera);
  if (idx === -1) {
    toast('Tessera non abilitata. Contatta il Club.');
    return;
  }

  // Il nome viene preso automaticamente dall'elenco soci (import/allowed list)
  const current = members[idx] || {};
  const name = normalizeName(current.name || 'Socio');
  setSession({ tessera, name });
  $('loginTessera').value = '';
  render();
  toast('Accesso effettuato');
}

function logout() {
  clearSession();
  render();
}

function openAdmin() {
  show('viewAdmin');
  // Se ho già fatto login admin in questa sessione, non richiedere di nuovo il PIN.
  if (getAdminSession()) {
    $('adminLocked').hidden = true;
    $('adminPanel').hidden = false;
    renderAdmin();
    return;
  }
  $('adminLocked').hidden = false;
  $('adminPanel').hidden = true;
  $('adminPin').value = '';
}

function closeAdmin() {
  render();
}

function isAdminViewOpen() {
  const v = document.getElementById('viewAdmin');
  return v && !v.hidden;
}

function adminLogin() {
  const pin = String($('adminPin').value || '').trim();
  const ADMIN_PIN = '190894';
  if (pin !== ADMIN_PIN) { toast('PIN errato'); return; }

  // Salva il PIN in locale così le operazioni admin (sync/eliminazioni) possono scrivere su Supabase
  try { save(LS.admin, { pin }); } catch {}

  setAdminSession(true);
  $('adminLocked').hidden = true;
  $('adminPanel').hidden = false;
  renderAdmin();
  toast('Admin OK');
}

function saveSettings() {
  const label = String($('ticketLabel').value || '').trim() || 'Biglietti Inter';
  const url = String($('ticketLink').value || '').trim() || 'https://www.inter.it/it/biglietteria';
  setTicketCfg({ label, url });

  toast('Impostazioni salvate');
  schedulePushAppData();
  // Se sono nell'area admin, non devo "uscire" dall'admin.
  if (!isAdminViewOpen()) render();
  if (!$('adminPanel').hidden) renderAdmin();
}

function parseAllowedList(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const seen = new Set();

  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;

    const parts = raw.split(',');
    const tessera = normalizeTessera(parts[0]);
    if (!tessera) continue;
    if (seen.has(tessera)) continue;
    seen.add(tessera);

    const name = parts.slice(1).join(',').trim();
    out.push({ tessera, name: name ? normalizeName(name) : '' });
  }
  return out;
}

function upsertMember(tessera, fullName) {
  const t = normalizeTessera(tessera);
  if (!t) return false;
  const name = normalizeName(fullName);
  const members = getMembers();
  const idx = members.findIndex(m => normalizeTessera(m.tessera) === t);
  if (idx === -1) members.push({ tessera: t, name });
  else members[idx] = { ...members[idx], tessera: t, name: name || members[idx].name || '' };
  setMembers(members);
  return true;
}

function addMemberFromForm() {
  const t = normalizeTessera($('addTessera')?.value);
  const nome = normalizeName($('addNome')?.value);
  const cognome = normalizeName($('addCognome')?.value);
  if (!t) { toast('Inserisci numero tessera'); return; }
  if (!nome || !cognome) { toast('Inserisci nome e cognome'); return; }
  upsertMember(t, `${nome} ${cognome}`);
  if ($('addTessera')) $('addTessera').value = '';
  if ($('addNome')) $('addNome').value = '';
  if ($('addCognome')) $('addCognome').value = '';
  // aggiorna textarea e preview
  renderAdmin();
  toast('Tessera aggiunta');
}

// CSV import (da Excel: File -> Salva con nome -> CSV)
function parseCsv(text) {
  const rows = [];
  let cur = '';
  let inQ = false;
  const pushCell = (row) => { row.push(cur); cur = ''; };
  let row = [];

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQ && text[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
      continue;
    }
    if (!inQ && (c === '\n' || c === '\r')) {
      // end row (handle CRLF)
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushCell(row);
      if (row.some(x => String(x || '').trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    if (!inQ && (c === ',' || c === ';' || c === '\t')) {
      // delimiter will be normalized later; keep as raw token separator by marking it
      // We'll do a second pass with detected delimiter if needed.
    }
    cur += c;
  }
  // last
  pushCell(row);
  if (row.some(x => String(x || '').trim() !== '')) rows.push(row);
  return rows;
}

function detectDelimiter(firstLine) {
  const s = String(firstLine || '');
  const counts = {
    ',': (s.match(/,/g) || []).length,
    ';': (s.match(/;/g) || []).length,
    '\t': (s.match(/\t/g) || []).length,
  };
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ',';
}

function splitCsvLines(text, delim) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const row = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
        continue;
      }
      if (!inQ && c === delim) {
        row.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    row.push(cur);
    out.push(row);
  }
  return out;
}

function normHeader(h) {
  return normalizeName(String(h || '').toLowerCase())
    .replace(/[àáâä]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôö]/g, 'o')
    .replace(/[ùúûü]/g, 'u');
}

function importMembersFromCsvText(text, mode) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) { toast('CSV vuoto'); return; }
  const delim = detectDelimiter(lines[0]);
  const rows = splitCsvLines(text, delim);
  if (!rows.length) { toast('CSV non valido'); return; }

  const headers = rows[0].map(normHeader);
  const findCol = (preds) => {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (preds.some(p => h.includes(p))) return i;
    }
    return -1;
  };

  const colT = findCol(['numero tessera', 'tessera', 'n tessera', 'nr tessera']);
  const colNome = findCol(['nome']);
  const colCognome = findCol(['cognome']);
  const colFull = findCol(['nome e cognome', 'nominativo']);
  const colAtt = findCol(['attivo', 'attiva']);

  const imported = [];
  const seen = new Set();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const tessera = normalizeTessera(row[colT]);
    if (!tessera) continue;
    if (seen.has(tessera)) continue;
    seen.add(tessera);

    const attRaw = colAtt >= 0 ? String(row[colAtt] ?? '').trim().toLowerCase() : '';
    const isActive = colAtt < 0 ? true : ['si', 's', '1', 'true', 'yes', 'y'].includes(attRaw);
    if (!isActive) continue;

    let full = '';
    if (colFull >= 0) full = normalizeName(row[colFull]);
    else {
      const n = normalizeName(row[colNome]);
      const c = normalizeName(row[colCognome]);
      full = normalizeName(`${n} ${c}`);
    }
    imported.push({ tessera, name: full });
  }

  if (!imported.length) { toast('Nessun socio importato'); return; }

  let members = getMembers();
  if (mode === 'replace') members = [];

  const map = new Map(members.map(m => [normalizeTessera(m.tessera), m]));
  imported.forEach(m => {
    const t = normalizeTessera(m.tessera);
    if (!t) return;
    map.set(t, { tessera: t, name: normalizeName(m.name) });
  });
  const out = Array.from(map.values());
  setMembers(out);
  toast(`Importati ${imported.length} soci`);
  renderAdmin();
}

function saveAllowed() {
  const members = parseAllowedList($('allowedList').value);
  setMembers(members);
  toast('Tessere salvate');
  schedulePushAppData();
  renderAdmin();
}

function exportData() {
  const data = {
    exportedAt: new Date().toISOString(),
    members: getMembers(),
    points: getPoints(),
    events: getEvents(),
    bookings: getBookings(),
    quiz: getQuiz(),
    quizAnswers: getQuizAnswers(),
    ticketCfg: getTicketCfg(),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'inter-club-sulmona-dati.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function createEvent() {
  const title = String($('eventAdminTitle').value || '').trim() || 'Evento Inter Club';
  const date = String($('eventAdminDate').value || '').trim();
  const capacity = Number(String($('eventAdminCapacity').value || '').trim() || '0');
  const note = String($('eventAdminNote').value || '').trim();

  const id = `EV-${Date.now()}`;
  const events = getEvents();
  events.unshift({ id, title, date, capacity, note, createdAt: Date.now() });
  setEvents(events);
  schedulePushAppData();

  // aggiorna selezioni
  $('eventAdminTitle').value = '';
  $('eventAdminDate').value = '';
  $('eventAdminCapacity').value = '';
  $('eventAdminNote').value = '';

  toast('Evento creato');
  renderAdmin();
  if (!isAdminViewOpen()) render();
}

async function deleteSelectedEvent() {
  const sel = $('eventAdminSelect');
  let id = sel ? String(sel.value || '') : '';

  // Fallback: se per qualsiasi motivo la select è vuota, prendo il primo evento disponibile
  if (!id) {
    const evs = getEvents();
    id = evs && evs.length ? String(evs[0].id || '') : '';
  }
  if (!id) { toast('Nessun evento selezionato'); return; }

  // Conferma (evita tocchi accidentali)
  const ev = getEventById(id);
  const label = ev ? `${ev.title || 'Evento'}${ev.date ? ' • ' + ev.date : ''}` : id;
  if (!confirm(`Eliminare definitivamente l'evento?

${label}

Verranno rimossi anche i dati di prenotazione collegati.`)) return;

  // 1) Aggiorna cache condivisa (eventi)
  const events = getEvents().filter(e => e && e.id !== id);
  setEvents(events);

  // 2) Rimuovi prenotazioni collegate
  const bookings = getBookings();
  if (bookings && bookings[id]) {
    delete bookings[id];
    setBookings(bookings);
  }

  // 3) Se in futuro colleghiamo un quiz ad un evento, pulisco anche quello
  try {
    const q = getQuiz();
    if (q && (q.eventId === id || q.event_id === id)) {
      clearQuiz();
    }
  } catch {}

  // 4) Push immediato su Supabase + refresh per evitare che “ricompaia”
  try {
    if (isOnline()) {
      await pushAppDataNow();
      await refreshAppData();
      toast('Evento eliminato (aggiornato per tutti)');
    } else {
      // Offline: salvo in locale e verrà sincronizzato appena online
      schedulePushAppData();
      toast('Evento eliminato (salvato in locale)');
    }
  } catch (e) {
    console.warn('deleteSelectedEvent push error', e);
    // Mantengo l'eliminazione locale, ma avviso che online potrebbe riprendere finché non si sincronizza.
    toast('Eliminato in locale. Online appena possibile.');
  }

  // UI
  renderAdmin();
  if (!isAdminViewOpen()) render();
}

async function bookEvent(eventId) {
  const sess = getSession();
  if (!sess?.tessera) return;

  const ev = getEventById(eventId);
  if (!ev) { toast('Evento non disponibile'); return; }

  const t = normalizeTessera(sess.tessera);

  // Aggiorna subito in locale (UI veloce)
  const bookings = getBookings();
  bookings[ev.id] = bookings[ev.id] || {};
  if (bookings[ev.id][t]) { toast('Hai già prenotato'); return; }

  const used = Object.values(bookings[ev.id]).reduce((s, b) => s + (Number(b?.seats) || 0), 0);
  const cap = Number(ev.capacity) || 0;
  if (cap && used >= cap) { toast('Posti esauriti'); return; }

  bookings[ev.id][t] = { seats: 1, at: Date.now() };
  setBookings(bookings);
  addPoints(t, 10);
  toast('Prenotazione confermata (+10 punti)');
  render();

  // Sync per tutti
  try {
    await mutateShared({ type: 'book', tessera: t, eventId: ev.id, seats: 1 });
    await refreshAppData();
    render();
  } catch (e) {
    console.warn(e);
    toast('Salvato in locale. Online appena possibile.');
  }
}

async function cancelEvent(eventId) {
  const sess = getSession();
  if (!sess?.tessera) return;

  const ev = getEventById(eventId);
  if (!ev) { toast('Evento non disponibile'); return; }

  const t = normalizeTessera(sess.tessera);
  const bookings = getBookings();
  const evBookings = bookings[ev.id] || {};

  if (!evBookings[t]) { toast('Nessuna prenotazione'); return; }

  delete evBookings[t];
  bookings[ev.id] = evBookings;
  setBookings(bookings);
  addPoints(t, -10);
  toast('Prenotazione annullata (-10 punti)');
  render();

  try {
    await mutateShared({ type: 'cancel', tessera: t, eventId: ev.id });
    await refreshAppData();
    render();
  } catch (e) {
    console.warn(e);
    toast('Salvato in locale. Online appena possibile.');
  }
}

function publishQuiz() {
  const q = String($('quizQ').value || '').trim();
  const a = String($('quizA').value || '').trim();
  const b = String($('quizB').value || '').trim();
  const c = String($('quizC').value || '').trim();
  const d = String($('quizD').value || '').trim();
  const correct = String($('quizCorrect').value || '').trim().toUpperCase();

  if (!q || !a || !b || !c || !d || !['A', 'B', 'C', 'D'].includes(correct)) {
    toast('Compila domanda, 4 opzioni e risposta corretta (A/B/C/D)');
    return;
  }

  const id = `QZ-${Date.now()}`;
  setQuiz({ id, q, opts: [a, b, c, d], correct });
  toast('Nuovo quiz pubblicato');
  schedulePushAppData();
  renderAdmin();
  if (!isAdminViewOpen()) render();
}

function clearQuizAdmin() {
  clearQuiz();
  toast('Quiz rimosso');
  schedulePushAppData();
  renderAdmin();
  if (!isAdminViewOpen()) render();
}

function selectQuiz(letter) {
  // evidenzia scelta
  const wrap = $('quizOptions');
  [...wrap.querySelectorAll('button')].forEach(btn => {
    btn.classList.toggle('selected', btn.textContent.startsWith(letter + ')'));
  });
  $('btnSubmitQuiz').disabled = false;
  $('btnSubmitQuiz').dataset.choice = letter;
}

async function submitQuiz() {
  const sess = getSession();
  if (!sess?.tessera) return;

  const quiz = getQuiz();
  if (!quiz) { toast('Quiz non disponibile'); return; }

  const choice = String($('btnSubmitQuiz').dataset.choice || '').toUpperCase();
  if (!['A', 'B', 'C', 'D'].includes(choice)) { toast('Seleziona una risposta'); return; }

  const key = `${normalizeTessera(sess.tessera)}::${quiz.id}`;
  const answers = getQuizAnswers();
  if (answers[key]) { toast('Hai già risposto'); return; }

  const correct = quiz.correct === choice;
  answers[key] = { letter: choice, correct, at: Date.now() };
  setQuizAnswers(answers);

  if (correct) addPoints(sess.tessera, 2);
  toast(correct ? 'Corretto! +2 punti' : 'Sbagliato');
  render();

  try {
    await mutateShared({ type: 'quizAnswer', tessera: normalizeTessera(sess.tessera), quizId: quiz.id, letter: choice });
    await refreshAppData();
    render();
  } catch (e) {
    console.warn(e);
    // ok: resta in locale
  }
}

async function refresh() {
  // Aggiorna i dati condivisi (quiz/eventi/bacheca) + UI
  await syncSharedFromNetwork({ silent: true });
  if (!isAdminViewOpen()) render();
  if (!$('adminPanel').hidden) renderAdmin();
  toast('Aggiornato');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// --- Service worker
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');

    // prova ad aggiornare subito (utile dopo deploy)
    try { await reg.update(); } catch {}

    // se arriva una nuova versione, forza l'attivazione e ricarica
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed') {
          // se c'è già un SW attivo, significa update
          if (navigator.serviceWorker.controller) {
            try { nw.postMessage({ type: 'SKIP_WAITING' }); } catch {}
            // ricarica dopo poco per prendere i nuovi file
            setTimeout(() => location.reload(), 400);
          }
        }
      });
    });

    // quando il nuovo SW prende controllo, ricarica
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      setTimeout(() => location.reload(), 200);
    });
  } catch {}
}


function wire() {
  $('btnLogin').addEventListener('click', login);

  // Admin nascosto: 7 tap su 'Inter Club Sulmona' (titolo in alto)
  (function setupSecretAdmin() {
    const target = document.getElementById('appTitle') || document.getElementById('brandTap');
    if (!target) return;

    let taps = 0;
    let timer = null;

    target.addEventListener('click', () => {
      taps += 1;
      if (taps === 1) {
        timer = setTimeout(() => { taps = 0; }, 3000);
      }
      if (taps >= 7) {
        if (timer) clearTimeout(timer);
        taps = 0;
        openAdmin();
      }
    });
  })();
  $('loginTessera').addEventListener('input', sanitizeTesseraInput);
  $('loginTessera').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  // Login solo con tessera: nome e cognome vengono recuperati automaticamente.

  $('btnLogout').addEventListener('click', logout);

  $('btnTicket').addEventListener('click', () => {
    const tc = getTicketCfg();
    window.open(tc.url || 'https://www.inter.it/it/biglietteria', '_blank', 'noopener');
  });

  $('btnRefresh').addEventListener('click', refresh);

  $('btnSubmitQuiz').addEventListener('click', submitQuiz);

  $('btnCloseAdmin').addEventListener('click', closeAdmin);
  $('btnAdminLogin').addEventListener('click', adminLogin);

  $('btnSaveSettings').addEventListener('click', saveSettings);
  const btnPR = $('btnSavePointsRules');
  if (btnPR) btnPR.addEventListener('click', savePointsRules);
  const btnB = $('btnSaveBulletin');
  if (btnB) btnB.addEventListener('click', saveBulletinAdmin);
  $('btnSaveAllowed').addEventListener('click', saveAllowed);
  $('btnExport').addEventListener('click', exportData);

  const btnResetAll = $('btnResetAllPoints');
  if (btnResetAll) btnResetAll.addEventListener('click', resetAllPointsAdmin);

  // Ricerca nell'elenco tessere (editor rapido)
  if ($('allowedSearch')) {
    $('allowedSearch').addEventListener('input', () => {
      renderAllowedEditor(getMembers());
    });
  }

  // Gestione soci (manuale + import CSV)
  if ($('btnAddMember')) {
    $('btnAddMember').addEventListener('click', addMemberFromForm);
  }
  if ($('addCognome')) {
    $('addCognome').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMemberFromForm(); });
  }
  if ($('btnImportCsv')) {
    $('btnImportCsv').addEventListener('click', async () => {
      const inp = $('importCsv');
      const file = inp && inp.files ? inp.files[0] : null;
      if (!file) { toast('Seleziona un file CSV'); return; }
      const mode = String($('importMode')?.value || 'replace');
      try {
        const text = await file.text();
        importMembersFromCsvText(text, mode);
      } catch {
        toast('Errore lettura CSV');
      }
    });
  }

  $('btnPublishEvent').addEventListener('click', createEvent);
  $('btnClearEvent').addEventListener('click', deleteSelectedEvent);

  // refresh lista prenotazioni quando cambi evento
  const selBook = $('bookingEventSelect');
  if (selBook) selBook.addEventListener('change', renderAdmin);

  $('btnPublishQuiz').addEventListener('click', publishQuiz);
  $('btnClearQuiz').addEventListener('click', clearQuizAdmin);

  // Online badge
  const updateNet = () => {
    const el = document.getElementById('netStatus');
    if (!el) return;
    el.textContent = navigator.onLine ? 'Online' : 'Offline OK';
    el.className = 'badge ' + (navigator.onLine ? 'okBadge' : '');
  };
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();
}

bootstrapDefaults();
wire();
setupInstallButton();
registerSW();
// Prima sincronizzazione contenuti condivisi (senza disturbare l'utente)
syncSharedFromNetwork({ silent: true }).finally(() => {
  render();
});


// =============================
// LIVE SYNC (solo online)
// I soci devono vedere quiz/eventi/bacheca/punti quasi in tempo reale.
// Facciamo polling leggero (ogni 15s) + refresh immediato quando torna online.
// =============================
function startLiveSync() {
  const INTERVAL_MS = 15000; // 15s: abbastanza "tempo reale" senza stressare il server
  let timer = null;

  const tick = async () => {
    if (!isOnline()) return;
    // Se la pagina è in background, rallentiamo (riduce consumi)
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (hidden) return;
    await refreshAppData();
    render();
  };

  // Primo giro subito dopo bootstrap
  tick().catch(() => {});

  // Polling
  timer = setInterval(() => tick().catch(() => {}), INTERVAL_MS);

  // Quando torna la connessione, aggiorna SUBITO
  window.addEventListener('online', () => tick().catch(() => {}));

  // Se l'utente torna sull'app (tab riaperta), aggiorna
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick().catch(() => {});
  });

  return () => { if (timer) clearInterval(timer); };
}

startLiveSync();

// =============================
// PWA Install button helper
// Shows "Scarica App" when not installed.
// - Android/Chrome: opens install prompt
// - iOS/Safari: shows instructions
// =============================
function setupInstallButton() {
  const installBtn = document.getElementById('installBtn');
  if (!installBtn) return;

  let deferredPrompt = null;

  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = () =>
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (typeof navigator.standalone !== 'undefined' && navigator.standalone);

  const show = () => (installBtn.hidden = false);
  const hide = () => (installBtn.hidden = true);

  const updateVisibility = () => {
    // Se l'app è già installata, nascondi sempre il bottone.
    if (isStandalone()) { hide(); return; }

    // iOS: niente popup/guide bloccanti dentro l'app.
    // L'installazione si spiega fuori (grafica/bacheca), quindi qui lo nascondiamo.
    if (isIOS()) { hide(); return; }

    // Android/desktop: mostra solo quando il browser fornisce il prompt di installazione.
    if (deferredPrompt) show();
    else hide();
  };

  // Android/Chrome install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    updateVisibility();
  });

  installBtn.addEventListener('click', async () => {
    if (isStandalone()) return;
    if (!deferredPrompt) return;

    try {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
    } catch (_) {}

    deferredPrompt = null;
    updateVisibility();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    updateVisibility();
  });

  updateVisibility();
}

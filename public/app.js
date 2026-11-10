/**
 * سامانه مدیریت اتوماسیون و ارتباطات - هسته پردازش منطق، دیتابیس و ارتباط با سخت‌افزار
 * سازگار با Cloudflare Pages، PWA و کارکرد ۱۰۰٪ آفلاین (Offline-First)
 */

// نسخه رسمی و سراسری پروژه - پس از هر بار تغییرات، این نسخه تغییر می‌یابد تا برنامه‌های نصب‌شده قدیمی بروزرسانی شوند
var APP_VERSION = '3.0.0';
window.APP_VERSION = APP_VERSION;

// ==========================================
// ۱. تبدیل تاریخ میلادی به هجری شمسی (Jalali)
// ==========================================
function gregorianToJalali(gy, gm, gd) {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = (gy <= 1600) ? 0 : 979;
  gy -= (gy <= 1600) ? 621 : 1600;
  const gy2 = (gm > 2) ? (gy + 1) : gy;
  let days = (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) - 80 + gd + g_d_m[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  jy += Math.floor((days - 1) / 365);
  if (days > 0) days = (days - 1) % 365;
  const jm = (days < 186) ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + ((days < 186) ? (days % 31) : ((days - 186) % 30));
  return { jy, jm, jd };
}

function getFormattedJalali(date = new Date()) {
  const { jy, jm, jd } = gregorianToJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const pad = (n) => String(n).padStart(2, '0');
  const daysOfWeek = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه', 'شنبه'];
  const months = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
  const dayName = daysOfWeek[date.getDay()];
  const monthName = months[jm - 1];
  const timeStr = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const dateNumStr = `${jy}/${pad(jm)}/${pad(jd)}`;
  const fullPersian = `${dayName}، ${jd} ${monthName} ${jy} - ساعت ${timeStr.slice(0, 5)}`;
  return { jy, jm, jd, dateNumStr, timeStr, fullPersian };
}

// تابع امن سراسری escapeHtml جهت جلوگیری از حملات XSS و خطاهای ReferenceError
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
window.escapeHtml = escapeHtml;

// ==========================================
// ۲. مدیریت دیتابیس محلی (IndexedDB)
// ==========================================
var DB_NAME = 'AutomationGraphDB';
var DB_VERSION = 7;

function openDB() {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      try {
        request = indexedDB.open(DB_NAME);
      } catch (err) {
        return reject(err);
      }
    }

    request.onerror = () => {
      // اگر نسخه درخواستی کمتر از دیتابیس موجود باشد (خطای VersionError)، بدون تعیین نسخه باز می‌کنیم
      if (request.error && (request.error.name === 'VersionError' || (request.error.message && request.error.message.includes('less than')))) {
        console.warn('Recovering from VersionError: opening existing DB without version constrain');
        try {
          const fallbackReq = indexedDB.open(DB_NAME);
          fallbackReq.onsuccess = () => resolve(fallbackReq.result);
          fallbackReq.onerror = () => reject(fallbackReq.error);
          return;
        } catch (fbErr) {
          return reject(fbErr);
        }
      }
      reject(request.error);
    };

    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (e) => {
      const db = request.result;
      if (!db.objectStoreNames.contains('graphs')) {
        const store = db.createObjectStore('graphs', { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('syncStatus', 'syncStatus', { unique: false });
        store.createIndex('unit', 'operator.unit', { unique: false });
        store.createIndex('activityType', 'activityType', { unique: false });
      }
      if (!db.objectStoreNames.contains('admins')) {
        const adminStore = db.createObjectStore('admins', { keyPath: 'username' });
        adminStore.createIndex('username', 'username', { unique: true });
      }
      if (!db.objectStoreNames.contains('personnel')) {
        const pStore = db.createObjectStore('personnel', { keyPath: 'code' });
        pStore.createIndex('name', 'name', { unique: false });
      }
      if (!db.objectStoreNames.contains('asset_rebuildables')) {
        const arStore = db.createObjectStore('asset_rebuildables', { keyPath: 'id', autoIncrement: true });
        arStore.createIndex('asset', 'asset', { unique: false });
        arStore.createIndex('supervision', 'supervision', { unique: false });
        arStore.createIndex('unit', 'unit', { unique: false });
      }
    };
  });
}

async function saveGraphRecord(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('graphs', 'readwrite');
      const store = tx.objectStore('graphs');
      const cleanRecord = JSON.parse(JSON.stringify(record));
      if (cleanRecord.id === undefined || cleanRecord.id === null) {
        delete cleanRecord.id;
      }
      const req = store.add(cleanRecord);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}

async function getAllGraphRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('graphs', 'readonly');
    const store = tx.objectStore('graphs');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function deleteGraphRecord(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('graphs', 'readwrite');
    const store = tx.objectStore('graphs');
    const req = store.delete(Number(id));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function updateGraphRecord(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('graphs', 'readwrite');
    const store = tx.objectStore('graphs');
    const req = store.put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAdminsList() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('admins', 'readonly');
    const store = tx.objectStore('admins');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function saveAdminUser(admin) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('admins', 'readwrite');
    const store = tx.objectStore('admins');
    const req = store.put(admin);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteAdminUser(username) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('admins', 'readwrite');
    const store = tx.objectStore('admins');
    const req = store.delete(username);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// عملیات بانک اطلاعات پرسنل در دیتابیس محلی IndexedDB
async function getAllPersonnelFromDB() {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains('personnel')) return [];
    return new Promise((resolve) => {
      const tx = db.transaction('personnel', 'readonly');
      const store = tx.objectStore('personnel');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    console.warn('getAllPersonnelFromDB error:', e);
    return [];
  }
}

async function savePersonnelRecordToDB(p) {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains('personnel')) return;
    return new Promise((resolve) => {
      const tx = db.transaction('personnel', 'readwrite');
      const store = tx.objectStore('personnel');
      const req = store.put(p);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    console.warn('savePersonnelRecordToDB error:', e);
  }
}

async function saveMultiplePersonnelToDB(list) {
  if (!list || !list.length) return;
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains('personnel')) return;
    return new Promise((resolve) => {
      const tx = db.transaction('personnel', 'readwrite');
      const store = tx.objectStore('personnel');
      for (let i = 0; i < list.length; i++) {
        store.put(list[i]);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (e) {
    console.warn('saveMultiplePersonnelToDB error:', e);
  }
}

async function deletePersonnelFromDB(code) {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains('personnel')) return;
    return new Promise((resolve) => {
      const tx = db.transaction('personnel', 'readwrite');
      const store = tx.objectStore('personnel');
      const req = store.delete(String(code));
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch (e) {
    console.warn('deletePersonnelFromDB error:', e);
  }
}

async function clearPersonnelDB() {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains('personnel')) return;
    return new Promise((resolve) => {
      const tx = db.transaction('personnel', 'readwrite');
      const store = tx.objectStore('personnel');
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch (e) {
    console.warn('clearPersonnelDB error:', e);
  }
}

// عملیات بانک اطلاعات تجهیزات و قطعات بازسازی (Asset & Rebuildable)
async function getAllAssetRebuildableRecordsFromDB() {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains('asset_rebuildables')) {
      return JSON.parse(localStorage.getItem('automation_asset_rebuildables') || '[]');
    }
    return new Promise((resolve) => {
      const tx = db.transaction('asset_rebuildables', 'readonly');
      const store = tx.objectStore('asset_rebuildables');
      const req = store.getAll();
      req.onsuccess = () => {
        const list = req.result || [];
        localStorage.setItem('automation_asset_rebuildables', JSON.stringify(list));
        resolve(list);
      };
      req.onerror = () => {
        const fallback = JSON.parse(localStorage.getItem('automation_asset_rebuildables') || '[]');
        resolve(fallback);
      };
    });
  } catch (e) {
    console.warn('getAllAssetRebuildableRecordsFromDB error:', e);
    return JSON.parse(localStorage.getItem('automation_asset_rebuildables') || '[]');
  }
}

async function saveAssetRebuildableRecordToDB(record) {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains('asset_rebuildables')) {
      const list = JSON.parse(localStorage.getItem('automation_asset_rebuildables') || '[]');
      if (!record.id) record.id = Date.now() + Math.floor(Math.random() * 1000);
      const idx = list.findIndex(r => r.id === record.id);
      if (idx >= 0) list[idx] = record;
      else list.push(record);
      localStorage.setItem('automation_asset_rebuildables', JSON.stringify(list));
      return record.id;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction('asset_rebuildables', 'readwrite');
      const store = tx.objectStore('asset_rebuildables');
      const req = store.put(record);
      req.onsuccess = () => {
        record.id = req.result;
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('saveAssetRebuildableRecordToDB error:', e);
    const list = JSON.parse(localStorage.getItem('automation_asset_rebuildables') || '[]');
    if (!record.id) record.id = Date.now() + Math.floor(Math.random() * 1000);
    const idx = list.findIndex(r => r.id === record.id);
    if (idx >= 0) list[idx] = record;
    else list.push(record);
    localStorage.setItem('automation_asset_rebuildables', JSON.stringify(list));
    return record.id;
  }
}

async function saveMultipleAssetRebuildablesToDB(records) {
  if (!records || !records.length) return;
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains('asset_rebuildables')) {
      const list = JSON.parse(localStorage.getItem('automation_asset_rebuildables') || '[]');
      records.forEach(r => {
        if (!r.id) r.id = Date.now() + Math.floor(Math.random() * 100000);
        list.push(r);
      });
      localStorage.setItem('automation_asset_rebuildables', JSON.stringify(list));
      return;
    }
    return new Promise((resolve) => {
      const tx = db.transaction('asset_rebuildables', 'readwrite');
      const store = tx.objectStore('asset_rebuildables');
      records.forEach(r => {
        if (!r.id) delete r.id; // اجازه تولید خودکار id در صورت وجود autoIncrement
        store.put(r);
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (e) {
    console.warn('saveMultipleAssetRebuildablesToDB error:', e);
  }
}

async function deleteAssetRebuildableRecordFromDB(id) {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains('asset_rebuildables')) {
      let list = JSON.parse(localStorage.getItem('automation_asset_rebuildables') || '[]');
      list = list.filter(r => r.id !== id);
      localStorage.setItem('automation_asset_rebuildables', JSON.stringify(list));
      return;
    }
    return new Promise((resolve) => {
      const tx = db.transaction('asset_rebuildables', 'readwrite');
      const store = tx.objectStore('asset_rebuildables');
      const req = store.delete(Number(id) || id);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch (e) {
    console.warn('deleteAssetRebuildableRecordFromDB error:', e);
  }
}

// ==========================================
// ۳. وضعیت برنامه، پوسته (تم) و متغیرهای سراسری
// ==========================================
window.AppState = window.AppState || {
  currentView: 'home',
  currentUser: null,
  operator: null,
  capturedImageBase64: null,
  capturedImages: [],
  addedActivities: [],
  currentLocation: { lat: null, lng: null, accuracy: null, timestamp: null },
  colleagues: [],
  personnel: [],
  personnelMap: new Map(),
  personnelSearchQuery: '',
  personnelCurrentPage: 1,
  personnelPageSize: 50,
  assetRecords: [],
  filteredAssetRecords: [],
  assetSearchQuery: '',
  assetFilterSupervision: '',
  assetFilterUnit: '',
  deferredPrompt: null,
  selectedQrTargetField: null,
  activeCameraStream: null,
  theme: localStorage.getItem('automation_app_theme') || 'dark',
};

if (!window.AppState.addedActivities) {
    window.AppState.addedActivities = [];
}

function applyTheme(themeName) {
  const isLight = themeName === 'light';
  window.AppState.theme = themeName;
  localStorage.setItem('automation_app_theme', themeName);

  if (isLight) {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
  } else {
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
  }

  // به‌روزرسانی دکمه و متای تم
  const themeText = document.getElementById('themeToggleText');
  const sunIcon = document.getElementById('themeSunIcon');
  const moonIcon = document.getElementById('themeMoonIcon');
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');

  if (themeText) {
    themeText.textContent = isLight ? 'حالت شب' : 'حالت روز';
  }
  if (sunIcon && moonIcon) {
    if (isLight) {
      sunIcon.classList.add('hidden');
      moonIcon.classList.remove('hidden');
    } else {
      sunIcon.classList.remove('hidden');
      moonIcon.classList.add('hidden');
    }
  }
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', isLight ? '#f1f5f9' : '#0f172a');
  }
}

function toggleTheme() {
  const current = window.AppState.theme || (document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  const nextTheme = current === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  if (typeof showToast === 'function') {
    showToast(`حالت ${nextTheme === 'light' ? 'روز (روشن)' : 'شب (تاریک)'} فعال شد`, 'info');
  }
}

function initThemeUI() {
  const currentTheme = localStorage.getItem('automation_app_theme') || 'dark';
  applyTheme(currentTheme);
}

function loadOperatorProfile() {
  try {
    const stored = localStorage.getItem('automation_operator_profile');
    if (stored) {
      window.AppState.operator = JSON.parse(stored);
      if (window.AppState.operator && window.AppState.operator.personnelId) {
        const match = findPersonnelByCode(window.AppState.operator.personnelId);
        if (match) {
          let changed = false;
          if (!window.AppState.operator.firstName || !window.AppState.operator.lastName) {
            window.AppState.operator.firstName = match.firstName || '';
            window.AppState.operator.lastName = match.lastName || '';
            changed = true;
          }
          if (changed) {
            localStorage.setItem('automation_operator_profile', JSON.stringify(window.AppState.operator));
          }
        }
      }
    }
  } catch (e) {
    console.error('Error loading operator profile', e);
  }
  updateOperatorSummaryUI();
}

let _operatorAutoSaveTimer = null;
let _pendingOperatorData = null;

function toggleOperatorAccordion(forceState) {
  const acc = document.getElementById('operatorDetailsAccordion');
  const icon = document.getElementById('operatorAccordionIcon');
  const btnText = document.getElementById('operatorAccordionBtnText');
  if (!acc) return;

  const isCurrentlyOpen = !acc.classList.contains('hidden');
  const shouldOpen = forceState !== undefined ? forceState : !isCurrentlyOpen;

  if (shouldOpen) {
    acc.classList.remove('hidden');
    if (icon) icon.style.transform = 'rotate(180deg)';
    if (btnText) btnText.textContent = 'بستن مشخصات';
  } else {
    acc.classList.add('hidden');
    if (icon) icon.style.transform = 'rotate(0deg)';
    if (btnText) btnText.textContent = 'مشاهده مشخصات';
  }
}
window.toggleOperatorAccordion = toggleOperatorAccordion;

function renderOperatorFields(op) {
  if (!op) return;
  const fullName = op.name || `${op.firstName || ''} ${op.lastName || ''}`.trim() || '---';
  const pid = op.personnelId || op.code || '---';
  const nid = op.nationalId || '---';
  const mobile = op.mobile ? ('0' + String(op.mobile).replace(/^0+/, '')) : '---';
  const management = op.management || 'مدیریت اتوماسیون و ارتباطات';
  const supervision = op.supervision || '---';
  const unit = op.unit || op.serviceUnit || '---';
  const role = op.role || op.jobTitle || '---';

  const headerShortEl = document.getElementById('dispHeaderShortInfo');
  if (headerShortEl) {
    headerShortEl.textContent = `${fullName} (${pid})`;
  }

  const fnEl = document.getElementById('dispFullName');
  if (fnEl) fnEl.textContent = fullName;
  const pidEl = document.getElementById('dispPersonnelId');
  if (pidEl) pidEl.textContent = pid;
  const nidEl = document.getElementById('dispNationalId');
  if (nidEl) nidEl.textContent = nid;
  const mobEl = document.getElementById('dispMobile');
  if (mobEl) mobEl.textContent = mobile;
  const mgmtEl = document.getElementById('dispManagement');
  if (mgmtEl) mgmtEl.textContent = management;
  const supEl = document.getElementById('dispSupervision');
  if (supEl) supEl.textContent = supervision;
  const unitEl = document.getElementById('dispUnit');
  if (unitEl) unitEl.textContent = unit;
  const roleEl = document.getElementById('dispRole');
  if (roleEl) roleEl.textContent = role;

  // سازگاری با المان‌های قدیمی
  const opFn = document.getElementById('opFullName');
  if (opFn) opFn.textContent = fullName;
  const opPid = document.getElementById('opPersonnelId');
  if (opPid) opPid.textContent = pid;
  const opUnitEl = document.getElementById('opUnit');
  if (opUnitEl) opUnitEl.textContent = unit;
  const opSupEl = document.getElementById('opSupervision');
  if (opSupEl) opSupEl.textContent = supervision;
  const opRoleEl = document.getElementById('opRole');
  if (opRoleEl) opRoleEl.textContent = role;
}
window.renderOperatorFields = renderOperatorFields;

function updateOperatorSummaryUI() {
  const container = document.getElementById('operatorSummaryContainer');
  const alertBox = document.getElementById('operatorMissingAlert');
  const noticeBox = document.getElementById('operatorAutoSaveNotice');
  const commitNowBtn = document.getElementById('commitNowBtn');
  const statusBadge = document.getElementById('operatorStatusBadge');
  const op = window.AppState.operator;

  if (op && (op.firstName || op.name) && op.personnelId) {
    if (alertBox) alertBox.classList.add('hidden');
    if (container) container.classList.remove('hidden');
    if (noticeBox) noticeBox.classList.add('hidden');
    if (commitNowBtn) commitNowBtn.classList.add('hidden');
    if (statusBadge) {
      statusBadge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
      statusBadge.textContent = '✓ ثبت‌شده در سیستم';
    }
    renderOperatorFields(op);
    // وقتی مشخصات از قبل ذخیره شده باشد، به صورت پیش‌فرض در حالت کشوئی جمع‌شده قرار می‌گیرد
    toggleOperatorAccordion(false);
  } else {
    if (alertBox) alertBox.classList.remove('hidden');
    if (container) container.classList.add('hidden');
  }
}

function commitOperatorNow() {
  if (_operatorAutoSaveTimer) {
    clearInterval(_operatorAutoSaveTimer);
    _operatorAutoSaveTimer = null;
  }

  const profile = _pendingOperatorData || window.AppState.operator;
  if (!profile) return;

  localStorage.setItem('automation_operator_profile', JSON.stringify(profile));
  window.AppState.operator = profile;

  const noticeBox = document.getElementById('operatorAutoSaveNotice');
  const commitNowBtn = document.getElementById('commitNowBtn');
  const statusBadge = document.getElementById('operatorStatusBadge');

  if (noticeBox) noticeBox.classList.add('hidden');
  if (commitNowBtn) commitNowBtn.classList.add('hidden');
  if (statusBadge) {
    statusBadge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    statusBadge.textContent = '✓ ثبت‌شده در سیستم';
  }

  renderOperatorFields(profile);
  populateAsettDatalist();

  const currentAsett = document.getElementById('asettInput')?.value.trim();
  if (currentAsett && typeof syncRebuildablesForAsett === 'function') {
    syncRebuildablesForAsett(currentAsett);
  }

  // پس از ذخیره خودکار، جزئیات مشخصات مجری به صورت کشوئی مخفی می‌شود
  toggleOperatorAccordion(false);

  showToast(`✓ مشخصات مجری (${profile.name || profile.firstName}) ذخیره شد و بخش مشخصات کشوئی جمع گردید.`, 'success');
}
window.commitOperatorNow = commitOperatorNow;

function applyMatchedPersonnelToHome(match) {
  _pendingOperatorData = {
    firstName: match.firstName || '',
    lastName: match.lastName || '',
    name: match.name || `${match.firstName || ''} ${match.lastName || ''}`.trim(),
    personnelId: toEnglishDigits(String(match.code || '')).replace(/\D/g, ''),
    nationalId: toEnglishDigits(String(match.nationalId || '')).replace(/\D/g, ''),
    management: match.management || 'مدیریت اتوماسیون و ارتباطات',
    supervision: match.supervision || '',
    unit: match.serviceUnit || '',
    serviceUnit: match.serviceUnit || '',
    role: match.jobTitle || '',
    jobTitle: match.jobTitle || '',
    mobile: match.mobile ? ('0' + String(match.mobile).replace(/^0+/, '')) : ''
  };

  // اسکرول نرم به سمت کارت مجری در صفحه اصلی
  const mainCard = document.getElementById('operatorMainCard');
  if (mainCard) {
    mainCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    mainCard.classList.add('ring-2', 'ring-amber-400');
    setTimeout(() => mainCard.classList.remove('ring-2', 'ring-amber-400'), 2500);
  }

  // نمایش مشخصات در صفحه اصلی و باز کردن کشو در طول ۱۰ ثانیه بررسی
  renderOperatorFields(_pendingOperatorData);
  toggleOperatorAccordion(true);

  const alertBox = document.getElementById('operatorMissingAlert');
  const container = document.getElementById('operatorSummaryContainer');
  if (alertBox) alertBox.classList.add('hidden');
  if (container) container.classList.remove('hidden');

  // نمایش پیام شمارش معکوس ۱۰ ثانیه‌ای جهت ذخیره خودکار
  const noticeBox = document.getElementById('operatorAutoSaveNotice');
  const countdownText = document.getElementById('operatorAutoSaveCountdownText');
  const countdownNumber = document.getElementById('operatorCountdownNumber');
  const commitNowBtn = document.getElementById('commitNowBtn');
  const statusBadge = document.getElementById('operatorStatusBadge');

  if (noticeBox) noticeBox.classList.remove('hidden');
  if (commitNowBtn) commitNowBtn.classList.remove('hidden');
  if (statusBadge) {
    statusBadge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30';
    statusBadge.textContent = 'در حال ذخیره خودکار...';
  }

  let timeLeft = 10;
  if (countdownNumber) countdownNumber.textContent = `${timeLeft}s`;
  if (countdownText) countdownText.textContent = `مشخصات با دیتابیس تطابق دارد. ذخیره خودکار در سیستم تا ۱۰ ثانیه دیگر...`;

  if (_operatorAutoSaveTimer) clearInterval(_operatorAutoSaveTimer);

  _operatorAutoSaveTimer = setInterval(() => {
    timeLeft--;
    if (countdownNumber) countdownNumber.textContent = `${timeLeft}s`;
    if (countdownText) countdownText.textContent = `مشخصات با دیتابیس تطابق دارد. ذخیره خودکار در سیستم تا ${timeLeft} ثانیه دیگر...`;

    if (timeLeft <= 0) {
      clearInterval(_operatorAutoSaveTimer);
      _operatorAutoSaveTimer = null;
      commitOperatorNow();
    }
  }, 1000);

  showToast(`مشخصات (${_pendingOperatorData.name}) در صفحه اصلی بارگذاری شد. ذخیره خودکار تا ۱۰ ثانیه دیگر...`, 'info');
}
window.applyMatchedPersonnelToHome = applyMatchedPersonnelToHome;



// ==========================================
// ۴. منطق فیلدهای شرطی نوار کشویی (Select) و افزودن فعالیت (دکمه ADD)
// ==========================================
function handleActivityChange() {
  const select = document.getElementById('activityTypeSelect');
  const val = select ? select.value : '';

  const equipIdGroup = document.getElementById('equipIdGroup');
  const settingsGroup = document.getElementById('settingsGroup');
  const footageGroup = document.getElementById('footageGroup');
  const customGroup = document.getElementById('customActivityGroup');

  if (equipIdGroup) equipIdGroup.classList.add('hidden');
  if (settingsGroup) settingsGroup.classList.add('hidden');
  if (footageGroup) footageGroup.classList.add('hidden');
  if (customGroup) customGroup.classList.add('hidden');

  const equipInput = document.getElementById('equipmentIdInput');
  const deviceTag = document.getElementById('deviceTagInput');
  const refTool = document.getElementById('referenceToolInput');
  const footage = document.getElementById('footageInput');
  const customInput = document.getElementById('customActivityInput');

  if (equipInput) equipInput.required = false;
  if (deviceTag) deviceTag.required = false;
  if (refTool) refTool.required = false;
  if (footage) footage.required = false;
  if (customInput) customInput.required = false;

  if (val === 'مونتاژ تجهیزات' || val === 'دمونتاژ تجهیزات') {
    // طبق درخواست کاربر فیلد شماره شناسایی تجهیز برای این فعالیت‌ها حذف گردید
    if (equipIdGroup) equipIdGroup.classList.add('hidden');
    if (equipInput) equipInput.required = false;
  } else if (
    val === 'انجام تنظیمات confing/calib (همراه شماره مرجع)' ||
    val === 'انجام تنظیمات conf/calib' ||
    val.includes('conf') ||
    val.includes('calib') ||
    val === 'انجام تنظیمات حرفه‌ای' ||
    val === 'انجام تنظیمات و فعالیت‌های حرفه‌ای' ||
    val === 'انجام فعالیت‌های حرفه‌ای'
  ) {
    if (settingsGroup) {
      settingsGroup.classList.remove('hidden');
      if (refTool) refTool.required = true;
    }
  } else if (val === 'انجام کابل‌کشی' || val === 'انجام کاندوئیت‌کاری') {
    if (footageGroup) {
      footageGroup.classList.remove('hidden');
      if (footage) footage.required = true;
    }
  } else if (val === 'سایر فعالیت‌ها') {
    if (customGroup) {
      customGroup.classList.remove('hidden');
      if (customInput) {
        customInput.required = true;
        customInput.focus();
      }
    }
  }
}

function addSelectedActivity() {
  // ۱. اعتبارسنجی قطعی: بدون تعیین قطعه قابل بازسازی (Rebuildable ID) نباید بتوان فعالیت اضافه کرد (حالت دستی حذف شد)
  const rebuildableVal = getSelectedRebuildableValue();
  if (!rebuildableVal) {
    showToast('⚠️ لطفاً ابتدا قطعه قابل بازسازی (Rebuildable ID) را از لیست کشویی دیتابیس انتخاب فرمایید.', 'error');
    const sel = document.getElementById('rebuildableSelect');
    if (sel && !sel.disabled) {
      sel.focus();
      sel.classList.add('ring-2', 'ring-rose-500', 'border-rose-500');
      setTimeout(() => sel.classList.remove('ring-2', 'ring-rose-500', 'border-rose-500'), 2500);
    } else {
      const asettInp = document.getElementById('asettInput');
      if (asettInp) {
        asettInp.focus();
        asettInp.classList.add('ring-2', 'ring-rose-500', 'border-rose-500');
        setTimeout(() => asettInp.classList.remove('ring-2', 'ring-rose-500', 'border-rose-500'), 2500);
      }
    }
    return;
  }

  const select = document.getElementById('activityTypeSelect');
  let val = select ? select.value.trim() : '';

  if (val === 'سایر فعالیت‌ها') {
    const customInput = document.getElementById('customActivityInput');
    const customVal = customInput ? customInput.value.trim() : '';
    if (!customVal) {
      showToast('لطفاً عنوان فعالیت سفارشی را وارد نمایید', 'error');
      if (customInput) customInput.focus();
      return;
    }
    val = customVal;
  }

  if (!val) {
    showToast('لطفاً ابتدا نوع فعالیت را از لیست انتخاب فرمایید', 'warning');
    if (select) select.focus();
    return;
  }

  const conditionalFields = {};

  if (val === 'مونتاژ تجهیزات' || val === 'دمونتاژ تجهیزات') {
    // طبق درخواست کاربر فیلد شماره شناسایی تجهیز حذف گردید
  } else if (
    val === 'انجام تنظیمات confing/calib (همراه شماره مرجع)' ||
    val === 'انجام تنظیمات conf/calib' ||
    val.includes('conf') ||
    val.includes('calib') ||
    val === 'انجام تنظیمات حرفه‌ای' ||
    val === 'انجام تنظیمات و فعالیت‌های حرفه‌ای' ||
    val === 'انجام فعالیت‌های حرفه‌ای'
  ) {
    const refTool = document.getElementById('referenceToolInput')?.value.trim();
    if (!refTool) {
      showToast('لطفاً شماره مرجع (لپ‌تاپ، هارت، کالیبراتور) را وارد فرمایید', 'error');
      document.getElementById('referenceToolInput')?.focus();
      return;
    }
    conditionalFields.referenceTool = refTool;
  } else if (val === 'انجام کابل‌کشی' || val === 'انجام کاندوئیت‌کاری') {
    const footageVal = document.getElementById('footageInput')?.value.trim();
    if (!footageVal) {
      showToast('لطفاً متراژ را وارد فرمایید', 'error');
      document.getElementById('footageInput')?.focus();
      return;
    }
    conditionalFields.footage = footageVal;
  }

  if (!window.AppState.addedActivities) {
    window.AppState.addedActivities = [];
  }

  // بررسی تکراری نبودن دقیق با در نظر گرفتن نوع و قطعه بازسازی
  const isDuplicate = window.AppState.addedActivities.some(
    (a) => a.type === val && a.rebuildable === rebuildableVal && JSON.stringify(a.conditionalFields) === JSON.stringify(conditionalFields)
  );
  if (isDuplicate) {
    showToast('این فعالیت با همین مشخصات و قطعه قبلاً اضافه شده است', 'warning');
    return;
  }

  // استخراج توضیحات قطعه از ویژگی‌های گزینه انتخابی
  let rebuildableDesc = '';
  const selEl = document.getElementById('rebuildableSelect');
  if (selEl && selEl.selectedIndex >= 0) {
    rebuildableDesc = (selEl.options[selEl.selectedIndex]?.getAttribute('data-desc') || '').trim();
  }

  // دریافت زمان اختصاصی مشخص‌شده پیش از افزودن (دستی یا کرنومتر زنده)
  if (window.PendingStopwatchState && window.PendingStopwatchState.isRunning) {
    togglePendingActivityStopwatch();
  }

  let actHours = 0;
  let actMinutes = 0;
  let actSeconds = 0;
  let actTotalSec = 0;
  let actMethod = '';

  const pendingElapsedSec = Math.round((window.PendingStopwatchState?.elapsedTime || 0) / 1000);
  const manualH = parseInt(toEnglishDigits(document.getElementById('actHoursInput')?.value || ''), 10) || 0;
  const manualM = parseInt(toEnglishDigits(document.getElementById('actMinutesInput')?.value || ''), 10) || 0;
  const manualTotalSec = (manualH * 3600) + (manualM * 60);

  const mainH = parseInt(toEnglishDigits(document.getElementById('durationHoursInput')?.value || ''), 10) || 0;
  const mainM = parseInt(toEnglishDigits(document.getElementById('durationMinutesInput')?.value || ''), 10) || 0;
  const mainS = parseInt(toEnglishDigits(document.getElementById('durationSecondsInput')?.value || ''), 10) || 0;
  const mainTotalSec = (mainH * 3600) + (mainM * 60) + mainS;
  const generalSwSec = window.StopwatchState && window.StopwatchState.elapsedTime > 0 ? Math.round(window.StopwatchState.elapsedTime / 1000) : 0;

  // اولویت اول با کرنومتر پیش‌فرض، دوم ورود دستی پیش‌فرض، سوم کرنومتر عمومی، چهارم فیلد مدت زمان کل فرم
  if (pendingElapsedSec > 0) {
    actTotalSec = pendingElapsedSec;
    actHours = Math.floor(actTotalSec / 3600);
    actMinutes = Math.floor((actTotalSec % 3600) / 60);
    actSeconds = actTotalSec % 60;
    actMethod = 'کرنومتر';
  } else if (manualTotalSec > 0) {
    actTotalSec = manualTotalSec;
    actHours = manualH;
    actMinutes = manualM;
    actSeconds = 0;
    actMethod = 'دستی';
  } else if (generalSwSec > 0) {
    actTotalSec = generalSwSec;
    actHours = Math.floor(actTotalSec / 3600);
    actMinutes = Math.floor((actTotalSec % 3600) / 60);
    actSeconds = actTotalSec % 60;
    actMethod = 'کرنومتر';
  } else if (mainTotalSec > 0) {
    actTotalSec = mainTotalSec;
    actHours = mainH;
    actMinutes = mainM;
    actSeconds = mainS;
    actMethod = 'دستی';
  }

  let actFormatted = '';
  let actDigital = '';
  if (actTotalSec > 0) {
    const parts = [];
    if (actHours > 0) parts.push(`${actHours} ساعت`);
    if (actMinutes > 0) parts.push(`${actMinutes} دقیقه`);
    if (actSeconds > 0) parts.push(`${actSeconds} ثانیه`);
    actFormatted = parts.join(' و ') || (actSeconds > 0 ? `${actSeconds} ثانیه` : `${actMinutes} دقیقه`);
    actDigital = actHours > 0 
      ? `${String(actHours).padStart(2, '0')}:${String(actMinutes).padStart(2, '0')}`
      : `00:${String(actMinutes).padStart(2, '0')}`;
  }

  const activityItem = {
    id: Date.now() + Math.random().toString(36).substring(2, 6),
    type: val,
    rebuildable: rebuildableVal,
    rebuildableDesc: rebuildableDesc,
    asett: document.getElementById('asettInput')?.value.trim() || '',
    conditionalFields,
    durationHours: actHours,
    durationMinutes: actMinutes,
    durationSeconds: actSeconds,
    durationTotalSeconds: actTotalSec,
    durationFormatted: actFormatted,
    durationDigital: actDigital,
    durationMethod: actTotalSec > 0 ? actMethod : ''
  };

  window.AppState.addedActivities.push(activityItem);

  // پاکسازی ورودی‌های فیلدهای شرطی و زمان موقت فعالیت
  if (select) select.value = '';
  const customInput = document.getElementById('customActivityInput');
  if (customInput) customInput.value = '';
  const equipInput = document.getElementById('equipmentIdInput');
  if (equipInput) equipInput.value = '';
  const devTagInput = document.getElementById('deviceTagInput');
  if (devTagInput) devTagInput.value = '';
  const refToolInput = document.getElementById('referenceToolInput');
  if (refToolInput) refToolInput.value = '';
  const footageInput = document.getElementById('footageInput');
  if (footageInput) footageInput.value = '';

  resetPendingActivityStopwatch();
  switchPendingTimeTab('manual');

  // همچنین پاکسازی فیلدهای مدت زمان اصلی فرم اگر مقداری داشتند
  const mainHr = document.getElementById('durationHoursInput');
  const mainMin = document.getElementById('durationMinutesInput');
  const mainSec = document.getElementById('durationSecondsInput');
  if (mainHr) mainHr.value = '';
  if (mainMin) mainMin.value = '';
  if (mainSec) mainSec.value = '';
  if (typeof updateDurationFormattedDisplay === 'function') updateDurationFormattedDisplay();

  handleActivityChange();
  recalculateTotalActivitiesDuration();
  renderAddedActivitiesList();
  showToast(`فعالیت «${val}» برای قطعه «${rebuildableVal}» با موفقیت افزوده شد.`, 'success');
}

function removeAddedActivity(id) {
  if (!window.AppState.addedActivities) return;
  window.AppState.addedActivities = window.AppState.addedActivities.filter((a) => a.id !== id);
  recalculateTotalActivitiesDuration();
  renderAddedActivitiesList();
  showToast('فعالیت مورد نظر حذف شد', 'info');
}

function renderAddedActivitiesList() {
  const container = document.getElementById('addedActivitiesContainer');
  const countBadge = document.getElementById('activitiesCountText');
  if (!container) return;

  const activities = window.AppState.addedActivities || [];

  if (countBadge) {
    countBadge.textContent = `${activities.length} مورد`;
  }

  if (activities.length === 0) {
    container.innerHTML = `
      <div id="emptyActivitiesNotice" class="text-xs text-slate-400 py-3 px-3 text-center bg-slate-950/40 rounded-xl border border-dashed border-slate-700/80">
        فعالیتی به این گراف اضافه نشده است. پس از انتخاب اقدام از نوار بالا، دکمه <strong class="text-amber-400 font-bold">«افزودن فعالیت (ADD)»</strong> را بزنید.
      </div>
    `;
    const banner = document.getElementById('activitiesDurationSummaryNote');
    if (banner) banner.classList.add('hidden');
    return;
  }

  container.innerHTML = '';
  activities.forEach((act, index) => {
    let detailPills = '';
    if (act.conditionalFields) {
      if (act.conditionalFields.footage) {
        detailPills += `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-950/70 border border-emerald-600/50 text-[11px] font-bold text-emerald-300">متراژ: ${act.conditionalFields.footage} متر</span>`;
      }
      if (act.conditionalFields.equipmentId) {
        detailPills += `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-950/70 border border-amber-600/50 text-[11px] font-bold text-amber-300 font-mono">تجهیز: ${act.conditionalFields.equipmentId}</span>`;
      }
      if (act.conditionalFields.deviceTag) {
        detailPills += `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-blue-950/70 border border-blue-600/50 text-[11px] font-bold text-blue-300 font-mono">تگ: ${act.conditionalFields.deviceTag}</span>`;
      }
      if (act.conditionalFields.referenceTool) {
        detailPills += `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-blue-950/70 border border-blue-600/50 text-[11px] font-bold text-blue-300 font-mono">مرجع: ${act.conditionalFields.referenceTool}</span>`;
      }
    }

    const itemEl = document.createElement('div');
    itemEl.className = 'p-3 rounded-2xl bg-slate-950/90 border border-slate-700/80 shadow-md space-y-2.5 transition hover:border-slate-600';
    const rebuildableText = act.rebuildableDesc
      ? `${act.rebuildable} - ${act.rebuildableDesc}`
      : act.rebuildable;
    const rebuildableBadge = act.rebuildable
      ? `<span class="inline-flex max-w-full break-words whitespace-normal text-right items-center gap-1 px-2 py-0.5 rounded-lg bg-cyan-950/80 border border-cyan-500/50 text-[11px] font-bold text-cyan-300">
          <svg class="w-3 h-3 text-cyan-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
          <span class="break-words">قطعه Rebuildble: ${escapeHtml(rebuildableText)}</span>
        </span>`
      : '';

    const hasTime = (act.durationTotalSeconds && act.durationTotalSeconds > 0);
    const timeDisplayHtml = hasTime
      ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 shadow-sm">
          <svg class="w-3.5 h-3.5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          <span>${escapeHtml(act.durationFormatted || act.durationDigital)}</span>
          <span class="text-[10px] text-emerald-400/80 font-sans font-normal border-r border-emerald-500/40 pr-1.5 mr-0.5">(${escapeHtml(act.durationMethod || 'دستی')})</span>
        </span>`
      : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-900 text-slate-400 border border-slate-800">
          <span>زمان ثبت نشده</span>
        </span>`;

    itemEl.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-start gap-2.5 min-w-0 flex-1 overflow-hidden">
          <span class="w-6 h-6 rounded-lg bg-amber-500/20 text-amber-400 font-mono font-bold text-xs flex items-center justify-center shrink-0 border border-amber-500/30 mt-0.5">
            ${index + 1}
          </span>
          <div class="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
            <span class="text-xs sm:text-sm font-bold text-slate-100">${escapeHtml(act.type)}</span>
            ${rebuildableBadge}
            ${detailPills}
            ${hasTime ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-mono font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/60 shadow-xs">⏱️ زمان: ${escapeHtml(act.durationFormatted || act.durationDigital)} <span class="text-[10px] text-emerald-400 font-sans font-normal">(${escapeHtml(act.durationMethod)})</span></span>` : ''}
          </div>
        </div>
        <button type="button" onclick="removeAddedActivity('${act.id}')" class="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-950/40 rounded-lg transition shrink-0 cursor-pointer" title="حذف این فعالیت">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        </button>
      </div>

      <!-- سطر ثبت و تنظیم زمان اختصاصی این فعالیت (دستی و جداگانه) -->
      <div class="pt-2 border-t border-slate-800/80 bg-slate-900/60 -mx-3 -mb-3 p-3 rounded-b-2xl space-y-2.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-[11px] font-bold text-slate-300 flex items-center gap-1">
              <svg class="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              <span>مدت این فعالیت:</span>
            </span>
            <div id="actCardBadge_${act.id}">${timeDisplayHtml}</div>
          </div>
          <div class="flex items-center gap-1.5 flex-wrap">
            <button type="button" onclick="startStopwatchForActivity('${act.id}')" class="px-2.5 py-1 bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-500 hover:to-teal-600 active:scale-95 text-white rounded-lg text-[11px] font-black transition cursor-pointer flex items-center gap-1.5 shadow-sm" title="کرنومتر اختصاصی زنده این فعالیت">
              <svg class="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              <span>⏱️ کرنومتر این فعالیت</span>
            </button>
            <button type="button" onclick="openActivityTimeModal('${act.id}', 'manual')" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg text-[11px] font-bold transition cursor-pointer flex items-center gap-1" title="تنظیم پیشرفته زمان فعالیت">
              <span>تنظیم زمان ⚙️</span>
            </button>
          </div>
        </div>

        <!-- فیلدهای ورودی مستقیم دستی (ساعت و دقیقه) برای هر فعالیت به صورت مستقل و جداگانه -->
        <div class="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-slate-950/80 p-2 rounded-xl border border-slate-800">
          <div class="flex items-center gap-1.5 flex-1 min-w-[170px]" dir="ltr">
            <!-- ساعت -->
            <div class="relative flex-1">
              <input type="number" id="actCardHr_${act.id}" value="${act.durationHours > 0 ? act.durationHours : ''}" min="0" max="999" placeholder="0" onchange="updateActivityTimeDirect('${act.id}', false)" class="w-full bg-slate-900 border border-slate-700 hover:border-cyan-500 focus:border-cyan-500 rounded-lg px-2 py-1.5 text-xs font-mono text-center text-cyan-300 outline-none">
              <span class="absolute left-1.5 top-1.5 text-[8px] text-slate-500 font-bold pointer-events-none">HR</span>
            </div>
            <span class="text-slate-500 font-bold text-xs select-none">:</span>
            <!-- دقیقه -->
            <div class="relative flex-1">
              <input type="number" id="actCardMin_${act.id}" value="${(act.durationMinutes !== undefined && act.durationMinutes !== null && act.durationTotalSeconds > 0) ? act.durationMinutes : ''}" min="0" max="59" placeholder="0" onchange="updateActivityTimeDirect('${act.id}', false)" class="w-full bg-slate-900 border border-slate-700 hover:border-cyan-500 focus:border-cyan-500 rounded-lg px-2 py-1.5 text-xs font-mono text-center text-cyan-300 outline-none">
              <span class="absolute left-1.5 top-1.5 text-[8px] text-slate-500 font-bold pointer-events-none">MIN</span>
            </div>
            <span class="text-[10px] text-slate-400 font-sans" dir="rtl">ساعت و دقیقه</span>
          </div>

          <!-- دکمه‌های سریع زمان و دکمه ثبت دستی -->
          <div class="flex items-center gap-1 flex-wrap shrink-0">
            <button type="button" onclick="setActivityQuickTimeDirect('${act.id}', 0, 15)" class="px-1.5 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 rounded-md text-[10px] font-mono cursor-pointer transition">۱۵د</button>
            <button type="button" onclick="setActivityQuickTimeDirect('${act.id}', 0, 30)" class="px-1.5 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 rounded-md text-[10px] font-mono cursor-pointer transition">۳۰د</button>
            <button type="button" onclick="setActivityQuickTimeDirect('${act.id}', 1, 0)" class="px-1.5 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 rounded-md text-[10px] font-mono cursor-pointer transition">۱س</button>
            <button type="button" onclick="updateActivityTimeDirect('${act.id}', true)" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white font-bold rounded-lg text-xs flex items-center gap-1 shadow transition cursor-pointer" title="ثبت دستی زمان برای این فعالیت">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
              <span>ثبت دستی</span>
            </button>
            ${hasTime ? `
            <button type="button" onclick="clearActivityTimeDirect('${act.id}')" class="p-1 bg-slate-800 hover:bg-red-950 text-slate-400 hover:text-red-300 border border-slate-700 rounded-lg text-xs transition cursor-pointer" title="پاکسازی زمان این فعالیت">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7"/></svg>
            </button>
            ` : ''}
          </div>
        </div>
      </div>
    `;
    container.appendChild(itemEl);
  });
}

// ==========================================
// توابع مدیریت زمان اختصاصی تفکیک‌شده برای هر فعالیت
// ==========================================
// ==========================================
// ماژول زمان اختصاصی برای ثبت فعالیت (ورود دستی و کرنومتر زنده پیش از افزودن)
// ==========================================
window.PendingStopwatchState = {
  isRunning: false,
  startTime: 0,
  elapsedTime: 0, // بر حسب میلی‌ثانیه
  timerInterval: null,
  activeTab: 'manual' // 'manual' یا 'stopwatch'
};

function switchPendingTimeTab(tab) {
  window.PendingStopwatchState.activeTab = tab;
  const manualBtn = document.getElementById('pendingTabManualBtn');
  const swBtn = document.getElementById('pendingTabStopwatchBtn');
  const manualSec = document.getElementById('pendingManualSection');
  const swSec = document.getElementById('pendingStopwatchSection');

  if (tab === 'stopwatch') {
    if (manualBtn) {
      manualBtn.className = 'px-2.5 py-1 rounded-md font-bold transition text-slate-400 hover:text-slate-200 cursor-pointer';
    }
    if (swBtn) {
      swBtn.className = 'px-2.5 py-1 rounded-md font-bold transition text-slate-950 bg-amber-400 shadow cursor-pointer';
    }
    if (manualSec) manualSec.classList.add('hidden');
    if (swSec) swSec.classList.remove('hidden');

    // اگر زمان کرنومتر صفر است اما دستی وارد شده بود، همگام شود
    if (window.PendingStopwatchState.elapsedTime === 0 && !window.PendingStopwatchState.isRunning) {
      const h = parseInt(toEnglishDigits(document.getElementById('actHoursInput')?.value || ''), 10) || 0;
      const m = parseInt(toEnglishDigits(document.getElementById('actMinutesInput')?.value || ''), 10) || 0;
      const sec = (h * 3600) + (m * 60);
      if (sec > 0) {
        window.PendingStopwatchState.elapsedTime = sec * 1000;
        updatePendingStopwatchDisplay();
      }
    }
  } else {
    if (manualBtn) {
      manualBtn.className = 'px-2.5 py-1 rounded-md font-bold transition text-slate-950 bg-amber-400 shadow cursor-pointer';
    }
    if (swBtn) {
      swBtn.className = 'px-2.5 py-1 rounded-md font-bold transition text-slate-400 hover:text-slate-200 cursor-pointer';
    }
    if (manualSec) manualSec.classList.remove('hidden');
    if (swSec) swSec.classList.add('hidden');

    if (window.PendingStopwatchState.elapsedTime > 0) {
      const totalSec = Math.round(window.PendingStopwatchState.elapsedTime / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      const hrEl = document.getElementById('actHoursInput');
      const minEl = document.getElementById('actMinutesInput');
      const secEl = document.getElementById('actSecondsInput');
      if (hrEl) hrEl.value = h > 0 ? h : '';
      if (minEl) minEl.value = m;
      if (secEl) secEl.value = s;
    }
  }
}

function updatePendingStopwatchDisplay() {
  const totalMs = Math.max(0, window.PendingStopwatchState.elapsedTime || 0);
  const totalSeconds = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const hrEl = document.getElementById('pendingSwHours');
  const minEl = document.getElementById('pendingSwMinutes');
  const secEl = document.getElementById('pendingSwSeconds');
  if (hrEl) hrEl.textContent = formatTwoDigits(hours);
  if (minEl) minEl.textContent = formatTwoDigits(minutes);
  if (secEl) secEl.textContent = formatTwoDigits(seconds);

  const isRunning = window.PendingStopwatchState.isRunning;
  const startBtn = document.getElementById('pendingSwStartPauseBtn');
  const startText = document.getElementById('pendingSwStartText');
  const startIcon = document.getElementById('pendingSwStartIcon');
  const dotEl = document.getElementById('pendingSwStatusDot');
  const statusEl = document.getElementById('pendingSwStatusText');

  if (isRunning) {
    if (startBtn) {
      startBtn.className = 'py-2 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 active:scale-95 text-slate-950 font-black rounded-xl text-xs flex items-center justify-center gap-1.5 shadow transition cursor-pointer';
    }
    if (startText) startText.textContent = 'توقف کرنومتر (مکث)';
    if (startIcon) {
      startIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"/>';
    }
    if (dotEl) dotEl.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
    if (statusEl) statusEl.textContent = 'کرنومتر در حال اندازه‌گیری زمان این فعالیت...';
  } else {
    if (startBtn) {
      startBtn.className = 'py-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 active:scale-95 text-slate-950 font-black rounded-xl text-xs flex items-center justify-center gap-1.5 shadow transition cursor-pointer';
    }
    if (startText) startText.textContent = totalSeconds > 0 ? 'ادامه کرنومتر' : 'شروع کرنومتر';
    if (startIcon) {
      startIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>';
    }
    if (dotEl) dotEl.className = totalSeconds > 0 ? 'w-2 h-2 rounded-full bg-amber-400' : 'w-2 h-2 rounded-full bg-slate-500';
    if (statusEl) statusEl.textContent = totalSeconds > 0 ? 'کرنومتر متوقف است (آماده افزودن فعالیت)' : 'آماده شروع تایمر این فعالیت';
  }
}

function togglePendingActivityStopwatch() {
  if (window.PendingStopwatchState.isRunning) {
    window.PendingStopwatchState.isRunning = false;
    if (window.PendingStopwatchState.timerInterval) {
      clearInterval(window.PendingStopwatchState.timerInterval);
      window.PendingStopwatchState.timerInterval = null;
    }
    if (window.PendingStopwatchState.startTime > 0) {
      window.PendingStopwatchState.elapsedTime = Math.max(0, Date.now() - window.PendingStopwatchState.startTime);
    }
    // همگام‌سازی فیلدهای دستی
    const totalSec = Math.round(window.PendingStopwatchState.elapsedTime / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const hrEl = document.getElementById('actHoursInput');
    const minEl = document.getElementById('actMinutesInput');
    const secEl = document.getElementById('actSecondsInput');
    if (hrEl) hrEl.value = h > 0 ? h : '';
    if (minEl) minEl.value = m;
    if (secEl) secEl.value = s;
  } else {
    window.PendingStopwatchState.isRunning = true;
    window.PendingStopwatchState.startTime = Date.now() - (window.PendingStopwatchState.elapsedTime || 0);
    if (window.PendingStopwatchState.timerInterval) {
      clearInterval(window.PendingStopwatchState.timerInterval);
    }
    window.PendingStopwatchState.timerInterval = setInterval(() => {
      window.PendingStopwatchState.elapsedTime = Math.max(0, Date.now() - window.PendingStopwatchState.startTime);
      updatePendingStopwatchDisplay();
    }, 200);
  }
  updatePendingStopwatchDisplay();
}

function resetPendingActivityStopwatch() {
  if (window.PendingStopwatchState.isRunning) {
    window.PendingStopwatchState.isRunning = false;
    if (window.PendingStopwatchState.timerInterval) {
      clearInterval(window.PendingStopwatchState.timerInterval);
      window.PendingStopwatchState.timerInterval = null;
    }
  }
  window.PendingStopwatchState.elapsedTime = 0;
  window.PendingStopwatchState.startTime = 0;
  updatePendingStopwatchDisplay();

  const hrEl = document.getElementById('actHoursInput');
  const minEl = document.getElementById('actMinutesInput');
  const secEl = document.getElementById('actSecondsInput');
  if (hrEl) hrEl.value = '';
  if (minEl) minEl.value = '';
  if (secEl) secEl.value = 0;
}

function setPendingActQuickTime(h, m) {
  const hrEl = document.getElementById('actHoursInput');
  const minEl = document.getElementById('actMinutesInput');
  const secEl = document.getElementById('actSecondsInput');
  if (hrEl) hrEl.value = h > 0 ? h : '';
  if (minEl) minEl.value = m;
  if (secEl) secEl.value = 0;

  const sec = (h * 3600) + (m * 60);
  if (window.PendingStopwatchState) {
    window.PendingStopwatchState.elapsedTime = sec * 1000;
    updatePendingStopwatchDisplay();
  }
}

function saveManualPendingTime() {
  const hrEl = document.getElementById('actHoursInput');
  const minEl = document.getElementById('actMinutesInput');
  const h = parseInt(toEnglishDigits(hrEl?.value || ''), 10) || 0;
  const m = parseInt(toEnglishDigits(minEl?.value || ''), 10) || 0;
  const totalSec = (h * 3600) + (m * 60);
  if (totalSec <= 0) {
    showToast('لطفاً ساعت یا دقیقه معتبر وارد نمایید.', 'warning');
    return;
  }
  window.PendingStopwatchState.elapsedTime = totalSec * 1000;
  window.PendingStopwatchState.activeTab = 'manual';
  showToast(`✓ زمان دستی (${h > 0 ? h + ' ساعت و ' : ''}${m} دقیقه) ثبت شد. هنگام افزودن فعالیت اعمال می‌گردد.`, 'success');
}

function saveStopwatchPendingTime() {
  const state = window.PendingStopwatchState;
  if (state.isRunning) {
    togglePendingActivityStopwatch();
  }
  const totalSec = Math.round((state.elapsedTime || 0) / 1000);
  if (totalSec <= 0) {
    showToast('کرنومتر هنوز زمانی را ثبت نکرده است.', 'warning');
    return;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const hrEl = document.getElementById('actHoursInput');
  const minEl = document.getElementById('actMinutesInput');
  if (hrEl) hrEl.value = h > 0 ? h : '';
  if (minEl) minEl.value = m;
  showToast(`✓ زمان کرنومتر (${h > 0 ? h + ' ساعت و ' : ''}${m} دقیقه) ثبت شد. هنگام افزودن فعالیت اعمال می‌گردد.`, 'success');
}

/**
 * ثبت دستی مستقیم زمان برای یک فعالیت مشخص شده در لیست
 */
function updateActivityTimeDirect(actId, showNotification = true) {
  const activities = window.AppState.addedActivities || [];
  const act = activities.find(a => a.id === actId);
  if (!act) return;

  const hrEl = document.getElementById(`actCardHr_${actId}`);
  const minEl = document.getElementById(`actCardMin_${actId}`);
  const h = parseInt(toEnglishDigits(hrEl?.value || ''), 10) || 0;
  const m = parseInt(toEnglishDigits(minEl?.value || ''), 10) || 0;
  const s = 0;
  const totalSec = (h * 3600) + (m * 60) + s;

  let formatted = '';
  let digital = '';
  if (totalSec > 0) {
    const parts = [];
    if (h > 0) parts.push(`${h} ساعت`);
    if (m > 0) parts.push(`${m} دقیقه`);
    formatted = parts.join(' و ') || `${m} دقیقه`;
    digital = h > 0 
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
      : `00:${String(m).padStart(2, '0')}`;
  }

  act.durationHours = h;
  act.durationMinutes = m;
  act.durationSeconds = s;
  act.durationTotalSeconds = totalSec;
  act.durationFormatted = formatted;
  act.durationDigital = digital;
  act.durationMethod = totalSec > 0 ? 'دستی' : '';

  recalculateTotalActivitiesDuration();
  renderAddedActivitiesList();
  if (showNotification) {
    showToast(totalSec > 0 
      ? `زمان «${formatted}» برای فعالیت «${act.type}» با موفقیت ثبت شد.`
      : `زمان فعالیت «${act.type}» پاکسازی شد.`, 
      totalSec > 0 ? 'success' : 'info'
    );
  }
}

/**
 * ثبت سریع زمان‌های آماده (Preset) برای یک فعالیت خاص
 */
function setActivityQuickTimeDirect(actId, h, m) {
  const activities = window.AppState.addedActivities || [];
  const act = activities.find(a => a.id === actId);
  if (!act) return;

  const totalSec = (h * 3600) + (m * 60);
  const parts = [];
  if (h > 0) parts.push(`${h} ساعت`);
  if (m > 0) parts.push(`${m} دقیقه`);
  const formatted = parts.join(' و ') || `${m} دقیقه`;
  const digital = h > 0 
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    : `00:${String(m).padStart(2, '0')}`;

  act.durationHours = h;
  act.durationMinutes = m;
  act.durationSeconds = 0;
  act.durationTotalSeconds = totalSec;
  act.durationFormatted = formatted;
  act.durationDigital = digital;
  act.durationMethod = 'دستی';

  recalculateTotalActivitiesDuration();
  renderAddedActivitiesList();
  showToast(`زمان «${formatted}» برای فعالیت «${act.type}» ثبت شد.`, 'success');
}

/**
 * اعمال زمان جاری کرنومتر به یک فعالیت خاص در لیست
 */
function applyStopwatchToActivity(actId) {
  const activities = window.AppState.addedActivities || [];
  const act = activities.find(a => a.id === actId);
  if (!act) {
    showToast('فعالیت مورد نظر یافت نشد', 'error');
    return;
  }
  let sec = 0;
  if (window.StopwatchState && window.StopwatchState.elapsedTime > 0) {
    sec = Math.round(window.StopwatchState.elapsedTime / 1000);
  } else {
    const h = parseInt(toEnglishDigits(document.getElementById('durationHoursInput')?.value || ''), 10) || 0;
    const m = parseInt(toEnglishDigits(document.getElementById('durationMinutesInput')?.value || ''), 10) || 0;
    const s = parseInt(toEnglishDigits(document.getElementById('durationSecondsInput')?.value || ''), 10) || 0;
    sec = (h * 3600) + (m * 60) + s;
  }
  if (sec <= 0) {
    showToast('زمان کرنومتر یا فرم خالی است. ابتدا کرنومتر را به راه اندازید یا زمان را دستی درج نمایید.', 'warning');
    return;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const totalSec = (h * 3600) + (m * 60) + s;

  const parts = [];
  if (h > 0) parts.push(`${h} ساعت`);
  if (m > 0) parts.push(`${m} دقیقه`);
  if (s > 0) parts.push(`${s} ثانیه`);
  const formatted = parts.join(' و ') || (s > 0 ? `${s} ثانیه` : `${m} دقیقه`);
  const digital = h > 0 
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    : `00:${String(m).padStart(2, '0')}`;

  act.durationHours = h;
  act.durationMinutes = m;
  act.durationSeconds = s;
  act.durationTotalSeconds = totalSec;
  act.durationFormatted = formatted;
  act.durationDigital = digital;
  act.durationMethod = (window.StopwatchState && window.StopwatchState.elapsedTime > 0) ? 'کرنومتر' : 'دستی';

  recalculateTotalActivitiesDuration();
  renderAddedActivitiesList();
  showToast(`زمان «${formatted}» با موفقیت برای فعالیت «${act.type}» ثبت شد.`, 'success');
}

/**
 * شروع یا ادامه کرنومتر زنده اختصاصی برای یک فعالیت معین
 */
function startStopwatchForActivity(actId) {
  openActivityTimeModal(actId, 'stopwatch');
}

/**
 * پاکسازی زمان یک فعالیت معین
 */
function clearActivityTimeDirect(actId) {
  const activities = window.AppState.addedActivities || [];
  const act = activities.find(a => a.id === actId);
  if (!act) return;

  act.durationHours = 0;
  act.durationMinutes = 0;
  act.durationSeconds = 0;
  act.durationTotalSeconds = 0;
  act.durationFormatted = '';
  act.durationDigital = '';
  act.durationMethod = '';

  if (window.ActModalStopwatchState && window.ActModalStopwatchState.targetActivityId === actId) {
    resetActivityModalStopwatch();
  }

  recalculateTotalActivitiesDuration();
  renderAddedActivitiesList();
  showToast(`زمان فعالیت «${act.type}» با موفقیت پاکسازی شد.`, 'info');
}

function recalculateTotalActivitiesDuration() {
  const activities = window.AppState.addedActivities || [];
  let totalSec = 0;
  let hasAnyTime = false;
  let countWithTime = 0;

  activities.forEach(a => {
    if (a.durationTotalSeconds && a.durationTotalSeconds > 0) {
      totalSec += a.durationTotalSeconds;
      hasAnyTime = true;
      countWithTime++;
    }
  });

  const banner = document.getElementById('activitiesDurationSummaryNote');
  const bannerVal = document.getElementById('activitiesDurationSummaryValue');

  if (hasAnyTime && totalSec > 0) {
    const totH = Math.floor(totalSec / 3600);
    const totM = Math.floor((totalSec % 3600) / 60);
    const totS = totalSec % 60;

    const parts = [];
    if (totH > 0) parts.push(`${totH} ساعت`);
    if (totM > 0) parts.push(`${totM} دقیقه`);
    if (totS > 0) parts.push(`${totS} ثانیه`);
    const formatted = parts.join(' و ') || `${totM} دقیقه`;

    if (banner && bannerVal) {
      bannerVal.textContent = `${formatted} (مجموع ${countWithTime} فعالیت)`;
      banner.classList.remove('hidden');
    }

    // بروزرسانی خودکار ورودی‌های کارت اصلی مدت زمان گراف
    const hrEl = document.getElementById('durationHoursInput');
    const minEl = document.getElementById('durationMinutesInput');
    const secEl = document.getElementById('durationSecondsInput');
    if (hrEl) hrEl.value = totH > 0 ? totH : '';
    if (minEl) minEl.value = totM;
    if (secEl) secEl.value = totS;
    updateDurationFormattedDisplay();
  } else {
    if (banner) banner.classList.add('hidden');
  }
}

// ==========================================
// وضعیت و منطق کرنومتر اختصاصی مودال فعالیت
// ==========================================
window.ActModalStopwatchState = {
  isRunning: false,
  startTime: 0,
  elapsedTime: 0, // بر حسب میلی‌ثانیه
  timerInterval: null,
  targetActivityId: null,
  activeTab: 'manual' // 'manual' یا 'stopwatch'
};

function switchModalTimeTab(tab) {
  window.ActModalStopwatchState.activeTab = tab;
  const manualBtn = document.getElementById('modalTabManualBtn');
  const swBtn = document.getElementById('modalTabStopwatchBtn');
  const manualSec = document.getElementById('modalManualSection');
  const swSec = document.getElementById('modalStopwatchSection');

  if (tab === 'stopwatch') {
    if (manualBtn) {
      manualBtn.className = 'flex-1 py-1.5 text-xs font-bold rounded-lg transition text-slate-400 hover:text-slate-200 cursor-pointer';
    }
    if (swBtn) {
      swBtn.className = 'flex-1 py-1.5 text-xs font-bold rounded-lg transition text-slate-950 bg-amber-400 shadow cursor-pointer';
    }
    if (manualSec) manualSec.classList.add('hidden');
    if (swSec) swSec.classList.remove('hidden');

    // اگر کرنومتر صفر است اما کاربر قبلاً زمان دستی وارد کرده بود، زمان اولیه کرنومتر را با آن همگام کنیم
    if ((window.ActModalStopwatchState.elapsedTime === 0) && !window.ActModalStopwatchState.isRunning) {
      const h = parseInt(toEnglishDigits(document.getElementById('modalActHoursInput')?.value || ''), 10) || 0;
      const m = parseInt(toEnglishDigits(document.getElementById('modalActMinutesInput')?.value || ''), 10) || 0;
      const s = parseInt(toEnglishDigits(document.getElementById('modalActSecondsInput')?.value || ''), 10) || 0;
      const sec = (h * 3600) + (m * 60) + s;
      if (sec > 0) {
        window.ActModalStopwatchState.elapsedTime = sec * 1000;
        updateActModalStopwatchDisplay();
      }
    }
  } else {
    if (manualBtn) {
      manualBtn.className = 'flex-1 py-1.5 text-xs font-bold rounded-lg transition text-slate-950 bg-amber-400 shadow cursor-pointer';
    }
    if (swBtn) {
      swBtn.className = 'flex-1 py-1.5 text-xs font-bold rounded-lg transition text-slate-400 hover:text-slate-200 cursor-pointer';
    }
    if (manualSec) manualSec.classList.remove('hidden');
    if (swSec) swSec.classList.add('hidden');

    // اگر از حالت کرنومتر برمی‌گردد و زمان کرنومتر بزرگتر از صفر است، فیلدهای دستی را همگام کنیم
    if (window.ActModalStopwatchState.elapsedTime > 0) {
      const totalSec = Math.round(window.ActModalStopwatchState.elapsedTime / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      const hrEl = document.getElementById('modalActHoursInput');
      const minEl = document.getElementById('modalActMinutesInput');
      const secEl = document.getElementById('modalActSecondsInput');
      if (hrEl) hrEl.value = h > 0 ? h : '';
      if (minEl) minEl.value = m;
      if (secEl) secEl.value = s;
    }
  }
}

function updateActModalStopwatchDisplay() {
  const totalMs = Math.max(0, window.ActModalStopwatchState.elapsedTime || 0);
  const totalSeconds = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const hrEl = document.getElementById('actModalSwHours');
  const minEl = document.getElementById('actModalSwMinutes');
  const secEl = document.getElementById('actModalSwSeconds');
  if (hrEl) hrEl.textContent = formatTwoDigits(hours);
  if (minEl) minEl.textContent = formatTwoDigits(minutes);
  if (secEl) secEl.textContent = formatTwoDigits(seconds);

  const isRunning = window.ActModalStopwatchState.isRunning;
  const startBtn = document.getElementById('actModalSwStartPauseBtn');
  const startText = document.getElementById('actModalSwStartText');
  const startIcon = document.getElementById('actModalSwStartIcon');
  const dotEl = document.getElementById('actModalSwStatusDot');
  const statusEl = document.getElementById('actModalSwStatusText');

  if (isRunning) {
    if (startBtn) {
      startBtn.className = 'py-2.5 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 active:scale-95 text-slate-950 font-black rounded-xl text-xs flex items-center justify-center gap-1.5 shadow transition cursor-pointer';
    }
    if (startText) startText.textContent = 'توقف کرنومتر (مکث)';
    if (startIcon) {
      startIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"/>';
    }
    if (dotEl) dotEl.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
    if (statusEl) statusEl.textContent = 'کرنومتر در حال اندازه‌گیری زمان فعالیت...';
  } else {
    if (startBtn) {
      startBtn.className = 'py-2.5 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 active:scale-95 text-slate-950 font-black rounded-xl text-xs flex items-center justify-center gap-1.5 shadow transition cursor-pointer';
    }
    if (startText) startText.textContent = totalSeconds > 0 ? 'ادامه کرنومتر' : 'شروع کرنومتر';
    if (startIcon) {
      startIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>';
    }
    if (dotEl) dotEl.className = totalSeconds > 0 ? 'w-2 h-2 rounded-full bg-amber-400' : 'w-2 h-2 rounded-full bg-slate-500';
    if (statusEl) statusEl.textContent = totalSeconds > 0 ? 'کرنومتر متوقف است (آماده تأیید یا ادامه)' : 'آماده شروع اندازه‌گیری زمان فعالیت';
  }
}

function toggleActivityModalStopwatch() {
  if (window.ActModalStopwatchState.isRunning) {
    // توقف کرنومتر
    window.ActModalStopwatchState.isRunning = false;
    if (window.ActModalStopwatchState.timerInterval) {
      clearInterval(window.ActModalStopwatchState.timerInterval);
      window.ActModalStopwatchState.timerInterval = null;
    }
    if (window.ActModalStopwatchState.startTime > 0) {
      window.ActModalStopwatchState.elapsedTime = Math.max(0, Date.now() - window.ActModalStopwatchState.startTime);
    }
    // همگام‌سازی فیلدهای دستی
    const totalSec = Math.round(window.ActModalStopwatchState.elapsedTime / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const hrEl = document.getElementById('modalActHoursInput');
    const minEl = document.getElementById('modalActMinutesInput');
    const secEl = document.getElementById('modalActSecondsInput');
    if (hrEl) hrEl.value = h > 0 ? h : '';
    if (minEl) minEl.value = m;
    if (secEl) secEl.value = s;
  } else {
    // شروع کرنومتر
    window.ActModalStopwatchState.isRunning = true;
    window.ActModalStopwatchState.startTime = Date.now() - (window.ActModalStopwatchState.elapsedTime || 0);
    if (window.ActModalStopwatchState.timerInterval) {
      clearInterval(window.ActModalStopwatchState.timerInterval);
    }
    window.ActModalStopwatchState.timerInterval = setInterval(() => {
      window.ActModalStopwatchState.elapsedTime = Math.max(0, Date.now() - window.ActModalStopwatchState.startTime);
      updateActModalStopwatchDisplay();
    }, 200);
  }
  updateActModalStopwatchDisplay();
}

function resetActivityModalStopwatch() {
  if (window.ActModalStopwatchState.isRunning) {
    window.ActModalStopwatchState.isRunning = false;
    if (window.ActModalStopwatchState.timerInterval) {
      clearInterval(window.ActModalStopwatchState.timerInterval);
      window.ActModalStopwatchState.timerInterval = null;
    }
  }
  window.ActModalStopwatchState.elapsedTime = 0;
  window.ActModalStopwatchState.startTime = 0;
  updateActModalStopwatchDisplay();

  const hrEl = document.getElementById('modalActHoursInput');
  const minEl = document.getElementById('modalActMinutesInput');
  const secEl = document.getElementById('modalActSecondsInput');
  if (hrEl) hrEl.value = '';
  if (minEl) minEl.value = '';
  if (secEl) secEl.value = 0;
}

function openActivityTimeModal(actId, defaultTab = 'manual') {
  const activities = window.AppState.addedActivities || [];
  const act = activities.find(a => a.id === actId);
  if (!act) {
    showToast('فعالیت مورد نظر یافت نشد', 'error');
    return;
  }

  // اگر تایمر مودال قبلی در حال کار بوده باشد، متوقف شود
  if (window.ActModalStopwatchState.isRunning) {
    toggleActivityModalStopwatch();
  }

  window.ActModalStopwatchState.targetActivityId = actId;
  window.ActModalStopwatchState.elapsedTime = (act.durationTotalSeconds || 0) * 1000;
  window.ActModalStopwatchState.startTime = 0;
  window.ActModalStopwatchState.isRunning = false;

  const idInput = document.getElementById('modalTargetActivityId');
  const titleEl = document.getElementById('modalTargetActivityTitle');
  const subEl = document.getElementById('modalTargetActivitySub');
  const hrEl = document.getElementById('modalActHoursInput');
  const minEl = document.getElementById('modalActMinutesInput');
  const secEl = document.getElementById('modalActSecondsInput');

  if (idInput) idInput.value = actId;
  if (titleEl) titleEl.textContent = `فعالیت: ${act.type}`;
  if (subEl) subEl.textContent = `قطعه Rebuildble ID: ${act.rebuildable || 'تعیین نشده'} ${act.rebuildableDesc ? `(${act.rebuildableDesc})` : ''}`;

  if (hrEl) hrEl.value = (act.durationHours && act.durationHours > 0) ? act.durationHours : '';
  if (minEl) minEl.value = (act.durationMinutes !== undefined && act.durationMinutes !== null && act.durationTotalSeconds > 0) ? act.durationMinutes : '';
  if (secEl) secEl.value = act.durationSeconds || 0;

  updateActModalStopwatchDisplay();
  switchModalTimeTab(defaultTab);
  openModal('activityTimeModal');

  // اگر کاربر دکمه کرنومتر را زده و زمان فعالیت صفر است، بلافاصله کرنومتر را راه بیندازیم
  if (defaultTab === 'stopwatch' && (!act.durationTotalSeconds || act.durationTotalSeconds === 0)) {
    toggleActivityModalStopwatch();
  }
}

function closeActivityTimeModal() {
  if (window.ActModalStopwatchState.isRunning) {
    toggleActivityModalStopwatch();
  }
  closeModal('activityTimeModal');
}

function setModalQuickTime(h, m) {
  const hrEl = document.getElementById('modalActHoursInput');
  const minEl = document.getElementById('modalActMinutesInput');
  const secEl = document.getElementById('modalActSecondsInput');
  if (hrEl) hrEl.value = h > 0 ? h : '';
  if (minEl) minEl.value = m;
  if (secEl) secEl.value = 0;

  // همگام‌سازی زمان کرنومتر در صورت صفر بودن
  const sec = (h * 3600) + (m * 60);
  window.ActModalStopwatchState.elapsedTime = sec * 1000;
  updateActModalStopwatchDisplay();
}

function applyStopwatchTimeToModal() {
  let sec = 0;
  if (window.StopwatchState && window.StopwatchState.elapsedTime > 0) {
    sec = Math.round(window.StopwatchState.elapsedTime / 1000);
  } else {
    const h = parseInt(toEnglishDigits(document.getElementById('durationHoursInput')?.value || ''), 10) || 0;
    const m = parseInt(toEnglishDigits(document.getElementById('durationMinutesInput')?.value || ''), 10) || 0;
    const s = parseInt(toEnglishDigits(document.getElementById('durationSecondsInput')?.value || ''), 10) || 0;
    sec = (h * 3600) + (m * 60) + s;
  }
  if (sec <= 0) {
    showToast('زمان کرنومتر یا فرم اصلی هنوز خالی است', 'warning');
    return;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  setModalQuickTime(h, m);
  const secEl = document.getElementById('modalActSecondsInput');
  if (secEl) secEl.value = s;
  window.ActModalStopwatchState.elapsedTime = sec * 1000;
  updateActModalStopwatchDisplay();
  showToast('زمان از کرنومتر اصلی با موفقیت در فیلدها درج گردید', 'success');
}

function clearModalActivityTime() {
  const hrEl = document.getElementById('modalActHoursInput');
  const minEl = document.getElementById('modalActMinutesInput');
  const secEl = document.getElementById('modalActSecondsInput');
  if (hrEl) hrEl.value = '';
  if (minEl) minEl.value = '';
  if (secEl) secEl.value = 0;
  resetActivityModalStopwatch();
}

function saveActivityTimeFromModal() {
  const idInput = document.getElementById('modalTargetActivityId');
  const actId = idInput ? idInput.value : '';
  const activities = window.AppState.addedActivities || [];
  const act = activities.find(a => a.id === actId);
  if (!act) {
    showToast('فعالیت مورد نظر یافت نشد', 'error');
    closeActivityTimeModal();
    return;
  }

  // اگر کرنومتر در حال کار است، متوقف شود
  if (window.ActModalStopwatchState.isRunning) {
    toggleActivityModalStopwatch();
  }

  let totalSec = 0;
  let h = 0;
  let m = 0;
  let s = 0;
  let method = 'دستی';

  const isStopwatchTab = window.ActModalStopwatchState.activeTab === 'stopwatch';
  const swElapsedSec = Math.round((window.ActModalStopwatchState.elapsedTime || 0) / 1000);

  if (isStopwatchTab && swElapsedSec > 0) {
    totalSec = swElapsedSec;
    h = Math.floor(totalSec / 3600);
    m = Math.floor((totalSec % 3600) / 60);
    s = totalSec % 60;
    method = 'کرنومتر';
  } else {
    h = parseInt(toEnglishDigits(document.getElementById('modalActHoursInput')?.value || ''), 10) || 0;
    m = parseInt(toEnglishDigits(document.getElementById('modalActMinutesInput')?.value || ''), 10) || 0;
    s = parseInt(toEnglishDigits(document.getElementById('modalActSecondsInput')?.value || ''), 10) || 0;
    totalSec = (h * 3600) + (m * 60) + s;

    if (totalSec === 0 && swElapsedSec > 0) {
      totalSec = swElapsedSec;
      h = Math.floor(totalSec / 3600);
      m = Math.floor((totalSec % 3600) / 60);
      s = totalSec % 60;
      method = 'کرنومتر';
    } else {
      method = (act.durationMethod === 'کرنومتر' && swElapsedSec === totalSec) ? 'کرنومتر' : 'دستی';
    }
  }

  let formatted = '';
  let digital = '';
  if (totalSec > 0) {
    const parts = [];
    if (h > 0) parts.push(`${h} ساعت`);
    if (m > 0) parts.push(`${m} دقیقه`);
    if (s > 0) parts.push(`${s} ثانیه`);
    formatted = parts.join(' و ') || (s > 0 ? `${s} ثانیه` : `${m} دقیقه`);
    digital = h > 0 
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
      : `00:${String(m).padStart(2, '0')}`;
  }

  act.durationHours = h;
  act.durationMinutes = m;
  act.durationSeconds = s;
  act.durationTotalSeconds = totalSec;
  act.durationFormatted = formatted;
  act.durationDigital = digital;
  act.durationMethod = totalSec > 0 ? method : '';

  recalculateTotalActivitiesDuration();
  renderAddedActivitiesList();
  closeActivityTimeModal();

  showToast(totalSec > 0 
    ? `زمان «${formatted}» با روش «${method}» برای فعالیت «${act.type}» با موفقیت ذخیره شد.` 
    : `زمان فعالیت «${act.type}» پاکسازی شد.`, 
    totalSec > 0 ? 'success' : 'info'
  );
}

// انتشار سراسری در آبجکت window جهت اطمینان از دسترس‌پذیری در رویدادهای inline HTML
window.handleActivityChange = handleActivityChange;
window.addSelectedActivity = addSelectedActivity;
window.removeAddedActivity = removeAddedActivity;
window.renderAddedActivitiesList = renderAddedActivitiesList;
window.updateActivityTimeDirect = updateActivityTimeDirect;
window.setActivityQuickTimeDirect = setActivityQuickTimeDirect;
window.applyStopwatchToActivity = applyStopwatchToActivity;
window.startStopwatchForActivity = startStopwatchForActivity;
window.clearActivityTimeDirect = clearActivityTimeDirect;
window.setPendingActQuickTime = setPendingActQuickTime;
window.openActivityTimeModal = openActivityTimeModal;
window.closeActivityTimeModal = closeActivityTimeModal;
window.switchModalTimeTab = switchModalTimeTab;
window.updateActModalStopwatchDisplay = updateActModalStopwatchDisplay;
window.toggleActivityModalStopwatch = toggleActivityModalStopwatch;
window.resetActivityModalStopwatch = resetActivityModalStopwatch;
window.setModalQuickTime = setModalQuickTime;
window.applyStopwatchTimeToModal = applyStopwatchTimeToModal;
window.clearModalActivityTime = clearModalActivityTime;
window.saveActivityTimeFromModal = saveActivityTimeFromModal;
window.copyStopwatchToPendingActivity = copyStopwatchToPendingActivity;
window.recalculateTotalActivitiesDuration = recalculateTotalActivitiesDuration;
window.PendingStopwatchState = PendingStopwatchState;
window.switchPendingTimeTab = switchPendingTimeTab;
window.updatePendingStopwatchDisplay = updatePendingStopwatchDisplay;
window.togglePendingActivityStopwatch = togglePendingActivityStopwatch;
window.resetPendingActivityStopwatch = resetPendingActivityStopwatch;
window.saveManualPendingTime = saveManualPendingTime;
window.saveStopwatchPendingTime = saveStopwatchPendingTime;
window._realSwitchPendingTimeTab = switchPendingTimeTab;
window._realTogglePendingActivityStopwatch = togglePendingActivityStopwatch;
window._realResetPendingActivityStopwatch = resetPendingActivityStopwatch;
window._realUpdatePendingStopwatchDisplay = updatePendingStopwatchDisplay;
window._realSetPendingActQuickTime = setPendingActQuickTime;

// ==========================================
// ۵. مدیریت همکاران همراه (Dynamic Colleagues) با جستجو در بانک پرسنل اکسل
// ==========================================
function parsePersonnelFullName(rawName) {
  if (!rawName) return { firstName: '', lastName: '', fatherName: '', fullName: '' };

  let cleanName = String(rawName).replace(/ي/g, 'ی').replace(/ك/g, 'ک').trim();

  // تفکیک بر اساس کاما فارسی (،) یا کاما انگلیسی (,)
  const parts = cleanName.split(/[,،]+/).map(p => p.trim()).filter(Boolean);

  if (parts.length >= 3) {
    // قالب استاندارد دیتابیس پرسنل:
    // بخش اول: نام خانوادگی
    // بخش دوم: نام
    // بخش سوم: نام پدر
    // مثال دقیق دیتابیس: «ابوالقاسمی، احسان، حسین» => نام خانوادگی: ابوالقاسمی | نام: احسان | نام پدر: حسین
    const lastName = parts[0];
    const firstName = parts[1];
    const fatherName = parts.slice(2).join(' ');
    return {
      lastName,
      firstName,
      fatherName,
      fullName: `${firstName} ${lastName}`
    };
  } else if (parts.length === 2) {
    // در صورت وجود ۲ بخش: اول نام خانوادگی، دوم نام
    const lastName = parts[0];
    const firstName = parts[1];
    return {
      lastName,
      firstName,
      fatherName: '',
      fullName: `${firstName} ${lastName}`
    };
  } else {
    // در صورتی که کاما وجود نداشته باشد
    const words = cleanName.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      return {
        firstName: words[0],
        lastName: words.slice(1).join(' '),
        fatherName: '',
        fullName: cleanName
      };
    }
    return {
      firstName: cleanName,
      lastName: '',
      fatherName: '',
      fullName: cleanName
    };
  }
}

function toEnglishDigits(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .trim();
}

window.toEnglishDigits = toEnglishDigits;

// مپ جامع پرسنل با تضمین دسترسی فوق‌سریع و بدون وقفه به کل ۷۵۲۷ رکورد
var masterPersonnelMap = window.masterPersonnelMap || new Map();
window.masterPersonnelMap = masterPersonnelMap;

function indexPersonnelRecords(records) {
  if (!records || !Array.isArray(records)) return;
  for (let i = 0; i < records.length; i++) {
    const p = records[i];
    if (!p || !p.code) continue;
    const clean = toEnglishDigits(p.code);
    if (!clean) continue;
    masterPersonnelMap.set(clean, p);
    const unpadded = clean.replace(/^0+/, '');
    if (unpadded) masterPersonnelMap.set(unpadded, p);
    const padded = clean.padStart(7, '0');
    masterPersonnelMap.set(padded, p);
    if (window.AppState && window.AppState.personnelMap) {
      window.AppState.personnelMap.set(clean, p);
      if (unpadded) window.AppState.personnelMap.set(unpadded, p);
      window.AppState.personnelMap.set(padded, p);
    }
  }
}

// ایندکس‌گذاری آنی در لحظه فراخوانی اسکریپت
if (typeof window !== 'undefined' && window.INITIAL_PERSONNEL_DATA && Array.isArray(window.INITIAL_PERSONNEL_DATA)) {
  indexPersonnelRecords(window.INITIAL_PERSONNEL_DATA);
}

function findPersonnelByCode(rawCode) {
  if (!rawCode) return null;
  const rawStr = String(rawCode).trim();
  const digitsOnly = toEnglishDigits(rawStr).replace(/\D/g, '');
  if (!digitsOnly) return null;

  const clean = digitsOnly;
  const padded = clean.padStart(7, '0');
  const unpadded = clean.replace(/^0+/, '');

  if (masterPersonnelMap.has(clean)) return masterPersonnelMap.get(clean);
  if (masterPersonnelMap.has(padded)) return masterPersonnelMap.get(padded);
  if (unpadded && masterPersonnelMap.has(unpadded)) return masterPersonnelMap.get(unpadded);

  return null;
}

function findPersonnelByCredentials(code, nationalId) {
  if (!code || !nationalId) return null;
  const cleanCode = toEnglishDigits(String(code)).replace(/\D/g, '');
  const cleanNId = toEnglishDigits(String(nationalId)).replace(/\D/g, '');
  
  if (!cleanCode || !cleanNId) return null;

  const codePadded = cleanCode.padStart(7, '0');
  const codeUnpadded = cleanCode.replace(/^0+/, '');
  const nidPadded = cleanNId.padStart(10, '0');
  const nidUnpadded = cleanNId.replace(/^0+/, '');

  const list = (window.INITIAL_PERSONNEL_DATA && Array.isArray(window.INITIAL_PERSONNEL_DATA))
    ? window.INITIAL_PERSONNEL_DATA
    : (window.AppState && Array.isArray(window.AppState.personnel) ? window.AppState.personnel : []);

  const match = list.find(p => {
    if (!p) return false;
    const pCodeRaw = toEnglishDigits(String(p.code || '')).replace(/\D/g, '');
    const pCodePadded = pCodeRaw.padStart(7, '0');
    const pCodeUnpadded = pCodeRaw.replace(/^0+/, '');

    const pNIdRaw = toEnglishDigits(String(p.nationalId || '')).replace(/\D/g, '');
    const pNIdPadded = pNIdRaw.padStart(10, '0');
    const pNIdUnpadded = pNIdRaw.replace(/^0+/, '');

    const isCodeMatch = (pCodeRaw === cleanCode || pCodePadded === codePadded || pCodeUnpadded === codeUnpadded);
    const isNIdMatch = (pNIdRaw === cleanNId || pNIdPadded === nidPadded || pNIdUnpadded === nidUnpadded);

    return isCodeMatch && isNIdMatch;
  });

  return match || null;
}
window.findPersonnelByCredentials = findPersonnelByCredentials;

function populatePersonnelDatalist() {
  const datalist = document.getElementById('personnelDatalist');
  if (datalist) datalist.innerHTML = '';
}

function checkPersonnelCredentials() {
  const pidInput = document.getElementById('modalPersonnelId');
  const nidInput = document.getElementById('modalNationalId');
  const badge = document.getElementById('modalPersonnelMatchBadge');
  const pid = (pidInput?.value || '').trim();
  const nid = (nidInput?.value || '').trim();

  if (!pid || !nid) {
    if (badge) {
      badge.innerHTML = '<div class="p-2 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-bold text-center">لطفاً هر دو فیلد شماره پرسنلی و کد ملی را وارد فرمایید.</div>';
    }
    return;
  }

  const match = findPersonnelByCredentials(pid, nid);
  if (!match) {
    if (badge) {
      badge.innerHTML = '<div class="p-2.5 rounded-xl bg-rose-500/20 border border-rose-500/40 text-rose-300 text-xs font-bold text-center shadow-md animate-pulse">⚠️ عدم تطبیق مشخصات! شماره پرسنلی یا کد ملی در دیتابیس یافت نشد.</div>';
    }
    if (pidInput) pidInput.classList.add('border-rose-500');
    if (nidInput) nidInput.classList.add('border-rose-500');
    setTimeout(() => {
      if (pidInput) pidInput.classList.remove('border-rose-500');
      if (nidInput) nidInput.classList.remove('border-rose-500');
    }, 2500);
    return;
  }

  // در صورت تطبیق: بستن مودال و باز شدن صفحه اصلی با نمایش تمام مشخصات
  closeModal('personnelModal');
  if (typeof applyMatchedPersonnelToHome === 'function') {
    applyMatchedPersonnelToHome(match);
  }
}
window.checkPersonnelCredentials = checkPersonnelCredentials;


window.masterPersonnelMap = masterPersonnelMap;
window.indexPersonnelRecords = indexPersonnelRecords;
window.parsePersonnelFullName = parsePersonnelFullName;
window.populatePersonnelDatalist = populatePersonnelDatalist;


function handleColleagueInput(val) {
  const preview = document.getElementById('colleagueMatchPreview');
  if (!preview) return;
  const clean = (val || '').trim();
  if (!clean) {
    preview.innerHTML = '';
    return;
  }

  const match = findPersonnelByCode(clean);
  if (match) {
    preview.innerHTML = `<span class="inline-flex items-center gap-1.5 text-emerald-400 font-bold bg-emerald-950/60 border border-emerald-800/80 px-2 py-0.5 rounded-lg"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span><span>پرسنل شناسایی شد: <strong>${escapeHtml(match.name)}</strong> (کد: ${escapeHtml(match.code)})</span></span>`;
  } else {
    preview.innerHTML = `<span class="text-slate-400 text-[11px]">شماره در بانک پرسنل یافت نشد (در صورت فشردن «افزودن»، با همین شماره ثبت می‌شود).</span>`;
  }
}

function addColleague() {
  const input = document.getElementById('colleaguePersonnelInput');
  if (!input) return;
  const val = input.value.trim();
  if (!val) {
    showToast('لطفاً شماره پرسنلی همکار را وارد کنید', 'error');
    return;
  }

  const match = findPersonnelByCode(val);
  const code = match ? match.code : val;
  const name = match ? match.name : 'نامشخص';

  // بررسی تکراری بودن بر اساس شماره پرسنلی
  const isDuplicate = window.AppState.colleagues.some((c) => {
    const cCode = typeof c === 'object' && c !== null ? c.code : c;
    return String(cCode).trim() === String(code).trim();
  });

  if (isDuplicate) {
    showToast('این شماره پرسنلی قبلاً به لیست همکاران افزوده شده است', 'warning');
    return;
  }

  window.AppState.colleagues.push({ code, name });
  input.value = '';
  const preview = document.getElementById('colleagueMatchPreview');
  if (preview) preview.innerHTML = '';
  renderColleaguesList();
  showToast(`همکار «${name}» (شماره پرسنلی: ${code}) افزوده شد`, 'success');
}

function removeColleague(code) {
  window.AppState.colleagues = window.AppState.colleagues.filter((c) => {
    const cCode = typeof c === 'object' && c !== null ? c.code : c;
    return String(cCode) !== String(code);
  });
  renderColleaguesList();
}

function renderColleaguesList() {
  const container = document.getElementById('colleaguesListContainer');
  if (!container) return;
  container.innerHTML = '';
  if (!window.AppState.colleagues || window.AppState.colleagues.length === 0) {
    container.innerHTML = '<span class="text-xs text-slate-400">همکاری ثبت نشده است.</span>';
    return;
  }

  window.AppState.colleagues.forEach((item) => {
    const code = typeof item === 'object' && item !== null ? item.code : item;
    const name = typeof item === 'object' && item !== null ? item.name : '';

    const badge = document.createElement('div');
    badge.className = 'inline-flex items-center gap-2 bg-slate-800/90 border border-slate-700 hover:border-amber-500/50 text-slate-100 px-3 py-1.5 rounded-xl text-xs shadow transition';
    badge.innerHTML = `
      <div class="flex items-center gap-1.5">
        <span class="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]"></span>
        ${name && name !== 'نامشخص' ? `<span class="font-bold text-amber-300 font-sans">${escapeHtml(name)}</span>` : ''}
        <span class="font-mono text-slate-300 text-[11px] bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">${escapeHtml(code)}</span>
      </div>
      <button type="button" onclick="removeColleague('${escapeHtml(code)}')" class="text-slate-400 hover:text-red-400 transition p-0.5 mr-0.5" title="حذف همکار">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
      </button>
    `;
    container.appendChild(badge);
  });
}

// تنظیم و ایندکس‌گذاری ساختار پرسنل در حافظه
function initPersonnelState(records) {
  if (!records || !Array.isArray(records)) return;
  window.AppState.personnel = records;
  if (!window.AppState.personnelMap) {
    window.AppState.personnelMap = new Map();
  }
  indexPersonnelRecords(records);

  const totalBadge = document.getElementById('personnelTotalBadge');
  if (totalBadge) {
    totalBadge.textContent = `${records.length.toLocaleString('fa-IR')} پرسنل`;
  }
}

// مقداردهی اولیه همگام و آنی در بدو اجرای فایل بدون هیچ‌گونه تاخیر یا پیش‌شرط
if (typeof window !== 'undefined' && window.INITIAL_PERSONNEL_DATA && Array.isArray(window.INITIAL_PERSONNEL_DATA) && window.INITIAL_PERSONNEL_DATA.length > 0) {
  initPersonnelState(window.INITIAL_PERSONNEL_DATA);
}

// بارگذاری بانک اطلاعات پرسنل (از IndexedDB یا فایل پرسنل اولیه اکسل)
async function loadPersonnelData() {
  try {
    const masterList = (typeof window !== 'undefined' && window.INITIAL_PERSONNEL_DATA && Array.isArray(window.INITIAL_PERSONNEL_DATA))
      ? window.INITIAL_PERSONNEL_DATA
      : [];

    if (masterList.length > 0) {
      initPersonnelState(masterList);
    }

    let records = [];
    try {
      records = await getAllPersonnelFromDB();
    } catch (dbErr) {
      console.warn('Could not read from IndexedDB personnel store:', dbErr);
    }

    // اگر دیتابیس لوکال خالی است یا رکوردهای کمتری نسبت به فایل اکسل کامل (۷۵۲۷ رکورد) دارد، بروزرسانی شود
    if (!records || records.length < masterList.length) {
      if (masterList.length > 0) {
        records = masterList;
        saveMultiplePersonnelToDB(records).catch((e) => console.warn('Background save to DB error:', e));
      } else {
        try {
          const res = await fetch('/personnel-data.json');
          if (res.ok) {
            records = await res.json();
            if (records && records.length > 0) {
              saveMultiplePersonnelToDB(records).catch((e) => console.warn('Background save to DB error:', e));
            }
          }
        } catch (fetchErr) {
          console.warn('Fetch personnel-data.json failed:', fetchErr);
        }
      }
    }

    if (records && records.length > 0) {
      initPersonnelState(records);
    }

    // در صورتی که جدول پرسنل در DOM فعال باشد، به‌روزرسانی شود
    const tbody = document.getElementById('personnelTableBody');
    if (tbody) {
      renderPersonnelTable();
    }
  } catch (err) {
    console.error('Error loading personnel data:', err);
  }
}

// ==========================================
// ۶. دریافت و ثبت خودکار موقعیت مکانی (GPS) با بروزرسانی هر ۱۰ ثانیه
// ==========================================
var gpsAutoUpdateInterval = null;
var gpsWatchId = null;

function applyGpsPosition(position) {
  if (!position || !position.coords) return;
  const lat = position.coords.latitude.toFixed(6);
  const lng = position.coords.longitude.toFixed(6);
  const accuracy = Math.round(position.coords.accuracy);
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  window.AppState.currentLocation = { 
    lat, 
    lng, 
    accuracy, 
    timestamp: now.toISOString(),
    updatedAt: timeStr 
  };

  const statusEl = document.getElementById('gpsStatusText');
  const coordsEl = document.getElementById('gpsCoordsText');
  const indicator = document.getElementById('gpsIndicator');
  const mapBtn = document.getElementById('viewOnMapBtn');

  if (statusEl) {
    statusEl.innerHTML = `<span class="inline-block w-2 h-2 rounded-full bg-emerald-400"></span><span class="text-emerald-300 font-bold">موقعیت خودکار قفل شد</span> • ساعت <span class="font-mono">${timeStr}</span> (دقت: ±${accuracy} متر)`;
  }
  if (coordsEl) {
    coordsEl.textContent = `عرض: ${lat} | طول: ${lng}`;
  }
  if (indicator) {
    indicator.className = 'w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]';
  }
  if (mapBtn) {
    mapBtn.classList.remove('hidden');
    mapBtn.onclick = () => window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
  }
}

function updateGPSLocation(isManual = false) {
  const statusEl = document.getElementById('gpsStatusText');
  const indicator = document.getElementById('gpsIndicator');

  if (!navigator.geolocation) {
    if (statusEl) statusEl.textContent = 'دستگاه شما از GPS پشتیبانی نمی‌کند';
    if (indicator) indicator.className = 'w-2 h-2 rounded-full bg-red-500';
    return;
  }

  if (isManual && !window.AppState.currentLocation?.lat) {
    if (statusEl) statusEl.textContent = 'در حال دریافت خودکار مختصات دقیق...';
    if (indicator) indicator.className = 'w-2 h-2 rounded-full bg-amber-400 animate-ping';
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      applyGpsPosition(position);
    },
    (err) => {
      console.warn('Geolocation update note:', err);
      if (!window.AppState.currentLocation?.lat) {
        if (statusEl) statusEl.textContent = 'در حال مکان‌یابی خودکار ماهواره‌ای (دستور دسترسی مکان را در مرورگر تأیید نمایید)...';
        if (indicator) indicator.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
      }
    },
    { enableHighAccuracy: true, timeout: 9000, maximumAge: 4000 }
  );
}

function startAutoGPS() {
  // ۱. دریافت بلافاصله در ابتدای باز شدن برنامه
  updateGPSLocation(true);

  // ۲. گوش‌به‌زنگ بودن سنسور GPS دستگاه برای دریافت فوری کوچک‌ترین جابجایی
  if (navigator.geolocation && navigator.geolocation.watchPosition) {
    try {
      if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
      }
      gpsWatchId = navigator.geolocation.watchPosition(
        (pos) => applyGpsPosition(pos),
        (err) => console.warn('GPS watchPosition note:', err),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
      );
    } catch (e) {
      console.warn('GPS watch error:', e);
    }
  }

  // ۳. حلقه منظم بروزرسانی خودکار هر ۱۰ ثانیه (دقیقاً بر اساس درخواست کاربر)
  if (gpsAutoUpdateInterval) {
    clearInterval(gpsAutoUpdateInterval);
  }
  gpsAutoUpdateInterval = setInterval(() => {
    updateGPSLocation(false);
  }, 10000);
}

// ==========================================
// ۷. مدیریت دوربین و عکس‌برداری صنعتی (پشتیبانی از چندین عکس همزمان)
// ==========================================
function setupCameraInput() {
  const fileInput = document.getElementById('cameraFileInput');
  if (!fileInput) return;

  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    if (!window.AppState.capturedImages) {
      window.AppState.capturedImages = [];
    }

    showToast(`در حال پردازش و برچسب‌گذاری ${files.length} تصویر...`, 'info');

    for (const file of files) {
      try {
        const dataUrl = await processAndWatermarkImage(file);
        window.AppState.capturedImages.push(dataUrl);
      } catch (err) {
        console.error('Error processing photo:', err);
      }
    }

    if (window.AppState.capturedImages.length > 0) {
      window.AppState.capturedImageBase64 = window.AppState.capturedImages[0];
    }

    fileInput.value = ''; // ریست برای امکان انتخاب/ثبت عکس‌های بیشتر
    renderImagePreview();
    showToast(`تعداد کل عکس‌های الحاق‌شده: ${window.AppState.capturedImages.length} تصویر`, 'success');
  });
}

function processAndWatermarkImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (event) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1280;
        const MAX_HEIGHT = 1280;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height = Math.round(height * (MAX_WIDTH / width));
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width = Math.round(width * (MAX_HEIGHT / height));
            height = MAX_HEIGHT;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // درج نوار رسمی و مُهر تاریخ و زمان شمسی
        ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
        ctx.fillRect(0, height - 42, width, 42);
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 16px Vazirmatn, Tahoma, sans-serif';
        ctx.direction = 'rtl';
        const jalali = getFormattedJalali();
        const stampText = `مدیریت اتوماسیون و ارتباطات | ${jalali.fullPersian}`;
        ctx.fillText(stampText, width - 20, height - 15);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        resolve(dataUrl);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function renderImagePreview() {
  const galleryContainer = document.getElementById('photosGalleryContainer');
  const photosGrid = document.getElementById('photosGrid');
  const uploadPlaceholder = document.getElementById('cameraUploadPlaceholder');
  const countBadge = document.getElementById('photosCountBadge');

  const previewContainer = document.getElementById('cameraPreviewContainer');
  const previewImg = document.getElementById('cameraPreviewImg');

  const images = window.AppState.capturedImages || [];
  if (images.length === 0 && window.AppState.capturedImageBase64) {
    images.push(window.AppState.capturedImageBase64);
    window.AppState.capturedImages = images;
  }

  if (countBadge) {
    if (images.length > 0) {
      countBadge.textContent = `${images.length} تصویر الحاق‌شده`;
      countBadge.classList.remove('hidden');
    } else {
      countBadge.classList.add('hidden');
    }
  }

  if (images.length > 0) {
    if (galleryContainer) galleryContainer.classList.remove('hidden');
    if (uploadPlaceholder) uploadPlaceholder.classList.add('hidden');

    if (photosGrid) {
      photosGrid.innerHTML = '';
      images.forEach((dataUrl, idx) => {
        const photoCard = document.createElement('div');
        photoCard.className = 'group relative rounded-xl overflow-hidden border border-slate-700 bg-slate-950 shadow-md hover:border-amber-500/80 transition aspect-square';
        photoCard.innerHTML = `
          <img src="${dataUrl}" alt="عکس ${idx + 1}" class="w-full h-full object-cover cursor-pointer group-hover:scale-105 transition duration-300" onclick="openPhotoViewerModal('${idx}')">
          <div class="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition pointer-events-none flex items-center justify-center">
            <span class="p-2 bg-slate-900/80 rounded-full text-amber-400 shadow">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
            </span>
          </div>
          <div class="absolute top-2 right-2">
            <span class="px-2 py-0.5 rounded-md bg-slate-900/85 backdrop-blur-sm text-[10px] font-mono font-bold text-amber-300 border border-slate-700/80 shadow">
              #${idx + 1}
            </span>
          </div>
          <div class="absolute bottom-1.5 left-1.5 right-1.5 flex justify-between items-center">
            <button type="button" onclick="openPhotoViewerModal('${idx}')" class="px-2 py-0.5 bg-slate-900/85 hover:bg-slate-800 text-[11px] font-bold text-slate-200 rounded-md border border-slate-700 transition" title="بزرگ‌نمایی">
              مشاهده
            </button>
            <button type="button" onclick="removeSinglePhoto(${idx})" class="p-1 bg-red-950/90 hover:bg-red-900 text-red-300 rounded-md border border-red-800 transition" title="حذف این عکس">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        `;
        photosGrid.appendChild(photoCard);
      });
    }

    // سازگاری با عناصر قدیمی
    if (previewContainer) previewContainer.classList.remove('hidden');
    if (previewImg) previewImg.src = images[0];
  } else {
    if (galleryContainer) galleryContainer.classList.add('hidden');
    if (uploadPlaceholder) uploadPlaceholder.classList.remove('hidden');
    if (photosGrid) photosGrid.innerHTML = '';
    if (previewContainer) previewContainer.classList.add('hidden');
    if (previewImg) previewImg.src = '';
  }
}

function removeSinglePhoto(index) {
  if (!window.AppState.capturedImages) return;
  window.AppState.capturedImages.splice(index, 1);
  window.AppState.capturedImageBase64 = window.AppState.capturedImages.length > 0 ? window.AppState.capturedImages[0] : null;
  renderImagePreview();
  showToast('عکس مورد نظر حذف شد', 'info');
}

function removeAllCapturedPhotos() {
  window.AppState.capturedImages = [];
  window.AppState.capturedImageBase64 = null;
  const fileInput = document.getElementById('cameraFileInput');
  if (fileInput) fileInput.value = '';
  renderImagePreview();
  showToast('تمام عکس‌های الحاق‌شده حذف شدند', 'info');
}

function removeCapturedImage() {
  removeAllCapturedPhotos();
}

function openPhotoViewerModal(target) {
  let src = '';
  let indexStr = '';
  if (typeof target === 'number' || (!isNaN(target) && typeof target === 'string' && !target.startsWith('data:'))) {
    const idx = parseInt(target, 10);
    const images = window.AppState.capturedImages || [];
    src = images[idx] || '';
    indexStr = `تصویر شماره ${idx + 1} از ${images.length}`;
  } else {
    src = target;
    indexStr = 'تصویر تجهیز و محیط کار';
  }

  const modal = document.getElementById('photoViewerModal');
  const img = document.getElementById('photoViewerImg');
  const info = document.getElementById('photoViewerInfo');

  if (modal && img && src) {
    img.src = src;
    if (info) info.textContent = indexStr;
    modal.classList.remove('hidden');
  }
}

function closePhotoViewerModal() {
  const modal = document.getElementById('photoViewerModal');
  const img = document.getElementById('photoViewerImg');
  if (modal) modal.classList.add('hidden');
  if (img) img.src = '';
}

// انتشار سراسری توابع مدیریت عکس‌ها در window
window.renderImagePreview = renderImagePreview;
window.removeSinglePhoto = removeSinglePhoto;
window.removeAllCapturedPhotos = removeAllCapturedPhotos;
window.removeCapturedImage = removeCapturedImage;
window.openPhotoViewerModal = openPhotoViewerModal;
window.closePhotoViewerModal = closePhotoViewerModal;

// ==========================================
// ۸. اسکن بارکد و QR Code
// ==========================================
function openQrScannerModal(targetFieldId) {
  window.AppState.selectedQrTargetField = targetFieldId || 'asettInput';
  const modal = document.getElementById('qrScannerModal');
  const title = document.getElementById('qrModalTitle');
  if (title) {
    title.textContent = 'اسکن بارکد / QR کد تجهیز (ASETT ID)';
  }
  if (modal) modal.classList.remove('hidden');
  startQrVideoScan();
}

function closeQrScannerModal() {
  stopQrVideoScan();
  const modal = document.getElementById('qrScannerModal');
  if (modal) modal.classList.add('hidden');
  window.AppState.selectedQrTargetField = null;
}

async function startQrVideoScan() {
  const video = document.getElementById('qrVideo');
  const status = document.getElementById('qrScannerStatus');
  if (!video) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }
    });
    window.AppState.activeCameraStream = stream;
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    await video.play();

    if (status) status.textContent = 'دوربین فعال است؛ لطفاً بارکد را مقابل کادر نگاه دارید...';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let isBarcodeDetectorSupported = 'BarcodeDetector' in window;
    let detector = null;
    if (isBarcodeDetectorSupported) {
      try {
        detector = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'data_matrix'] });
      } catch (e) {
        detector = null;
      }
    }

    let isScanning = true;
    const scanLoop = async () => {
      if (!window.AppState.activeCameraStream || !isScanning) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        // ۱. تلاش با BarcodeDetector محلی
        if (detector) {
          try {
            const barcodes = await detector.detect(video);
            if (barcodes.length > 0 && barcodes[0].rawValue) {
              isScanning = false;
              handleQrCodeDetected(barcodes[0].rawValue);
              return;
            }
          } catch (e) {}
        }

        // ۲. اسکن با موتور فوق‌سریع jsQR
        if (window.jsQR && isScanning) {
          try {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const qrResult = window.jsQR(imgData.data, imgData.width, imgData.height, {
              inversionAttempts: 'attemptBoth'
            });
            if (qrResult && qrResult.data) {
              isScanning = false;
              handleQrCodeDetected(qrResult.data);
              return;
            }
          } catch (err) {}
        }
      }

      requestAnimationFrame(scanLoop);
    };

    requestAnimationFrame(scanLoop);
  } catch (err) {
    console.warn('Camera stream error:', err);
    if (status) status.textContent = 'امکان دسترسی به دوربین وجود ندارد. لطفاً مجوز دسترسی به دوربین را در مرورگر تایید کنید.';
  }
}

function stopQrVideoScan() {
  if (window.AppState.activeCameraStream) {
    window.AppState.activeCameraStream.getTracks().forEach((t) => t.stop());
    window.AppState.activeCameraStream = null;
  }
}

function handleQrCodeDetected(code) {
  if (navigator.vibrate) navigator.vibrate(120);
  const targetId = window.AppState.selectedQrTargetField || 'asettInput';
  const targetInput = document.getElementById(targetId);
  if (targetInput) {
    targetInput.value = code;
    targetInput.classList.add('ring-2', 'ring-amber-400');
    setTimeout(() => targetInput.classList.remove('ring-2', 'ring-amber-400'), 1500);

    const clearBtn = document.getElementById('clearAsettBtn');
    if (clearBtn) clearBtn.classList.remove('hidden');

    if (targetId === 'asettInput') {
      syncRebuildablesForAsett(code);
    }
  }
  showToast(`بارکد تجهیز با موفقیت اسکن شد: ${code}`, 'success');
  closeQrScannerModal();
}

function clearQrField(targetFieldId) {
  const targetInput = document.getElementById(targetFieldId);
  if (targetInput) {
    targetInput.value = '';
  }
  const clearBtn = document.getElementById('clearAsettBtn');
  if (clearBtn) clearBtn.classList.add('hidden');
  if (targetFieldId === 'asettInput') {
    syncRebuildablesForAsett('');
  }
  showToast('کد اسکن‌شده پاکسازی شد', 'info');
}

function normalizeSearchText(str) {
  if (!str) return '';
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/۰/g, '0').replace(/۱/g, '1').replace(/۲/g, '2').replace(/۳/g, '3').replace(/۴/g, '4')
    .replace(/۵/g, '5').replace(/۶/g, '6').replace(/۷/g, '7').replace(/۸/g, '8').replace(/۹/g, '9')
    .replace(/[\s\-_/\\,،.]+/g, ' ');
}

function handleAsettInput(inputEl) {
  const clearBtn = document.getElementById('clearAsettBtn');
  const val = inputEl ? inputEl.value.trim() : '';
  if (clearBtn) {
    if (val.length > 0) {
      clearBtn.classList.remove('hidden');
    } else {
      clearBtn.classList.add('hidden');
    }
  }
  if (window._asettDebounceTimer) clearTimeout(window._asettDebounceTimer);
  window._asettDebounceTimer = setTimeout(() => {
    syncRebuildablesForAsett(val);
  }, 40);
}

// ==========================================
// ۸.۱. منطق فرم کشویی قطعه قابل بازسازی (Rebuildable ID) و اتصال به دیتابیس ASETT
// ==========================================
var DEFAULT_ASSET_REBUILDABLES = [
  {
    asset: '41030DEMO',
    rebuildable: 'SD#14',
    description: 'دتکتور دوداتاق برق  سرپرستی مخابرات   واحد:واحد اعلام حریق',
    supervision: 'سرپرستی مخابرات',
    unit: 'واحد اعلام حریق',
    createdAt: '2026-09-30T00:00:00.000Z'
  },
  {
    asset: '14031DEM0',
    rebuildable: 'HD#15',
    description: 'دتکتور حرارت اتاق برق  سرپریتی مخابرات   واحد اعلام حریق',
    supervision: 'سرپرستی مخابرات',
    unit: 'واحد اعلام حریق',
    createdAt: '2026-09-30T00:00:00.000Z'
  }
];

async function ensureDefaultAssetRebuildables(existingRecords) {
  let records = Array.isArray(existingRecords) ? [...existingRecords] : [];
  let updated = false;

  for (const def of DEFAULT_ASSET_REBUILDABLES) {
    const normDefAsset = (def.asset || '').trim().toUpperCase();
    const normDefRebuild = (def.rebuildable || '').trim().toUpperCase();

    const existingIndex = records.findIndex(r => {
      const a = (r.asset || '').trim().toUpperCase();
      const reb = (r.rebuildable || '').trim().toUpperCase();
      return a === normDefAsset && reb === normDefRebuild;
    });

    if (existingIndex < 0) {
      const itemToSave = {
        ...def,
        createdAt: def.createdAt || new Date().toISOString()
      };
      try {
        const id = await saveAssetRebuildableRecordToDB(itemToSave);
        itemToSave.id = id;
      } catch (e) {
        itemToSave.id = Date.now() + Math.floor(Math.random() * 1000);
      }
      records.push(itemToSave);
      updated = true;
    } else {
      // بروزرسانی توضیحات و فیلدهای پیش‌فرض در صورت تغییر
      const current = records[existingIndex];
      if (current.description !== def.description || current.supervision !== def.supervision || current.unit !== def.unit) {
        records[existingIndex] = {
          ...current,
          description: def.description,
          supervision: def.supervision,
          unit: def.unit
        };
        try {
          await updateAssetRebuildableRecordInDB(records[existingIndex]);
        } catch (e) {}
        updated = true;
      }
    }
  }

  if (updated) {
    try {
      localStorage.setItem('automation_asset_rebuildables', JSON.stringify(records));
    } catch (e) {}
  }

  return records;
}

async function getOrFetchAllAssetRebuildables(forceRefresh = false) {
  if (!forceRefresh && window.AppState.assetRecords && window.AppState.assetRecords.length > 0) {
    return window.AppState.assetRecords;
  }
  try {
    let records = await getAllAssetRebuildableRecordsFromDB();
    const defaultRebuildables = [
      'کارت پردازنده اصلی CPU 414-4H',
      'ماژول ورودی/خروجی آنالوگ AI 8x13Bit',
      'پوزیشنر هوشمند Fisher DVC6200',
      'اکچویتور پنوماتیک دیافراگمی 657',
      'فرستنده-گیرنده UHF تله‌متری',
      'پاور ماژولار ریداندنت 12V 450W'
    ];
    if (records && records.length > 0) {
      const hasDefaults = records.some(r => defaultRebuildables.includes((r.rebuildable || '').trim()));
      if (hasDefaults) {
        records = records.filter(r => !defaultRebuildables.includes((r.rebuildable || '').trim()));
        localStorage.setItem('automation_asset_rebuildables', JSON.stringify(records));
      }
    }
    records = await ensureDefaultAssetRebuildables(records);
    window.AppState.assetRecords = records || [];
    return window.AppState.assetRecords;
  } catch (err) {
    console.warn('getOrFetchAllAssetRebuildables fallback:', err);
    return window.AppState.assetRecords || [];
  }
}

async function populateAsettDatalist() {
  try {
    const datalist = document.getElementById('asettDatalist');
    if (!datalist) return;
    const records = await getOrFetchAllAssetRebuildables();
    const op = window.AppState.operator;
    const opSupervision = (op?.supervision || '').trim();
    const opUnit = (op?.unit || '').trim();

    let prioritizedAssets = [];
    if (opSupervision || opUnit) {
      const unitScoped = records.filter(r => {
        let match = true;
        if (opSupervision && r.supervision && normalizeSearchText(r.supervision) !== normalizeSearchText(opSupervision)) {
          match = false;
        }
        if (opUnit && r.unit && normalizeSearchText(r.unit) !== normalizeSearchText(opUnit)) {
          match = false;
        }
        return match;
      });
      prioritizedAssets = Array.from(new Set(unitScoped.map(r => (r.asset || '').trim()).filter(Boolean)));
    }
    const allAssets = Array.from(new Set(records.map(r => (r.asset || '').trim()).filter(Boolean)));
    const uniqueAssets = Array.from(new Set([...prioritizedAssets, ...allAssets]));
    datalist.innerHTML = uniqueAssets.map(a => `<option value="${escapeHtml(a)}"></option>`).join('');
  } catch (err) {
    console.warn('populateAsettDatalist error:', err);
  }
}

async function syncRebuildablesForAsett(asettVal) {
  try {
    const inputEl = document.getElementById('asettInput');
    const rawVal = asettVal !== undefined ? asettVal : (inputEl ? inputEl.value : '');
    const asett = (rawVal || '').trim();

    const select = document.getElementById('rebuildableSelect');
    const badge = document.getElementById('rebuildableStatusBadge');
    const feedback = document.getElementById('asettFeedback');
    const detailBox = document.getElementById('rebuildableDetailBox');
    const clearBtn = document.getElementById('clearRebuildableSelectBtn');

    if (detailBox) detailBox.classList.add('hidden');
    if (clearBtn) clearBtn.classList.add('hidden');

    if (!select) return;

    if (!asett) {
      select.innerHTML = '<option value="">-- لطفاً ابتدا ASETT ID را وارد یا اسکن فرمایید --</option>';
      select.disabled = true;
      if (badge) {
        badge.className = 'text-[10px] text-slate-400 font-bold bg-slate-800/80 px-2 py-0.5 rounded border border-slate-700';
        badge.textContent = 'منتظر ورود ASETT ID';
      }
      if (feedback) {
        feedback.innerHTML = '';
        feedback.classList.add('hidden');
      }
      return;
    }

    // خواندن رکوردهای معتبر از دیتابیس
    const records = await getOrFetchAllAssetRebuildables(true);
    const cleanQuery = normalizeSearchText(asett);

    // ۱. تطبیق دقیق عنوان یا کد تجهیز با دیتابیس
    let matchedRecords = records.filter(r => r.asset && normalizeSearchText(r.asset) === cleanQuery);

    // ۲. در صورت عدم تطبیق دقیق (مانند اسکن بارکد با پیشوند/پسوند یا بخشی از نام تجهیز)، یافتن نزدیک‌ترین تجهیز منطبق
    if (matchedRecords.length === 0) {
      const candidates = records.filter(r => {
        if (!r.asset) return false;
        const norm = normalizeSearchText(r.asset);
        return norm.includes(cleanQuery) || cleanQuery.includes(norm);
      });
      if (candidates.length > 0) {
        candidates.sort((a, b) => Math.abs(normalizeSearchText(a.asset).length - cleanQuery.length) - Math.abs(normalizeSearchText(b.asset).length - cleanQuery.length));
        const bestAssetNorm = normalizeSearchText(candidates[0].asset);
        // منحصراً رکوردهای همان تجهیز انتخاب می‌شوند
        matchedRecords = records.filter(r => r.asset && normalizeSearchText(r.asset) === bestAssetNorm);
      }
    }

    // ۳. تطبیق بر اساس توکن‌های کلمات تجهیز
    if (matchedRecords.length === 0) {
      const queryTokens = cleanQuery.split(' ').filter(t => t.length >= 2);
      if (queryTokens.length > 0) {
        const tokenCandidates = records.filter(r => {
          if (!r.asset) return false;
          const norm = normalizeSearchText(r.asset);
          return queryTokens.every(tok => norm.includes(tok));
        });
        if (tokenCandidates.length > 0) {
          const bestAssetNorm = normalizeSearchText(tokenCandidates[0].asset);
          matchedRecords = records.filter(r => r.asset && normalizeSearchText(r.asset) === bestAssetNorm);
        }
      }
    }

    // ۴. تطبیق بر اساس شناسه عددی بارکد رکورد
    if (matchedRecords.length === 0) {
      const idMatch = records.filter(r => String(r.id) === asett);
      if (idMatch.length > 0) {
        const bestAssetNorm = normalizeSearchText(idMatch[0].asset);
        matchedRecords = records.filter(r => r.asset && normalizeSearchText(r.asset) === bestAssetNorm);
      }
    }

    select.disabled = false;

    // فقط قطعات منحصربه‌فرد متعلق به همین ASETT از دیتابیس خوانده و نمایش داده می‌شوند (حالت دستی طبق درخواست حذف گردید)
    if (matchedRecords.length > 0) {
      const uniqueRebuildables = [];
      const seenNames = new Set();
      matchedRecords.forEach(m => {
        const name = (m.rebuildable || '').trim();
        if (name && !seenNames.has(name)) {
          seenNames.add(name);
          uniqueRebuildables.push(m);
        }
      });

      let optionsHtml = '';
      uniqueRebuildables.forEach((m, idx) => {
        const desc = (m.description || '').trim();
        const unitLabel = [m.supervision, m.unit].filter(Boolean).join(' - ');
        const idVal = (m.rebuildable || '').trim();
        const label = desc ? `${idVal} - ${desc}` : idVal;
        optionsHtml += `<option value="${escapeHtml(idVal)}" data-desc="${escapeHtml(desc)}" data-unit="${escapeHtml(unitLabel)}" data-idx="${idx}">${escapeHtml(label)}</option>`;
      });
      select.innerHTML = optionsHtml;

      select.selectedIndex = 0;
      handleRebuildableSelectChange(select);

      const matchedAssetName = matchedRecords[0].asset || asett;
      if (badge) {
        badge.className = 'text-[10px] text-emerald-300 font-bold bg-emerald-500/15 px-2.5 py-1 rounded-lg border border-emerald-500/30 leading-normal break-words whitespace-normal text-right self-start sm:self-auto max-w-full shadow-sm';
        badge.textContent = `✓ ${uniqueRebuildables.length} قطعه اختصاصی (${matchedAssetName})`;
      }
      if (feedback) {
        feedback.innerHTML = '';
        feedback.classList.add('hidden');
      }
    } else {
      // در صورتی که برای این ASETT قطعه‌ای در دیتابیس ثبت نشده باشد (حالت دستی حذف شده است)
      let optionsHtml = '<option value="">-- هیچ قطعه‌ای در دیتابیس برای این تجهیز یافت نشد (ثبت دستی غیرفعال است) --</option>';
      select.innerHTML = optionsHtml;
      select.selectedIndex = 0;
      handleRebuildableSelectChange(select);

      if (badge) {
        badge.className = 'text-[10px] text-amber-300 font-bold bg-amber-500/15 px-2.5 py-1 rounded-lg border border-amber-500/30 leading-normal break-words whitespace-normal text-right self-start sm:self-auto max-w-full shadow-sm';
        badge.textContent = 'عدم وجود قطعه برای این ASETT';
      }
      if (feedback) {
        feedback.innerHTML = '';
        feedback.classList.add('hidden');
      }
    }
  } catch (err) {
    console.warn('syncRebuildablesForAsett error:', err);
  }
}

function handleRebuildableSelectChange(selectEl) {
  const val = selectEl ? selectEl.value : '';
  const detailBox = document.getElementById('rebuildableDetailBox');
  const clearBtn = document.getElementById('clearRebuildableSelectBtn');

  if (clearBtn) {
    if (val) clearBtn.classList.remove('hidden');
    else clearBtn.classList.add('hidden');
  }

  if (!val) {
    if (detailBox) detailBox.classList.add('hidden');
    return;
  }

  const selectedOpt = selectEl.options[selectEl.selectedIndex];
  const desc = selectedOpt ? selectedOpt.getAttribute('data-desc') : '';
  const unit = selectedOpt ? selectedOpt.getAttribute('data-unit') : '';

  if (detailBox) {
    const codeEl = document.getElementById('rebuildableDetailCode');
    const titleEl = document.getElementById('rebuildableDetailTitle');
    const unitEl = document.getElementById('rebuildableDetailUnit');
    const descEl = document.getElementById('rebuildableDetailDesc');

    if (codeEl) codeEl.textContent = val;
    if (titleEl) titleEl.textContent = (desc && desc.trim()) ? `قطعه انتخابی: ${val} (${desc})` : `قطعه انتخابی: ${val}`;
    if (unitEl) {
      if (unit && unit.trim()) {
        unitEl.textContent = `سازمان: ${unit}`;
        unitEl.classList.remove('hidden');
      } else {
        unitEl.textContent = '';
        unitEl.classList.add('hidden');
      }
    }
    if (descEl) {
      if (desc && desc.trim()) {
        descEl.textContent = desc;
        descEl.classList.remove('hidden');
      } else {
        descEl.textContent = val;
        descEl.classList.remove('hidden');
      }
    }
    detailBox.classList.remove('hidden');
  }
}

function clearRebuildableSelection() {
  const select = document.getElementById('rebuildableSelect');
  if (select) {
    select.value = '';
    handleRebuildableSelectChange(select);
  }
}

function getSelectedRebuildableValue() {
  const select = document.getElementById('rebuildableSelect');
  return select ? select.value.trim() : '';
}

function resetRebuildableSelect() {
  const select = document.getElementById('rebuildableSelect');
  if (select) {
    select.value = '';
    select.innerHTML = '<option value="">-- فقط انتخاب از لیست قطعات دیتابیس (ثبت دستی حذف گردید) --</option>';
    select.disabled = true;
  }
  const badge = document.getElementById('rebuildableStatusBadge');
  if (badge) {
    badge.className = 'text-[10px] text-slate-400 font-bold bg-slate-800/80 px-2.5 py-1 rounded-lg border border-slate-700 leading-normal break-words whitespace-normal text-right self-start sm:self-auto max-w-full shadow-sm';
    badge.textContent = 'منتظر ورود ASETT ID  شناسه محل فعالیت';
  }
  const feedback = document.getElementById('asettFeedback');
  if (feedback) {
    feedback.innerHTML = '';
    feedback.classList.add('hidden');
  }
  const detailBox = document.getElementById('rebuildableDetailBox');
  if (detailBox) detailBox.classList.add('hidden');
  const clearBtn = document.getElementById('clearRebuildableSelectBtn');
  if (clearBtn) clearBtn.classList.add('hidden');
}

// ==========================================
// ۹. ثبت و ذخیره‌سازی گراف در IndexedDB
// ==========================================
async function handleGraphFormSubmit(e) {
  e.preventDefault();

  if (!window.AppState.operator || !window.AppState.operator.personnelId) {
    showToast('لطفاً ابتدا مشخصات شخص (مجری) را ثبت نمایید', 'error');
    openModal('personnelModal');
    return;
  }

  const asettInputEl = document.getElementById('asettInput');
  const asett = asettInputEl ? asettInputEl.value.trim() : '';
  const rebuildable = getSelectedRebuildableValue();
  const reportNotesEl = document.getElementById('reportNotesInput');
  const reportNotes = reportNotesEl ? reportNotesEl.value.trim() : '';

  if (!rebuildable) {
    showToast('⚠️ ثبت گزارش بدون قطعه قابل بازسازی (Rebuildable ID) امکان‌پذیر نیست. لطفاً قطعه را از لیست کشویی انتخاب فرمایید.', 'error');
    const select = document.getElementById('rebuildableSelect');
    if (select && !select.disabled) {
      select.focus();
    } else {
      document.getElementById('asettInput')?.focus();
    }
    return;
  }
  
  // بررسی فعالیت‌های ثبت شده
  let activities = (window.AppState.addedActivities && window.AppState.addedActivities.length > 0)
    ? [...window.AppState.addedActivities]
    : [];

  const activitySelectVal = document.getElementById('activityTypeSelect')?.value.trim();

  // اگر هنوز در لیست خالی است اما در نوار کشویی مقداری انتخاب شده، خودکار ارزیابی و اضافه شود
  if (activities.length === 0) {
    if (activitySelectVal) {
      addSelectedActivity();
      activities = (window.AppState.addedActivities && window.AppState.addedActivities.length > 0)
        ? [...window.AppState.addedActivities]
        : [];
    }
  }

  if (activities.length === 0) {
    showToast('لطفاً نوع فعالیت انجام شده را انتخاب و با دکمه ADD اضافه فرمایید', 'error');
    document.getElementById('activityTypeSelect')?.focus();
    return;
  }

  const primaryActivity = activities[0];
  const activityTypeSummary = activities.map((a) => a.type).join(' | ');

  // تصاویر ثبت شده (پشتیبانی از چند عکس)
  const photos = (window.AppState.capturedImages && window.AppState.capturedImages.length > 0)
    ? [...window.AppState.capturedImages]
    : (window.AppState.capturedImageBase64 ? [window.AppState.capturedImageBase64] : []);
  const primaryPhoto = photos.length > 0 ? photos[0] : null;

  const isOnline = navigator.onLine;
  const now = new Date();
  const jalali = getFormattedJalali(now);

  // دریافت و محاسبه مدت زمان فعالیت (دستی یا ثبت‌شده از طریق کرنومتر)
  let durationHours = parseInt(toEnglishDigits(document.getElementById('durationHoursInput')?.value || ''), 10) || 0;
  let durationMinutes = parseInt(toEnglishDigits(document.getElementById('durationMinutesInput')?.value || ''), 10) || 0;
  let durationSeconds = parseInt(toEnglishDigits(document.getElementById('durationSecondsInput')?.value || ''), 10) || 0;

  // اگر ورودی‌های دستی خالی بودند اما کرنومتر دارای زمان اندازه‌گیری شده بود، خودکار خوانده شود
  if (durationHours === 0 && durationMinutes === 0 && durationSeconds === 0 && window.StopwatchState && window.StopwatchState.elapsedTime > 0) {
    const totalSec = Math.round(window.StopwatchState.elapsedTime / 1000);
    durationHours = Math.floor(totalSec / 3600);
    durationMinutes = Math.floor((totalSec % 3600) / 60);
    durationSeconds = totalSec % 60;
    const hrEl = document.getElementById('durationHoursInput');
    const minEl = document.getElementById('durationMinutesInput');
    const secEl = document.getElementById('durationSecondsInput');
    if (hrEl) hrEl.value = durationHours > 0 ? durationHours : '';
    if (minEl) minEl.value = durationMinutes;
    if (secEl) secEl.value = durationSeconds;
    updateDurationFormattedDisplay();
  }

  // اگر فعالیت‌های مستقل در لیست دارای زمان اختصاصی هستند و فیلدهای کلی خالی است، مجموع زمان‌ها محاسبه شود
  const actsWithTime = activities.filter(a => (a.durationTotalSeconds || 0) > 0);
  if (actsWithTime.length > 0 && durationHours === 0 && durationMinutes === 0 && durationSeconds === 0) {
    let sumSec = 0;
    actsWithTime.forEach(a => { sumSec += (a.durationTotalSeconds || 0); });
    durationHours = Math.floor(sumSec / 3600);
    durationMinutes = Math.floor((sumSec % 3600) / 60);
    durationSeconds = sumSec % 60;
  }

  // در صورت روشن بودن کرنومتر، متوقف گردد
  if (window.StopwatchState && window.StopwatchState.isRunning) {
    pauseStopwatch();
  }

  const durationTotalSeconds = (durationHours * 3600) + (durationMinutes * 60) + durationSeconds;
  let durationFormatted = '';
  let durationDigital = '';
  if (durationTotalSeconds > 0) {
    const parts = [];
    if (durationHours > 0) parts.push(`${durationHours} ساعت`);
    if (durationMinutes > 0) parts.push(`${durationMinutes} دقیقه`);
    if (durationSeconds > 0) parts.push(`${durationSeconds} ثانیه`);
    durationFormatted = parts.join(' و ') || (durationSeconds > 0 ? `${durationSeconds} ثانیه` : `${durationMinutes} دقیقه`);

    if (durationSeconds > 0) {
      if (durationHours > 0) {
        durationDigital = `${String(durationHours).padStart(2, '0')}:${String(durationMinutes).padStart(2, '0')}:${String(durationSeconds).padStart(2, '0')}`;
      } else {
        durationDigital = `${String(durationMinutes).padStart(2, '0')}:${String(durationSeconds).padStart(2, '0')}`;
      }
    } else {
      if (durationHours > 0) {
        durationDigital = `${String(durationHours).padStart(2, '0')}:${String(durationMinutes).padStart(2, '0')}`;
      } else {
        durationDigital = `00:${String(durationMinutes).padStart(2, '0')}`;
      }
    }
  }

  const graphRecord = {
    timestamp: now.getTime(),
    jalaliDate: jalali.dateNumStr,
    jalaliTime: jalali.timeStr,
    jalaliFull: jalali.fullPersian,
    operator: { ...window.AppState.operator },
    asett,
    rebuildable,
    photo: primaryPhoto,
    photos: photos,
    reportNotes: reportNotes || '', // توضیحات تکمیلی اختیاری است
    activityType: activityTypeSummary,
    activities: activities,
    conditionalFields: primaryActivity.conditionalFields || {},
    colleagues: [...window.AppState.colleagues],
    location: { ...window.AppState.currentLocation },
    durationHours: durationHours,
    durationMinutes: durationMinutes,
    durationSeconds: durationSeconds,
    durationTotalSeconds: durationTotalSeconds,
    durationFormatted: durationFormatted,
    durationDigital: durationDigital,
    durationMethod: (window.StopwatchState && window.StopwatchState.elapsedTime > 0) ? 'اتوماتیک (کرنومتر)' : (durationTotalSeconds > 0 ? 'دستی' : 'نامشخص'),
    syncStatus: isOnline ? 'synced' : 'pending',
    syncedAt: isOnline ? now.toISOString() : null
  };

  try {
    const id = await saveGraphRecord(graphRecord);
    showToast(
      isOnline
        ? `فعالیت شماره #${id} با موفقیت ثبت و همگام‌سازی شد.`
        : `فعالیت شماره #${id} به دلیل آفلاین بودن در حافظه ذخیره و در صف انتظار قرار گرفت.`,
      isOnline ? 'success' : 'warning'
    );

    try {
      resetGraphForm();
    } catch (resetErr) {
      console.warn('Error resetting graph form after record save:', resetErr);
    }
    if (typeof updatePendingQueueCount === 'function') updatePendingQueueCount();
  } catch (err) {
    console.error('Error saving record', err);
    showToast('خطا در ذخیره‌سازی رکورد در دیتابیس محلی', 'error');
  }
}

function resetGraphForm() {
  console.log('resetGraphForm v3.1.0 called');
  
  const safeSet = (id, val) => {
    try {
      const el = document.getElementById(id);
      if (el) {
        if (el.tagName === 'SELECT') {
          el.value = val || '';
        } else {
          el.value = val;
        }
      }
    } catch (e) {
      console.warn(`Error setting value for ${id}:`, e);
    }
  };
  
  const safeHide = (id) => {
    try {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    } catch (e) {
      console.warn(`Error hiding ${id}:`, e);
    }
  };

  const safeTry = (fn, name) => {
    try {
      if (typeof fn === 'function') fn();
    } catch (e) {
      console.warn(`Error in ${name}:`, e);
    }
  };

  // ۱. پاکسازی ورودی‌های متنی و کشویی
  safeSet('asettInput', '');
  safeHide('clearAsettBtn');
  safeTry(resetRebuildableSelect, 'resetRebuildableSelect');
  
  safeSet('reportNotesInput', '');
  safeSet('activityTypeSelect', '');
  safeSet('customActivityInput', '');
  safeSet('equipmentIdInput', '');
  safeSet('deviceTagInput', '');
  safeSet('referenceToolInput', '');
  safeSet('footageInput', '');
  safeSet('cameraFileInput', '');

  // ۲. پاکسازی منطق فعالیت‌ها و تصاویر
  safeTry(handleActivityChange, 'handleActivityChange');

  if (window.AppState) {
    try {
      window.AppState.addedActivities = [];
      window.AppState.capturedImages = [];
      window.AppState.capturedImageBase64 = null;
      window.AppState.colleagues = [];
    } catch (e) { console.warn('Error resetting AppState:', e); }
  }
  
  safeTry(renderAddedActivitiesList, 'renderAddedActivitiesList');
  safeTry(renderImagePreview, 'renderImagePreview');
  safeTry(renderColleaguesList, 'renderColleaguesList');

  // ۳. پاکسازی تمام ماژول‌های زمان و کرنومتر
  try {
    if (typeof clearDurationInputs === 'function') clearDurationInputs(true);
  } catch (e) { console.warn('Error in clearDurationInputs:', e); }
  
  try {
    if (typeof resetStopwatch === 'function') resetStopwatch(true);
  } catch (e) { console.warn('Error in resetStopwatch:', e); }
  
  try {
    if (typeof resetPendingActivityStopwatch === 'function') resetPendingActivityStopwatch();
  } catch (e) { console.warn('Error in resetPendingActivityStopwatch:', e); }
  
  try {
    if (typeof switchPendingTimeTab === 'function') switchPendingTimeTab('manual');
  } catch (e) { console.warn('Error in switchPendingTimeTab:', e); }

  // ۴. بروزرسانی ساعت و رابط کاربری
  safeTry(updateLiveClock, 'updateLiveClock');
  
  console.log('Form reset completed successfully v3.1.0');
}

// ==========================================
// ۱۰. مدیریت وضعیت آنلاین / آفلاین و همگام‌سازی
// ==========================================
function updateNetworkStatusIndicator() {
  const isOnline = navigator.onLine;
  const badge = document.getElementById('networkStatusBadge');
  const dot = document.getElementById('networkStatusDot');
  const text = document.getElementById('networkStatusText');

  if (isOnline) {
    // طبق درخواست کاربر عبارت «آنلاین» از سربرگ حذف گردید و در حالت آنلاین نشانگر مخفی است
    if (badge) badge.className = 'hidden';
    if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
    if (text) text.textContent = '';
  } else {
    if (badge) badge.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-amber-950/70 border border-amber-500/50 text-amber-300';
    if (dot) dot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-ping';
    if (text) text.textContent = 'آفلاین (محلی)';
  }
}

async function updatePendingQueueCount() {
  try {
    const records = await getAllGraphRecords();
    const pendingList = records.filter((r) => r.syncStatus === 'pending');
    const count = pendingList.length;

    const countEl = document.getElementById('pendingQueueCount');
    const badgeEl = document.getElementById('pendingQueueBadge');

    if (countEl) countEl.textContent = count;
    if (badgeEl) {
      if (count > 0) {
        badgeEl.classList.remove('hidden');
      } else {
        badgeEl.classList.add('hidden');
      }
    }
  } catch (e) {
    console.error('Queue count check error', e);
  }
}

async function syncPendingRecords() {
  if (!navigator.onLine) {
    showToast('در حال حاضر دسترسی به اینترنت مقدور نیست.', 'warning');
    return;
  }

  try {
    const records = await getAllGraphRecords();
    const pendingList = records.filter((r) => r.syncStatus === 'pending');

    if (pendingList.length === 0) {
      showToast('تمام گراف‌ها همگام‌سازی شده‌اند و صفی وجود ندارد.', 'info');
      return;
    }

    showToast(`در حال همگام‌سازی ${pendingList.length} رکورد با سرور...`, 'info');

    for (const rec of pendingList) {
      rec.syncStatus = 'synced';
      rec.syncedAt = new Date().toISOString();
      await updateGraphRecord(rec);
    }

    await updatePendingQueueCount();
    showToast(`همگام‌سازی موفق: تمام ${pendingList.length} رکورد ارسال شدند.`, 'success');
    if (window.AppState.currentView === 'admin') {
      loadAdminReports();
    }
  } catch (e) {
    console.error('Sync failed', e);
    showToast('خطا در همگام‌سازی رکوردها', 'error');
  }
}

window.addEventListener('online', () => {
  updateNetworkStatusIndicator();
  showToast('اتصال به اینترنت برقرار شد. در حال همگام‌سازی داده‌های صف...', 'info');
  syncPendingRecords();
});

window.addEventListener('offline', () => {
  updateNetworkStatusIndicator();
  showToast('ارتباط با شبکه قطع شد. سیستم در حالت آفلاین فعال است.', 'warning');
});

// ==========================================
// ۱۱. ساعت و تاریخ زنده
// ==========================================
function updateLiveClock() {
  const clockEl = document.getElementById('liveJalaliDateText');
  if (clockEl) {
    const jalali = getFormattedJalali();
    clockEl.textContent = jalali.fullPersian;
  }
}

// ==========================================
// ۱۱.۱. ماژول زمان فعالیت و کرنومتر صنعتی (Stopwatch)
// ==========================================
window.StopwatchState = {
  isRunning: false,
  startTime: 0,
  elapsedTime: 0, // بر حسب میلی‌ثانیه
  timerInterval: null,
  targetActivityId: null
};

function formatTwoDigits(n) {
  const num = Math.floor(Math.max(0, Number(n) || 0));
  return String(num).padStart(2, '0');
}

function updateStopwatchDisplay() {
  const totalMs = Math.max(0, window.StopwatchState.elapsedTime || 0);
  const totalSeconds = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor((totalMs % 1000) / 10);

  const hrStr = formatTwoDigits(hours);
  const minStr = formatTwoDigits(minutes);
  const secStr = formatTwoDigits(seconds);
  const msStr = formatTwoDigits(millis);

  // نمایش در مودال پاپ‌آپ
  const hrEl = document.getElementById('swHours');
  const minEl = document.getElementById('swMinutes');
  const secEl = document.getElementById('swSeconds');
  const msEl = document.getElementById('swMillis');
  if (hrEl) hrEl.textContent = hrStr;
  if (minEl) minEl.textContent = minStr;
  if (secEl) secEl.textContent = secStr;
  if (msEl) msEl.textContent = msStr;

  // نمایش در پنل بازشونده درون کارت
  const cardHrEl = document.getElementById('cardSwHours');
  const cardMinEl = document.getElementById('cardSwMinutes');
  const cardSecEl = document.getElementById('cardSwSeconds');
  const cardMsEl = document.getElementById('cardSwMillis');
  if (cardHrEl) cardHrEl.textContent = hrStr;
  if (cardMinEl) cardMinEl.textContent = minStr;
  if (cardSecEl) cardSecEl.textContent = secStr;
  if (cardMsEl) cardMsEl.textContent = msStr;

  // نمایش در نوار کوچک وضعیت
  const miniDisp = document.getElementById('stopwatchMiniDisplay');
  if (miniDisp) {
    miniDisp.textContent = hours > 0 ? `${hrStr}:${minStr}:${secStr}` : `${minStr}:${secStr}`;
  }
}

function toggleStopwatchStartPause() {
  if (window.StopwatchState.isRunning) {
    pauseStopwatch();
  } else {
    startStopwatch();
  }
}

/**
 * همگام‌سازی و ثبت کاملاً خودکار زمان اندازه‌گیری شده کرنومتر در فیلدهای فرم فعالیت یا فعالیت اختصاصی
 */
function syncStopwatchTimeToFormInputs(showToastNotification = false) {
  const totalMs = Math.max(0, window.StopwatchState.elapsedTime || 0);
  const totalSeconds = Math.round(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  // اگر کرنومتر برای یک فعالیت اختصاصی مشخص راه‌اندازی شده باشد
  if (window.StopwatchState.targetActivityId && window.AppState.addedActivities) {
    const targetAct = window.AppState.addedActivities.find(a => a.id === window.StopwatchState.targetActivityId);
    if (targetAct) {
      targetAct.durationHours = hours;
      targetAct.durationMinutes = minutes;
      targetAct.durationSeconds = seconds;
      targetAct.durationTotalSeconds = totalSeconds;

      const parts = [];
      if (hours > 0) parts.push(`${hours} ساعت`);
      if (minutes > 0) parts.push(`${minutes} دقیقه`);
      if (seconds > 0 && hours === 0) parts.push(`${seconds} ثانیه`);
      targetAct.durationFormatted = parts.join(' و ') || (seconds > 0 ? `${seconds} ثانیه` : `${minutes} دقیقه`);
      targetAct.durationDigital = hours > 0
        ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
        : `00:${String(minutes).padStart(2, '0')}`;
      targetAct.durationMethod = 'کرنومتر';

      // بروزرسانی فیلدهای کارت درون صفحه بدون از بین بردن فوکوس کاربر
      const cardHr = document.getElementById(`actCardHr_${targetAct.id}`);
      const cardMin = document.getElementById(`actCardMin_${targetAct.id}`);
      if (cardHr && document.activeElement !== cardHr) cardHr.value = hours > 0 ? hours : '';
      if (cardMin && document.activeElement !== cardMin) cardMin.value = minutes;

      const cardBadge = document.getElementById(`actCardBadge_${targetAct.id}`);
      if (cardBadge) {
        cardBadge.innerHTML = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 shadow-sm"><svg class="w-3.5 h-3.5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span>${escapeHtml(targetAct.durationFormatted || targetAct.durationDigital)}</span><span class="text-[10px] text-emerald-400/80 font-sans font-normal border-r border-emerald-500/40 pr-1.5 mr-0.5">(${escapeHtml(targetAct.durationMethod)})</span></span>`;
      }

      recalculateTotalActivitiesDuration();

      if (showToastNotification && totalSeconds > 0) {
        showToast(`✓ مدت زمان (${targetAct.durationFormatted}) برای فعالیت «${targetAct.type}» ثبت شد.`, 'success');
      }
      return;
    }
  }

  const hrInput = document.getElementById('durationHoursInput');
  const minInput = document.getElementById('durationMinutesInput');
  const secInput = document.getElementById('durationSecondsInput');

  if (hrInput) hrInput.value = hours > 0 ? hours : '';
  if (minInput) minInput.value = minutes;
  if (secInput) secInput.value = seconds;

  updateDurationFormattedDisplay();

  if (showToastNotification && totalSeconds > 0) {
    const parts = [];
    if (hours > 0) parts.push(`${hours} ساعت`);
    if (minutes > 0) parts.push(`${minutes} دقیقه`);
    if (seconds > 0 && hours === 0) parts.push(`${seconds} ثانیه`);
    const formatted = parts.join(' و ') || `${seconds} ثانیه`;
    showToast(`✓ مدت زمان (${formatted}) به‌صورت خودکار در فرم ثبت گردید.`, 'success');
  }
}

function startStopwatch() {
  if (window.StopwatchState.isRunning) return;
  window.StopwatchState.isRunning = true;
  window.StopwatchState.startTime = Date.now() - (window.StopwatchState.elapsedTime || 0);

  if (window.StopwatchState.timerInterval) {
    clearInterval(window.StopwatchState.timerInterval);
  }

  let lastSyncSec = -1;
  window.StopwatchState.timerInterval = setInterval(() => {
    window.StopwatchState.elapsedTime = Math.max(0, Date.now() - window.StopwatchState.startTime);
    updateStopwatchDisplay();

    // همگام‌سازی و ثبت خودکار لحظه‌ای در فرم با هر ثانیه پیشروی کرنومتر
    const currentSec = Math.floor(window.StopwatchState.elapsedTime / 1000);
    if (currentSec !== lastSyncSec) {
      lastSyncSec = currentSec;
      syncStopwatchTimeToFormInputs(false);
    }
  }, 40);

  updateStopwatchUIState(true);
}

function pauseStopwatch() {
  if (!window.StopwatchState.isRunning) return;
  window.StopwatchState.isRunning = false;
  if (window.StopwatchState.timerInterval) {
    clearInterval(window.StopwatchState.timerInterval);
    window.StopwatchState.timerInterval = null;
  }
  if (window.StopwatchState.startTime > 0) {
    window.StopwatchState.elapsedTime = Math.max(0, Date.now() - window.StopwatchState.startTime);
  }
  updateStopwatchDisplay();
  updateStopwatchUIState(false);

  // ثبت خودکار و قطعی زمان به محض توقف
  syncStopwatchTimeToFormInputs(true);
}

function resetStopwatch(silent = false) {
  pauseStopwatch();
  window.StopwatchState.elapsedTime = 0;
  window.StopwatchState.startTime = 0;
  updateStopwatchDisplay();
  const setHour = document.getElementById('swSetHoursInput');
  const setMin = document.getElementById('swSetMinutesInput');
  const setSec = document.getElementById('swSetSecondsInput');
  if (setHour) setHour.value = '';
  if (setMin) setMin.value = '';
  if (setSec) setSec.value = '';
  updateStopwatchUIState(false);
  clearDurationInputs();
  if (!silent) {
    showToast('زمان کرنومتر صفر شد (RESET).', 'info');
  }
}

/**
 * کلید هوشمند SET:
 * ۱. اگر کاربر در فیلدهای تنظیم دستی مودال مقداری وارد کرده باشد -> کرنومتر بر اساس آن تنظیم می‌شود.
 * ۲. اگر کرنومتر در حال کار بوده یا زمانی اندازه‌گیری کرده باشد -> زمان فعلی روی فیلدهای ساعت، دقیقه و ثانیه فرم ثبت می‌شود.
 * ۳. اگر کرنومتر صفر باشد و فیلدهای فرم مقداری داشته باشند -> کرنومتر بر اساس مقادیر فرم تنظیم می‌شود.
 */
function handleStopwatchSet(customHour, customMin, customSec) {
  let hourVal = (customHour !== undefined && customHour !== null) ? parseInt(toEnglishDigits(String(customHour)), 10) : null;
  let minVal = (customMin !== undefined && customMin !== null) ? parseInt(toEnglishDigits(String(customMin)), 10) : null;
  let secVal = (customSec !== undefined && customSec !== null) ? parseInt(toEnglishDigits(String(customSec)), 10) : null;

  // ۱. بررسی ورودی‌های تنظیم در مودال (swSetHoursInput, swSetMinutesInput, swSetSecondsInput)
  if (hourVal === null || isNaN(hourVal)) {
    const swHrEl = document.getElementById('swSetHoursInput');
    if (swHrEl && swHrEl.value.trim() !== '') {
      hourVal = parseInt(toEnglishDigits(swHrEl.value.trim()), 10);
    }
  }
  if (minVal === null || isNaN(minVal)) {
    const swMinEl = document.getElementById('swSetMinutesInput');
    if (swMinEl && swMinEl.value.trim() !== '') {
      minVal = parseInt(toEnglishDigits(swMinEl.value.trim()), 10);
    }
  }
  if (secVal === null || isNaN(secVal)) {
    const swSecEl = document.getElementById('swSetSecondsInput');
    if (swSecEl && swSecEl.value.trim() !== '') {
      secVal = parseInt(toEnglishDigits(swSecEl.value.trim()), 10);
    }
  }

  // ۲. اگر مقادیر دلخواه دستی وارد شده باشد -> کرنومتر بر اساس آن مقداردهی اولیه می‌شود
  const totalInputSec = ((hourVal || 0) * 3600) + ((minVal || 0) * 60) + (secVal || 0);
  if (totalInputSec > 0) {
    pauseStopwatch();
    const h = Math.max(0, hourVal || 0);
    const m = Math.max(0, minVal || 0);
    const s = Math.max(0, Math.min(59, secVal || 0));
    window.StopwatchState.elapsedTime = ((h * 3600) + (m * 60) + s) * 1000;
    window.StopwatchState.startTime = Date.now() - window.StopwatchState.elapsedTime;
    updateStopwatchDisplay();

    // همزمان ورودی‌های فرم اصلی را هم تنظیم می‌کنیم
    const formHr = document.getElementById('durationHoursInput');
    const formMin = document.getElementById('durationMinutesInput');
    const formSec = document.getElementById('durationSecondsInput');
    if (formHr) formHr.value = h > 0 ? h : '';
    if (formMin) formMin.value = m;
    if (formSec) formSec.value = s;
    updateDurationFormattedDisplay();

    const parts = [];
    if (h > 0) parts.push(`${h} ساعت`);
    if (m > 0) parts.push(`${m} دقیقه`);
    if (s > 0 && h === 0) parts.push(`${s} ثانیه`);
    const formatted = parts.join(' و ') || `${s} ثانیه`;

    showToast(`زمان کرنومتر روی ${formatted} تنظیم (SET) شد.`, 'info');
    return;
  }

  // ۳. اگر کرنومتر زمانی اندازه‌گیری کرده باشد (یا در حال کار باشد)
  if (window.StopwatchState.elapsedTime > 0) {
    applyStopwatchTimeToForm();
    return;
  }

  showToast('لطفاً دکمه شروع کرنومتر را بزنید یا ساعت و دقیقه مورد نظر را وارد نمایید.', 'info');
}

function syncStopwatchFromFormInputs() {
  // بر اساس درخواست: مقادیر وارد شده به صورت دستی در ماژول زمان به زمان شروع کرنومتر اضافه نمی‌شوند و کرنومتر همواره از صفر آغاز می‌گردد
}

function applyStopwatchTimeToForm() {
  if (window.StopwatchState.isRunning) {
    pauseStopwatch();
  } else {
    syncStopwatchTimeToFormInputs(true);
  }

  closeStopwatchModal();

  const panel = document.getElementById('stopwatchEmbeddedPanel');
  const btnText = document.getElementById('openStopwatchBtnText');
  if (panel && !panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    panel.classList.remove('stopwatch-3d-rotate');
    if (btnText) btnText.textContent = 'کرنومتر دیجیتال (ثبت خودکار)';
  }
}

/**
 * ذخیره مدت زمان فعالیت (دکمه اختصاصی ذخیره در ماژول مدت زمان فعالیت)
 */
function saveDurationTime() {
  let durationHours = parseInt(toEnglishDigits(document.getElementById('durationHoursInput')?.value || ''), 10) || 0;
  let durationMinutes = parseInt(toEnglishDigits(document.getElementById('durationMinutesInput')?.value || ''), 10) || 0;
  let durationSeconds = parseInt(toEnglishDigits(document.getElementById('durationSecondsInput')?.value || ''), 10) || 0;

  let totalSec = (durationHours * 3600) + (durationMinutes * 60) + durationSeconds;

  // اگر ورودی‌های دستی خالی بودند اما کرنومتر دارای زمان اندازه‌گیری شده بود، از کرنومتر استخراج گردد
  if (totalSec === 0 && window.StopwatchState && window.StopwatchState.elapsedTime > 0) {
    if (window.StopwatchState.isRunning) {
      pauseStopwatch();
    }
    const elapsedSec = Math.round(window.StopwatchState.elapsedTime / 1000);
    durationHours = Math.floor(elapsedSec / 3600);
    durationMinutes = Math.floor((elapsedSec % 3600) / 60);
    durationSeconds = elapsedSec % 60;

    const hrEl = document.getElementById('durationHoursInput');
    const minEl = document.getElementById('durationMinutesInput');
    const secEl = document.getElementById('durationSecondsInput');
    if (hrEl) hrEl.value = durationHours > 0 ? durationHours : '';
    if (minEl) minEl.value = durationMinutes;
    if (secEl) secEl.value = durationSeconds;

    totalSec = elapsedSec;
  }

  if (totalSec === 0) {
    showToast('لطفاً ساعت و دقیقه را به صورت دستی وارد نمایید یا با دکمه کرنومتر زمان را ثبت فرمایید.', 'warning');
    return;
  }

  updateDurationFormattedDisplay();

  const parts = [];
  if (durationHours > 0) parts.push(`${durationHours} ساعت`);
  if (durationMinutes > 0) parts.push(`${durationMinutes} دقیقه`);
  if (durationSeconds > 0) parts.push(`${durationSeconds} ثانیه`);
  const formatted = parts.join(' و ') || (durationSeconds > 0 ? `${durationSeconds} ثانیه` : `${durationMinutes} دقیقه`);

  showToast(`مدت زمان فعالیت با موفقیت ذخیره شد: ${formatted}`, 'success');
}

/**
 * باز یا بسته کردن پنل بازشونده مستقیم کرنومتر درون کارت با جلوه سه‌بعدی چرخشی
 */
function toggleStopwatchPanel() {
  const panel = document.getElementById('stopwatchEmbeddedPanel');
  const btn = document.getElementById('openStopwatchBtn');
  const btnText = document.getElementById('openStopwatchBtnText');
  if (!panel) {
    openStopwatchModal();
    return;
  }

  const isHidden = panel.classList.contains('hidden');
  if (isHidden) {
    panel.classList.remove('hidden');
    // اعمال انیمیشن سه‌بعدی چرخشی جذاب با هر بار باز شدن
    panel.classList.remove('stopwatch-3d-rotate');
    void panel.offsetWidth;
    panel.classList.add('stopwatch-3d-rotate');

    // چرخش سه‌بعدی آیکون دکمه
    const btnIcon = btn ? btn.querySelector('svg') : null;
    if (btnIcon) {
      btnIcon.classList.remove('spin-3d-btn');
      void btnIcon.offsetWidth;
      btnIcon.classList.add('spin-3d-btn');
    }

    if (btnText) btnText.textContent = 'بستن کرنومتر ✕';

    // مقدار دستی وارد شده به هیچ عنوان به کرنومتر اضافه نمی‌شود و کرنومتر از صفر (یا زمان قبلی خودش) شروع می‌شود
    updateStopwatchDisplay();
    updateStopwatchUIState(window.StopwatchState.isRunning);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    panel.classList.add('hidden');
    panel.classList.remove('stopwatch-3d-rotate');
    if (btnText) btnText.textContent = 'کرنومتر دیجیتال (ثبت خودکار)';
    if (window.StopwatchState && window.StopwatchState.elapsedTime > 0) {
      syncStopwatchTimeToFormInputs(false);
    }
  }
}
window.toggleStopwatchPanel = toggleStopwatchPanel;

function openStopwatchModal() {
  const modal = document.getElementById('stopwatchModal');
  if (modal) {
    modal.classList.remove('hidden');
    const modalBox = modal.querySelector('.bg-slate-900') || modal.firstElementChild;
    if (modalBox) {
      modalBox.classList.remove('stopwatch-3d-rotate');
      void modalBox.offsetWidth;
      modalBox.classList.add('stopwatch-3d-rotate');
    }
    // زمان دستی به کرنومتر اضافه نمی‌شود و کرنومتر از صفر آغاز می‌گردد
    updateStopwatchDisplay();
    updateStopwatchUIState(window.StopwatchState.isRunning);
  }
}
window.openStopwatchModal = openStopwatchModal;

function closeStopwatchModal() {
  const modal = document.getElementById('stopwatchModal');
  if (modal) modal.classList.add('hidden');
  // ثبت خودکار زمان اندازه‌گیری شده به محض بستن مودال
  if (window.StopwatchState && window.StopwatchState.elapsedTime > 0) {
    syncStopwatchTimeToFormInputs(false);
  }
}
window.closeStopwatchModal = closeStopwatchModal;

function updateStopwatchUIState(isRunning) {
  // بروزرسانی همزمان دکمه‌ها در پنل کارت و در مودال
  ['sw', 'cardSw'].forEach(prefix => {
    const btn = document.getElementById(`${prefix}StartPauseBtn`);
    const text = document.getElementById(`${prefix}StartPauseText`);
    const iconStart = document.getElementById(`${prefix}StartIcon`);
    const iconPause = document.getElementById(`${prefix}PauseIcon`);
    const statusDot = document.getElementById(`${prefix}StatusDot`);
    const statusText = document.getElementById(`${prefix}StatusText`);

    if (isRunning) {
      if (text) text.textContent = 'توقف و ثبت خودکار زمان ⏸';
      if (iconStart) iconStart.classList.add('hidden');
      if (iconPause) iconPause.classList.remove('hidden');
      if (btn) {
        btn.classList.remove('from-emerald-500', 'to-teal-600', 'hover:from-emerald-400');
        btn.classList.add('from-amber-500', 'to-amber-600', 'hover:from-amber-400');
      }
      if (statusDot) {
        statusDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse';
      }
      if (statusText) {
        statusText.textContent = 'در حال زمان‌سنجی... (ثبت خودکار لحظه‌ای)';
        statusText.className = 'text-emerald-400 font-bold';
      }
    } else {
      const hasTime = window.StopwatchState && window.StopwatchState.elapsedTime > 0;
      if (text) text.textContent = hasTime ? 'ادامه زمان‌سنجی (ثبت خودکار)' : 'شروع اندازه‌گیری زمان (ثبت خودکار)';
      if (iconStart) iconStart.classList.remove('hidden');
      if (iconPause) iconPause.classList.add('hidden');
      if (btn) {
        btn.classList.remove('from-amber-500', 'to-amber-600', 'hover:from-amber-400');
        btn.classList.add('from-emerald-500', 'to-teal-600', 'hover:from-emerald-400');
      }
      if (statusDot) {
        statusDot.className = hasTime ? 'w-2.5 h-2.5 rounded-full bg-emerald-400' : 'w-2.5 h-2.5 rounded-full bg-slate-500';
      }
      if (statusText) {
        statusText.textContent = hasTime ? 'زمان متوقف و در فرم ثبت شد ✓' : 'آماده زمان‌سنجی (ثبت خودکار)';
        statusText.className = hasTime ? 'text-emerald-300 font-bold' : 'text-slate-400 font-medium';
      }
    }
  });

  const indicator = document.getElementById('stopwatchRunningIndicator');
  if (indicator) {
    if (isRunning) {
      indicator.classList.remove('hidden');
      indicator.classList.add('inline-flex');
    } else {
      const hasTime = window.StopwatchState && window.StopwatchState.elapsedTime > 0;
      if (hasTime) {
        indicator.classList.remove('hidden');
        indicator.classList.add('inline-flex');
      } else {
        indicator.classList.add('hidden');
        indicator.classList.remove('inline-flex');
      }
    }
  }
}

// گوش دادن به تغییر دید تب برای همگام‌سازی فوری زمان پس از قفل گوشی یا بازگشت به تب
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && window.StopwatchState && window.StopwatchState.isRunning) {
    window.StopwatchState.elapsedTime = Math.max(0, Date.now() - window.StopwatchState.startTime);
    updateStopwatchDisplay();
  }
});

function updateDurationFormattedDisplay() {
  const hrInput = document.getElementById('durationHoursInput');
  const minInput = document.getElementById('durationMinutesInput');
  const secInput = document.getElementById('durationSecondsInput');

  const hrVal = parseInt(toEnglishDigits(hrInput?.value || ''), 10) || 0;
  const minVal = parseInt(toEnglishDigits(minInput?.value || ''), 10) || 0;
  const secVal = parseInt(toEnglishDigits(secInput?.value || ''), 10) || 0;
  const badge = document.getElementById('durationSummaryBadge');
  const text = document.getElementById('durationFormattedText');
  const digital = document.getElementById('durationDigitalText');

  const totalSeconds = (hrVal * 3600) + (minVal * 60) + secVal;

  if (totalSeconds > 0) {
    if (badge) {
      badge.classList.remove('hidden');
      badge.classList.add('flex');
    }
    const parts = [];
    if (hrVal > 0) parts.push(`${hrVal} ساعت`);
    if (minVal > 0) parts.push(`${minVal} دقیقه`);
    if (secVal > 0) parts.push(`${secVal} ثانیه`);
    const formatted = parts.join(' و ') || (secVal > 0 ? `${secVal} ثانیه` : `${minVal} دقیقه`);

    if (text) text.textContent = formatted;
    if (digital) {
      if (secVal > 0) {
        // برای کرنومتر (شامل ثانیه)
        if (hrVal > 0) {
          digital.textContent = `${formatTwoDigits(hrVal)}:${formatTwoDigits(minVal)}:${formatTwoDigits(secVal)}`;
        } else {
          digital.textContent = `${formatTwoDigits(minVal)}:${formatTwoDigits(secVal)}`;
        }
      } else {
        // برای ثبت دستی زمان (فقط ساعت و دقیقه)
        if (hrVal > 0) {
          digital.textContent = `${formatTwoDigits(hrVal)}:${formatTwoDigits(minVal)}`;
        } else {
          digital.textContent = `00:${formatTwoDigits(minVal)}`;
        }
      }
    }
  } else {
    if (badge) {
      badge.classList.add('hidden');
      badge.classList.remove('flex');
    }
  }
}

function clearDurationInputs(silent = false) {
  const hrInput = document.getElementById('durationHoursInput');
  const minInput = document.getElementById('durationMinutesInput');
  const secInput = document.getElementById('durationSecondsInput');
  if (hrInput) hrInput.value = '';
  if (minInput) minInput.value = '';
  if (secInput) secInput.value = '';
  updateDurationFormattedDisplay();
  if (!silent) {
    showToast('مقادیر زمان فعالیت پاکسازی شد.', 'info');
  }
}

// ==========================================
// ۱۲. احراز هویت و ورود به پنل ادمین
// ==========================================
var SUPER_ADMIN = {
  username: 'admin',
  password: 'Ehsan2559',
  fullName: 'احسان ابوالقاسمی (مدیر نرم افزار )',
  isSuperAdmin: true,
  unit: 'کل واحدها',
  supervision: 'کل سرپرستی‌ها',
  permissions: {
    orgManage: true,
    adminManage: true,
    backup: true,
    personnelManage: true,
    assetRebuildable: true
  }
};

var MANAGER_ADMIN = {
  username: '417734',
  password: '3344',
  fullName: 'مهندس محسن جعفری (مدیراتوماسیون و ارتباطات )',
  isSuperAdmin: true,
  unit: 'کل واحدها',
  supervision: 'کل سرپرستی‌ها',
  permissions: {
    orgManage: true,
    adminManage: true,
    backup: true,
    personnelManage: true,
    assetRebuildable: true
  }
};

function isMasterAdmin(user) {
  if (!user) user = window.AppState ? window.AppState.currentUser : null;
  if (!user) {
    try {
      const stored = sessionStorage.getItem('automation_admin_session');
      if (stored) user = JSON.parse(stored);
    } catch (e) {}
  }
  if (!user) return true; // دسترسی پیش‌فرض در صورت عدم تعیین کاربر
  return user.username === 'admin' || user.username === '417734' || user.username === '417737' || user.isSuperAdmin === true;
}

function canAccessOrgManage(user) {
  if (isMasterAdmin(user)) return true;
  if (!user) user = window.AppState ? window.AppState.currentUser : null;
  return !!(user && user.permissions && user.permissions.orgManage);
}

function canAccessAdminManage(user) {
  if (isMasterAdmin(user)) return true;
  if (!user) user = window.AppState ? window.AppState.currentUser : null;
  return !!(user && user.permissions && user.permissions.adminManage);
}

function canAccessBackup(user) {
  if (isMasterAdmin(user)) return true;
  if (!user) user = window.AppState ? window.AppState.currentUser : null;
  return !!(user && user.permissions && user.permissions.backup);
}

function canAccessPersonnelManage(user) {
  if (isMasterAdmin(user)) return true;
  if (!user) user = window.AppState ? window.AppState.currentUser : null;
  return !!(user && user.permissions && user.permissions.personnelManage);
}

function canAccessAssetRebuildable(user) {
  if (isMasterAdmin(user)) return true;
  if (!user) user = window.AppState ? window.AppState.currentUser : null;
  return user && user.permissions ? user.permissions.assetRebuildable !== false : true;
}

window.isMasterAdmin = isMasterAdmin;
window.canAccessOrgManage = canAccessOrgManage;
window.canAccessAdminManage = canAccessAdminManage;
window.canAccessBackup = canAccessBackup;
window.canAccessPersonnelManage = canAccessPersonnelManage;
window.canAccessAssetRebuildable = canAccessAssetRebuildable;

function checkAdminAuthSession() {
  const stored = sessionStorage.getItem('automation_admin_session');
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed) {
        if (parsed.username === '417734' || parsed.username === '417737') {
          window.AppState.currentUser = MANAGER_ADMIN;
        } else if (parsed.username === 'admin') {
          window.AppState.currentUser = SUPER_ADMIN;
        } else if (parsed.isSuperAdmin) {
          window.AppState.currentUser = parsed;
        } else {
          window.AppState.currentUser = parsed;
        }
        return true;
      }
    } catch (e) {
      sessionStorage.removeItem('automation_admin_session');
    }
  }
  return false;
}

// ==========================================
// بنر ۳ ثانیه‌ای ورود به صفحه مدیران با تیتر اختصاصی
// ==========================================
var adminWelcomeBannerTimer = null;
var adminWelcomeBannerInterval = null;

function showAdminWelcomeBanner(displayName) {
  const banner = document.getElementById('adminWelcomeBanner');
  const titleEl = document.getElementById('adminWelcomeBannerTitle');
  const progressBar = document.getElementById('adminWelcomeBannerProgressBar');
  const countdownEl = document.getElementById('adminWelcomeBannerCountdown');

  if (!banner || !titleEl) return;

  if (adminWelcomeBannerTimer) {
    clearTimeout(adminWelcomeBannerTimer);
    adminWelcomeBannerTimer = null;
  }
  if (adminWelcomeBannerInterval) {
    clearInterval(adminWelcomeBannerInterval);
    adminWelcomeBannerInterval = null;
  }

  // تیتر دقیقاً مطابق با متن درخواستی کاربر:
  // "{نام کاربر} عزیز به سیستم ثبت گراف مدیریت اتوماسیون و ارتباطات خوش آمدید"
  titleEl.textContent = `${displayName} عزیز به سیستم ثبت گراف مدیریت اتوماسیون و ارتباطات خوش آمدید`;

  // بازنشانی وضعیت اولیه نوار و شمارنده
  if (countdownEl) countdownEl.textContent = '۳ ثانیه';
  if (progressBar) {
    progressBar.style.transition = 'none';
    progressBar.style.width = '100%';
  }

  banner.classList.remove('hidden');
  banner.classList.remove('translate-y-0', 'opacity-100');
  banner.classList.add('-translate-y-2', 'opacity-0');

  // اجرای انیمیشن ورود و نوار پیشرفت
  setTimeout(() => {
    banner.classList.remove('-translate-y-2', 'opacity-0');
    banner.classList.add('translate-y-0', 'opacity-100');

    setTimeout(() => {
      if (progressBar) {
        progressBar.style.transition = 'width 3000ms linear';
        progressBar.style.width = '0%';
      }
    }, 40);
  }, 20);

  let remaining = 3;
  adminWelcomeBannerInterval = setInterval(() => {
    remaining--;
    if (countdownEl) {
      if (remaining > 0) {
        countdownEl.textContent = `${remaining} ثانیه`;
      } else {
        countdownEl.textContent = '۰ ثانیه';
      }
    }
  }, 1000);

  // بسته شدن خودکار بنر دقیقاً پس از ۳ ثانیه (۳۰۰۰ میلی‌ثانیه)
  adminWelcomeBannerTimer = setTimeout(() => {
    closeAdminWelcomeBanner();
  }, 3000);
}

function closeAdminWelcomeBanner() {
  const banner = document.getElementById('adminWelcomeBanner');
  if (adminWelcomeBannerTimer) {
    clearTimeout(adminWelcomeBannerTimer);
    adminWelcomeBannerTimer = null;
  }
  if (adminWelcomeBannerInterval) {
    clearInterval(adminWelcomeBannerInterval);
    adminWelcomeBannerInterval = null;
  }
  if (!banner) return;

  banner.classList.remove('translate-y-0', 'opacity-100');
  banner.classList.add('-translate-y-2', 'opacity-0');
  setTimeout(() => {
    banner.classList.add('hidden');
  }, 500);
}
window.closeAdminWelcomeBanner = closeAdminWelcomeBanner;
window.showAdminWelcomeBanner = showAdminWelcomeBanner;

// اسلاید ۳ ثانیه‌ای ورود مدیران (نگهداری برای سازگاری کامل)
function showAdminWelcomeSlide(displayName, callback) {
  const modal = document.getElementById('adminWelcomeSlideModal');
  const messageEl = document.getElementById('adminWelcomeMessageText');
  const progressBar = document.getElementById('adminWelcomeProgressBar');
  const countdownEl = document.getElementById('adminWelcomeCountdown');

  if (!modal || !messageEl) {
    if (typeof callback === 'function') callback();
    return;
  }

  // پیام اختصاصی دقیق طبق درخواست کاربر
  messageEl.textContent = `${displayName} عزیز به سیستم ثبت گراف مدیریت اتوماسیون و ارتباطات خوش آمدید`;

  if (progressBar) {
    progressBar.style.transition = 'none';
    progressBar.style.width = '0%';
  }
  if (countdownEl) {
    countdownEl.textContent = '۳ ثانیه';
  }

  modal.classList.remove('hidden');
  modal.classList.remove('opacity-0');

  setTimeout(() => {
    if (progressBar) {
      progressBar.style.transition = 'width 3000ms linear';
      progressBar.style.width = '100%';
    }
  }, 40);

  let secondsLeft = 3;
  const interval = setInterval(() => {
    secondsLeft--;
    if (countdownEl && secondsLeft > 0) {
      countdownEl.textContent = `${secondsLeft} ثانیه`;
    }
  }, 1000);

  setTimeout(() => {
    clearInterval(interval);
    modal.classList.add('opacity-0');
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.classList.remove('opacity-0');
      if (typeof callback === 'function') callback();
    }, 300);
  }, 3000);
}

async function handleAdminLogin(e) {
  e.preventDefault();
  const user = document.getElementById('loginUsername').value.trim();
  const pass = document.getElementById('loginPassword').value.trim();

  // ۱. بررسی ورود مدیر نرم‌افزار (admin)
  if (user.toLowerCase() === 'admin' && (pass === 'Ehsan2559' || pass.toLowerCase() === 'ehsan2559')) {
    window.AppState.currentUser = SUPER_ADMIN;
    sessionStorage.setItem('automation_admin_session', JSON.stringify(SUPER_ADMIN));
    closeModal('loginModal');
    const form = document.getElementById('adminLoginForm');
    if (form) form.reset();

    const displayName = SUPER_ADMIN.fullName;
    switchToAdminView();
    showAdminWelcomeBanner(displayName);
    return;
  }

  // ۲. بررسی ورود مهندس محسن جعفری (مدیراتوماسیون و ارتباطات) - نام کاربری: 417734 و رمز: 3344
  if ((user === '417734' || user === '417737') && pass === '3344') {
    window.AppState.currentUser = MANAGER_ADMIN;
    sessionStorage.setItem('automation_admin_session', JSON.stringify(MANAGER_ADMIN));
    closeModal('loginModal');
    const form = document.getElementById('adminLoginForm');
    if (form) form.reset();

    const displayName = MANAGER_ADMIN.fullName;
    switchToAdminView();
    showAdminWelcomeBanner(displayName);
    return;
  }

  try {
    const admins = await getAdminsList();
    const match = admins.find((a) => a.username === user && a.password === pass);
    if (match) {
      window.AppState.currentUser = match;
      sessionStorage.setItem('automation_admin_session', JSON.stringify(match));
      closeModal('loginModal');
      const form = document.getElementById('adminLoginForm');
      if (form) form.reset();

      const displayName = match.fullName || match.username;
      switchToAdminView();
      showAdminWelcomeBanner(displayName);
      return;
    }
  } catch (err) {
    console.error('Login check error', err);
  }

  showToast('نام کاربری یا رمز عبور اشتباه است', 'error');
}

function handleAdminLogout() {
  window.AppState.currentUser = null;
  sessionStorage.removeItem('automation_admin_session');
  showToast('با موفقیت از سیستم خارج شدید', 'info');
  switchToHomeView();
}

function openAdminAccess() {
  if (checkAdminAuthSession()) {
    switchToAdminView();
  } else {
    openModal('loginModal');
  }
}

// ==========================================
// ۱۳. پنل ادمین: سوئیچ نماها
// ==========================================
function switchToHomeView() {
  window.AppState.currentView = 'home';
  document.getElementById('homeViewSection').classList.remove('hidden');
  document.getElementById('adminViewSection').classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function switchToAdminView() {
  window.AppState.currentView = 'admin';
  document.getElementById('homeViewSection').classList.add('hidden');
  document.getElementById('adminViewSection').classList.remove('hidden');

  const user = window.AppState.currentUser;
  renderAdminUserHeaderInfo(user);

  // تنها کاربر admin و مدیرانی که در زمان تعریف مجوز ماژول‌ها را دریافت کرده‌اند به این تب‌ها دسترسی دارند
  const canOrg = canAccessOrgManage(user);
  const canAdmin = canAccessAdminManage(user);
  const canBackup = canAccessBackup(user);
  const canPersonnel = canAccessPersonnelManage(user);
  const canAsset = canAccessAssetRebuildable(user);

  const adminManageTab = document.getElementById('tabBtnAdminManage');
  const orgManageTab = document.getElementById('tabBtnOrgManage');
  const backupTab = document.getElementById('tabBtnBackup');
  const personnelTab = document.getElementById('tabBtnPersonnelManage');
  const assetRebuildableTab = document.getElementById('tabBtnAssetRebuildable');

  if (adminManageTab) {
    if (canAdmin) adminManageTab.classList.remove('hidden');
    else adminManageTab.classList.add('hidden');
  }
  if (orgManageTab) {
    if (canOrg) orgManageTab.classList.remove('hidden');
    else orgManageTab.classList.add('hidden');
  }
  if (backupTab) {
    if (canBackup) backupTab.classList.remove('hidden');
    else backupTab.classList.add('hidden');
  }
  if (personnelTab) {
    if (canPersonnel) personnelTab.classList.remove('hidden');
    else personnelTab.classList.add('hidden');
  }
  if (assetRebuildableTab) {
    if (canAsset) assetRebuildableTab.classList.remove('hidden');
    else assetRebuildableTab.classList.add('hidden');
  }

  showAdminTab('reports');
  updateAdminFilterDropdowns();
  loadAdminReports();
  if (canAdmin) {
    loadAdminUsersList();
    populateOrgDropdowns();
  }
  if (canOrg) {
    renderOrgManagementUI();
    populateOrgDropdowns();
  }
  if (canPersonnel) {
    renderPersonnelTable();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderAdminUserHeaderInfo(user) {
  const titleEl = document.getElementById('adminUserTitle');
  const scopeBadgeEl = document.getElementById('adminUserScopeBadge');
  const scopeDetailEl = document.getElementById('adminUserScopeDetail');

  if (!user) return;

  const isSuperAdmin = isMasterAdmin(user);
  if (titleEl) {
    if (user.username === '417734' || user.username === '417737') {
      titleEl.textContent = MANAGER_ADMIN.fullName;
    } else if (user.username === 'admin') {
      titleEl.textContent = SUPER_ADMIN.fullName;
    } else {
      titleEl.textContent = user.fullName || user.username;
    }
  }

  const userSup = (user.supervision || '').trim();
  const userUnit = (user.unit || '').trim();
  const isGlobalSup = isSuperAdmin || !userSup || userSup === 'همه سرپرستی‌ها' || userSup === 'کل سرپرستی‌ها';
  const isGlobalUnit = isSuperAdmin || !userUnit || userUnit === 'همه واحدها' || userUnit === 'کل واحدها' || userUnit === 'همه واحدهای سرپرستی';

  if (scopeBadgeEl) {
    if (isGlobalSup && isGlobalUnit) {
      scopeBadgeEl.className = 'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-bold bg-emerald-500/10 border border-emerald-500/30 text-emerald-300';
      scopeBadgeEl.textContent = 'دسترسی کامل (کل سازمان)';
    } else if (!isGlobalSup && isGlobalUnit) {
      scopeBadgeEl.className = 'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-bold bg-blue-500/10 border border-blue-500/30 text-blue-300';
      scopeBadgeEl.textContent = `حوزه سرپرستی: ${userSup} (همه واحدها)`;
    } else if (!isGlobalSup && !isGlobalUnit) {
      scopeBadgeEl.className = 'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-bold bg-amber-500/10 border border-amber-500/30 text-amber-300';
      scopeBadgeEl.textContent = `حوزه اختصاصی: ${userSup} / ${userUnit}`;
    } else {
      scopeBadgeEl.className = 'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-bold bg-amber-500/10 border border-amber-500/30 text-amber-300';
      scopeBadgeEl.textContent = `واحد اختصاصی: ${userUnit}`;
    }
  }

  if (scopeDetailEl) {
    if (isGlobalSup && isGlobalUnit) {
      scopeDetailEl.textContent = 'دسترسی نامحدود به گزارش‌های تمامی سرپرستی‌ها و واحدها';
    } else if (!isGlobalSup && isGlobalUnit) {
      scopeDetailEl.textContent = `فقط مجاز به مشاهده گزارش‌های زیرمجموعه سرپرستی ${userSup}`;
    } else if (!isGlobalSup && !isGlobalUnit) {
      scopeDetailEl.textContent = `فقط مجاز به مشاهده گزارش‌های واحد ${userUnit}`;
    } else {
      scopeDetailEl.textContent = `محدود به واحد ${userUnit}`;
    }
  }
}

// ==========================================
// ۱۴. پنل ادمین: ارزیابی سطوح دسترسی (RBAC) و گزارش‌گیری
// ==========================================

/**
 * بررسی دسترسی مجاز مدیر به یک رکورد گزارش
 * طبق دستور صریح کاربر:
 * ۱. اگر مدیری برای همه سرپرستی‌ها و همه واحدها تعریف شود -> دسترسی به تمام اطلاعات
 * ۲. اگر مدیری برای یک سرپرستی خاص و همه واحدهای آن سرپرستی تعریف شود -> دسترسی به اطلاعات کل زیرمجموعه همان سرپرستی
 * ۳. اگر مدیری برای یک سرپرستی و یک واحد خاص تعریف شود -> فقط و فقط به اطلاعات همان واحد دسترسی دارد
 */
function isRecordAccessibleByAdmin(record, user) {
  if (!user) return false;
  if (user.isSuperAdmin || user.username === 'admin') {
    return true; // مدیر ارشد سیستم بدون محدودیت
  }

  const userSup = (user.supervision || '').trim();
  const userUnit = (user.unit || '').trim();

  const isGlobalSup = !userSup || userSup === 'همه سرپرستی‌ها' || userSup === 'کل سرپرستی‌ها' || userSup === 'همه';
  const isGlobalUnit = !userUnit || userUnit === 'همه واحدها' || userUnit === 'کل واحدها' || userUnit === 'همه واحدهای سرپرستی' || userUnit === 'همه';

  // حالت ۱: اگر مدیر برای همه سرپرستی‌ها و همه واحدها تعریف شود -> دسترسی کامل به کل اطلاعات
  if (isGlobalSup && isGlobalUnit) {
    return true;
  }

  const op = record.operator || {};
  const recordSup = (op.supervision || '').trim();
  const recordUnit = (op.unit || '').trim();

  // در صورتی که سرپرستی در فیلد مجری ثبت نشده باشد، از پایگاه داده سازمانی استخراج می‌شود
  const allUnits = getStoredUnits();
  const matchedUnitObj = allUnits.find((u) => u.name === recordUnit);
  const inferredSup = matchedUnitObj ? (matchedUnitObj.supervision || '').trim() : '';

  const recordBelongsToSup = isGlobalSup ||
    (recordSup && recordSup === userSup) ||
    (inferredSup && inferredSup === userSup);

  // حالت ۲: اگر مدیر برای یک سرپرستی خاص و همه واحدهای آن سرپرستی تعریف شود -> دسترسی به تمام اطلاعات زیرمجموعه همان سرپرستی
  if (!isGlobalSup && isGlobalUnit) {
    return recordBelongsToSup;
  }

  // حالت ۳: اگر مدیر برای یک سرپرستی و یک واحد خاص تعریف شود -> فقط اطلاعات همان واحد در آن سرپرستی
  if (!isGlobalSup && !isGlobalUnit) {
    const unitMatches = recordUnit === userUnit;
    return recordBelongsToSup && unitMatches;
  }

  // حالت فرعی (سرپرستی عمومی اما واحد اختصاصی)
  if (isGlobalSup && !isGlobalUnit) {
    return recordUnit === userUnit;
  }

  return false;
}

async function loadAdminReports() {
  try {
    const allRecords = await getAllGraphRecords();
    const user = window.AppState.currentUser;

    // فیلتر کردن دقیق براساس حوزه سرپرستی و واحد مدیر
    let records = allRecords.filter((r) => isRecordAccessibleByAdmin(r, user));

    records.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    window.AppState.allReports = records;

    renderAdminKPIs(records);
    applyAdminFilters();
  } catch (err) {
    console.error('Error loading reports', err);
  }
}

function renderAdminKPIs(records) {
  const total = records.length;
  const pending = records.filter((r) => r.syncStatus === 'pending').length;
  const synced = records.filter((r) => r.syncStatus === 'synced').length;

  const todayStr = getFormattedJalali().dateNumStr;
  const todayCount = records.filter((r) => r.jalaliDate === todayStr).length;

  document.getElementById('kpiTotalCount').textContent = total;
  document.getElementById('kpiTodayCount').textContent = todayCount;
  document.getElementById('kpiPendingCount').textContent = pending;
  document.getElementById('kpiSyncedCount').textContent = synced;
}

function updateAdminFilterDropdowns() {
  const user = window.AppState.currentUser;
  const supervisions = getStoredSupervisions();
  const units = getStoredUnits();

  const filterSupSelect = document.getElementById('filterSupervisionSelect');
  const filterUnitSelect = document.getElementById('filterUnitSelect');
  const supLockedBadge = document.getElementById('filterSupervisionLockedBadge');
  const unitLockedBadge = document.getElementById('filterUnitLockedBadge');

  if (!filterSupSelect || !filterUnitSelect) return;

  const isSuperAdmin = !user || user.isSuperAdmin || user.username === 'admin';
  const userSup = user ? (user.supervision || '').trim() : '';
  const userUnit = user ? (user.unit || '').trim() : '';

  const isGlobalSup = isSuperAdmin || !userSup || userSup === 'همه سرپرستی‌ها' || userSup === 'کل سرپرستی‌ها' || userSup === 'همه';
  const isGlobalUnit = isSuperAdmin || !userUnit || userUnit === 'همه واحدها' || userUnit === 'کل واحدها' || userUnit === 'همه واحدهای سرپرستی' || userUnit === 'همه';

  // ۱. کنترل نوار فیلتر سرپرستی
  filterSupSelect.innerHTML = '';
  if (isGlobalSup) {
    filterSupSelect.disabled = false;
    filterSupSelect.className = 'w-full bg-slate-950 border border-slate-700 focus:border-amber-500 rounded-xl px-3 py-2 text-xs text-slate-100 outline-none';
    if (supLockedBadge) supLockedBadge.classList.add('hidden');

    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = '-- همه سرپرستی‌ها --';
    filterSupSelect.appendChild(allOpt);

    supervisions.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      filterSupSelect.appendChild(opt);
    });
  } else {
    // قفل‌شده بر روی سرپرستی این مدیر
    filterSupSelect.disabled = true;
    filterSupSelect.className = 'w-full bg-slate-900/90 border border-amber-500/40 rounded-xl px-3 py-2 text-xs text-amber-300 font-bold outline-none cursor-not-allowed';
    if (supLockedBadge) supLockedBadge.classList.remove('hidden');

    const opt = document.createElement('option');
    opt.value = userSup;
    opt.textContent = userSup;
    filterSupSelect.appendChild(opt);
    filterSupSelect.value = userSup;
  }

  // ۲. کنترل نوار فیلتر واحد خدمتی
  filterUnitSelect.innerHTML = '';
  if (!isGlobalSup && !isGlobalUnit) {
    // قفل‌شده بر روی تک‌واحد مجاز این مدیر
    filterUnitSelect.disabled = true;
    filterUnitSelect.className = 'w-full bg-slate-900/90 border border-amber-500/40 rounded-xl px-3 py-2 text-xs text-amber-300 font-bold outline-none cursor-not-allowed';
    if (unitLockedBadge) unitLockedBadge.classList.remove('hidden');

    const opt = document.createElement('option');
    opt.value = userUnit;
    opt.textContent = userUnit;
    filterUnitSelect.appendChild(opt);
    filterUnitSelect.value = userUnit;
  } else {
    // آزاد برای فیلتر در محدوده مجاز
    filterUnitSelect.disabled = false;
    filterUnitSelect.className = 'w-full bg-slate-950 border border-slate-700 focus:border-amber-500 rounded-xl px-3 py-2 text-xs text-slate-100 outline-none';
    if (unitLockedBadge) unitLockedBadge.classList.add('hidden');

    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = !isGlobalSup ? `همه واحدهای ${userSup}` : '-- همه واحدها --';
    filterUnitSelect.appendChild(allOpt);

    const allowedUnits = !isGlobalSup
      ? units.filter((u) => !u.supervision || u.supervision === userSup)
      : units;

    allowedUnits.forEach((u) => {
      const opt = document.createElement('option');
      opt.value = u.name;
      opt.textContent = u.name;
      filterUnitSelect.appendChild(opt);
    });
  }
}

function onAdminFilterSupervisionChange() {
  const supSelect = document.getElementById('filterSupervisionSelect');
  const unitSelect = document.getElementById('filterUnitSelect');
  if (!supSelect || !unitSelect) return;

  const selectedSup = supSelect.value.trim();
  const allUnits = getStoredUnits();

  unitSelect.innerHTML = '<option value="">-- همه واحدها --</option>';
  const filteredUnits = selectedSup
    ? allUnits.filter((u) => !u.supervision || u.supervision === selectedSup)
    : allUnits;

  filteredUnits.forEach((u) => {
    const opt = document.createElement('option');
    opt.value = u.name;
    opt.textContent = u.name;
    unitSelect.appendChild(opt);
  });

  applyAdminFilters();
}

function normalizeTimeToMinutes(tStr) {
  if (!tStr) return null;
  const english = toEnglishDigits(String(tStr).trim());
  const match = english.match(/(\d{1,2})[:_.](\d{1,2})/);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return (h * 60) + m;
}

function clearTimeFilters() {
  if (document.getElementById('filterTimeFrom')) document.getElementById('filterTimeFrom').value = '';
  if (document.getElementById('filterTimeTo')) document.getElementById('filterTimeTo').value = '';
  applyAdminFilters();
}
window.clearTimeFilters = clearTimeFilters;

function clearDateFilters() {
  if (document.getElementById('filterDateFrom')) document.getElementById('filterDateFrom').value = '';
  if (document.getElementById('filterDateTo')) document.getElementById('filterDateTo').value = '';
  applyAdminFilters();
}
window.clearDateFilters = clearDateFilters;

// ==========================================
// توابع تقویم هجری شمسی تعاملی و ساعت آنالوگ ماژول گزارش‌ها
// ==========================================

function isJalaliLeapYear(jy) {
  return (((((jy - ((jy > 0) ? 474 : 473)) % 2820) + 474) + 38) * 682) % 2816 < 682;
}

function getJalaliMonthDays(jy, jm) {
  if (jm >= 1 && jm <= 6) return 31;
  if (jm >= 7 && jm <= 11) return 30;
  return isJalaliLeapYear(jy) ? 30 : 29;
}

function jalaliToGregorian(jy, jm, jd) {
  let gy = (jy <= 979) ? 621 : 1600;
  jy -= (jy <= 979) ? 0 : 979;
  let days = (365 * jy) + (Math.floor(jy / 33) * 8) + Math.floor(((jy % 33) + 3) / 4) +
    78 + jd + ((jm < 7) ? ((jm - 1) * 31) : (((jm - 7) * 30) + 186));
  gy += 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const sal_a = [0, 31, ((gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  for (gm = 0; gm < 13; gm++) {
    const v = sal_a[gm];
    if (gd <= v) break;
    gd -= v;
  }
  return { gy, gm, gd };
}

function getFirstDayOfWeekInJalaliMonth(jy, jm) {
  const g = jalaliToGregorian(jy, jm, 1);
  const gDate = new Date(g.gy, g.gm - 1, g.gd);
  return (gDate.getDay() + 1) % 7; // 0=شنبه، ..., 6=جمعه
}

// وضعیت تقویم شمسی
var CalendarState = {
  currentTarget: 'from',
  selectedFrom: '',
  selectedTo: '',
  viewYear: 1405,
  viewMonth: 1
};

function openPersianCalendarModal(target = 'from') {
  const modal = document.getElementById('persianCalendarModal');
  if (!modal) return;

  const currentFrom = (document.getElementById('filterDateFrom')?.value || '').trim();
  const currentTo = (document.getElementById('filterDateTo')?.value || '').trim();

  CalendarState.selectedFrom = currentFrom;
  CalendarState.selectedTo = currentTo;

  if (target === 'to') {
    CalendarState.currentTarget = 'to';
  } else {
    CalendarState.currentTarget = 'from';
  }

  const baseDateStr = CalendarState.currentTarget === 'to' && CalendarState.selectedTo
    ? CalendarState.selectedTo
    : (CalendarState.selectedFrom || getFormattedJalali().dateNumStr);

  const parts = toEnglishDigits(baseDateStr).split(/[\/.-]/);
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);

  CalendarState.viewYear = (!isNaN(y) && y >= 1350 && y <= 1450) ? y : getFormattedJalali().jy;
  CalendarState.viewMonth = (!isNaN(m) && m >= 1 && m <= 12) ? m : getFormattedJalali().jm;

  initCalendarYearDropdown();
  updateCalendarTabHeaders();
  renderCalendarDaysGrid();

  modal.classList.remove('hidden');
}

function closePersianCalendarModal() {
  const modal = document.getElementById('persianCalendarModal');
  if (modal) modal.classList.add('hidden');
}

function switchCalendarTarget(target) {
  CalendarState.currentTarget = target === 'to' ? 'to' : 'from';
  updateCalendarTabHeaders();
  renderCalendarDaysGrid();
}

function updateCalendarTabHeaders() {
  const tabFromBtn = document.getElementById('calTabFromBtn');
  const tabToBtn = document.getElementById('calTabToBtn');
  const prevFrom = document.getElementById('calPreviewFrom');
  const prevTo = document.getElementById('calPreviewTo');

  if (prevFrom) prevFrom.textContent = CalendarState.selectedFrom || '---';
  if (prevTo) prevTo.textContent = CalendarState.selectedTo || '---';

  const activeClass = 'py-2 px-3 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 bg-amber-500 text-slate-950 shadow';
  const inactiveClass = 'py-2 px-3 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 text-slate-400 hover:text-slate-200 bg-slate-900 border border-slate-800';

  if (tabFromBtn) tabFromBtn.className = CalendarState.currentTarget === 'from' ? activeClass : inactiveClass;
  if (tabToBtn) tabToBtn.className = CalendarState.currentTarget === 'to' ? activeClass : inactiveClass;
}

function initCalendarYearDropdown() {
  const ySel = document.getElementById('calYearSelect');
  const mSel = document.getElementById('calMonthSelect');
  if (ySel) {
    ySel.innerHTML = '';
    const currentY = getFormattedJalali().jy;
    for (let y = currentY - 5; y <= currentY + 5; y++) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      if (y === CalendarState.viewYear) opt.selected = true;
      ySel.appendChild(opt);
    }
  }
  if (mSel) {
    mSel.value = CalendarState.viewMonth;
  }
}

function onCalendarSelectChange() {
  const ySel = document.getElementById('calYearSelect');
  const mSel = document.getElementById('calMonthSelect');
  if (ySel) CalendarState.viewYear = parseInt(ySel.value, 10);
  if (mSel) CalendarState.viewMonth = parseInt(mSel.value, 10);
  renderCalendarDaysGrid();
}

function navigateCalendarMonth(delta) {
  let m = CalendarState.viewMonth + delta;
  let y = CalendarState.viewYear;
  if (m > 12) {
    m = 1;
    y++;
  } else if (m < 1) {
    m = 12;
    y--;
  }
  CalendarState.viewYear = y;
  CalendarState.viewMonth = m;

  const ySel = document.getElementById('calYearSelect');
  const mSel = document.getElementById('calMonthSelect');
  if (ySel) {
    if (![...ySel.options].some(o => parseInt(o.value, 10) === y)) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      ySel.appendChild(opt);
    }
    ySel.value = y;
  }
  if (mSel) mSel.value = m;

  renderCalendarDaysGrid();
}

function renderCalendarDaysGrid() {
  const grid = document.getElementById('calDaysGrid');
  if (!grid) return;

  grid.innerHTML = '';
  const jy = CalendarState.viewYear;
  const jm = CalendarState.viewMonth;
  const daysInMonth = getJalaliMonthDays(jy, jm);
  const firstDayOffset = getFirstDayOfWeekInJalaliMonth(jy, jm); // 0=Sat..6=Fri

  const todayStr = getFormattedJalali().dateNumStr;

  for (let i = 0; i < firstDayOffset; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.className = 'p-1.5 opacity-0 pointer-events-none';
    grid.appendChild(emptyCell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${jy}/${pad(jm)}/${pad(d)}`;
    const dayOfWeekIndex = (firstDayOffset + d - 1) % 7;
    const isFriday = dayOfWeekIndex === 6;

    const isFrom = CalendarState.selectedFrom === dateStr;
    const isTo = CalendarState.selectedTo === dateStr;
    const isBetween = CalendarState.selectedFrom && CalendarState.selectedTo &&
      dateStr > CalendarState.selectedFrom && dateStr < CalendarState.selectedTo;
    const isToday = todayStr === dateStr;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-date', dateStr);
    btn.onclick = () => selectCalendarDay(dateStr);

    let btnClasses = 'w-full aspect-square rounded-xl text-xs font-mono font-bold flex items-center justify-center transition active:scale-95 ';

    if (isFrom || isTo) {
      btnClasses += 'bg-gradient-to-br from-amber-400 to-amber-500 text-slate-950 font-black shadow-md shadow-amber-500/30 scale-105 z-10';
    } else if (isBetween) {
      btnClasses += 'bg-amber-500/20 text-amber-200 border border-amber-500/30';
    } else if (isToday) {
      btnClasses += 'bg-slate-800 text-amber-300 ring-2 ring-amber-400/80 hover:bg-slate-700';
    } else if (isFriday) {
      btnClasses += 'text-rose-400 bg-slate-950/60 hover:bg-slate-800 border border-rose-950/40';
    } else {
      btnClasses += 'text-slate-200 bg-slate-950/60 hover:bg-slate-800 hover:text-amber-300 border border-slate-800/80';
    }

    btn.className = btnClasses;
    btn.textContent = d;
    btn.title = `${dateStr}${isToday ? ' (امروز)' : ''}${isFriday ? ' (جمعه)' : ''}`;

    grid.appendChild(btn);
  }
}

function selectCalendarDay(dateStr) {
  if (CalendarState.currentTarget === 'from') {
    CalendarState.selectedFrom = dateStr;
    if (!CalendarState.selectedTo || CalendarState.selectedTo < dateStr) {
      CalendarState.selectedTo = dateStr;
    }
    CalendarState.currentTarget = 'to';
  } else {
    CalendarState.selectedTo = dateStr;
    if (CalendarState.selectedFrom && CalendarState.selectedTo < CalendarState.selectedFrom) {
      const tmp = CalendarState.selectedFrom;
      CalendarState.selectedFrom = CalendarState.selectedTo;
      CalendarState.selectedTo = tmp;
    }
  }

  updateCalendarTabHeaders();
  renderCalendarDaysGrid();
}

function applyQuickDatePreset(preset) {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const todayJ = getFormattedJalali(now);
  const todayStr = todayJ.dateNumStr;

  if (preset === 'today') {
    CalendarState.selectedFrom = todayStr;
    CalendarState.selectedTo = todayStr;
  } else if (preset === 'yesterday') {
    const yDate = new Date(now.getTime() - 86400000);
    const yJ = getFormattedJalali(yDate).dateNumStr;
    CalendarState.selectedFrom = yJ;
    CalendarState.selectedTo = yJ;
  } else if (preset === 'thisWeek') {
    const dayOfWeek = (now.getDay() + 1) % 7;
    const startSat = new Date(now.getTime() - (dayOfWeek * 86400000));
    const endFri = new Date(startSat.getTime() + (6 * 86400000));
    CalendarState.selectedFrom = getFormattedJalali(startSat).dateNumStr;
    CalendarState.selectedTo = getFormattedJalali(endFri).dateNumStr;
  } else if (preset === 'thisMonth') {
    const daysInM = getJalaliMonthDays(todayJ.jy, todayJ.jm);
    CalendarState.selectedFrom = `${todayJ.jy}/${pad(todayJ.jm)}/01`;
    CalendarState.selectedTo = `${todayJ.jy}/${pad(todayJ.jm)}/${pad(daysInM)}`;
  } else if (preset === 'last30Days') {
    const past30 = new Date(now.getTime() - (30 * 86400000));
    CalendarState.selectedFrom = getFormattedJalali(past30).dateNumStr;
    CalendarState.selectedTo = todayStr;
  } else if (preset === 'clear') {
    CalendarState.selectedFrom = '';
    CalendarState.selectedTo = '';
  }

  updateCalendarTabHeaders();
  renderCalendarDaysGrid();
}

function confirmPersianCalendarSelection() {
  const fromEl = document.getElementById('filterDateFrom');
  const toEl = document.getElementById('filterDateTo');

  if (fromEl) fromEl.value = CalendarState.selectedFrom;
  if (toEl) toEl.value = CalendarState.selectedTo;

  closePersianCalendarModal();
  applyAdminFilters();
  showToast('بازه تاریخی با موفقیت در جدول اعمال شد', 'info');
}

// ==========================================
// وضعیت و منطق ساعت آنالوگ تعاملی
// ==========================================
var ClockState = {
  currentTarget: 'from',
  mode: 'hour',
  fromHour: 0,
  fromMinute: 0,
  toHour: 23,
  toMinute: 59,
  isDragging: false
};

function parseTimeString(str, defaultH, defaultM) {
  if (!str) return { h: defaultH, m: defaultM };
  const eng = toEnglishDigits(String(str).trim());
  const match = eng.match(/(\d{1,2})[:_.](\d{1,2})/);
  if (!match) return { h: defaultH, m: defaultM };
  let h = parseInt(match[1], 10);
  let m = parseInt(match[2], 10);
  if (isNaN(h) || h < 0 || h > 23) h = defaultH;
  if (isNaN(m) || m < 0 || m > 59) m = defaultM;
  return { h, m };
}

function formatClockTime(h, m) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}`;
}

function openAnalogClockModal(target = 'from') {
  const modal = document.getElementById('analogClockModal');
  if (!modal) return;

  const curFrom = document.getElementById('filterTimeFrom')?.value || '';
  const curTo = document.getElementById('filterTimeTo')?.value || '';

  const parsedFrom = parseTimeString(curFrom, 0, 0);
  const parsedTo = parseTimeString(curTo, 23, 59);

  ClockState.fromHour = parsedFrom.h;
  ClockState.fromMinute = parsedFrom.m;
  ClockState.toHour = parsedTo.h;
  ClockState.toMinute = parsedTo.m;

  ClockState.currentTarget = target === 'to' ? 'to' : 'from';
  ClockState.mode = 'hour';

  updateClockModalUI();
  initAnalogClockEvents();

  modal.classList.remove('hidden');
}

function closeAnalogClockModal() {
  const modal = document.getElementById('analogClockModal');
  if (modal) modal.classList.add('hidden');
}

function switchClockTarget(target) {
  ClockState.currentTarget = target === 'to' ? 'to' : 'from';
  updateClockModalUI();
}

function setClockSelectionMode(mode) {
  ClockState.mode = mode === 'minute' ? 'minute' : 'hour';
  updateClockModalUI();
}

function adjustClockValue(amount, unit) {
  const isFrom = ClockState.currentTarget === 'from';
  let h = isFrom ? ClockState.fromHour : ClockState.toHour;
  let m = isFrom ? ClockState.fromMinute : ClockState.toMinute;

  if (unit === 'hour') {
    h = (h + amount + 24) % 24;
  } else if (unit === 'minute') {
    m = (m + amount + 60) % 60;
  }

  if (isFrom) {
    ClockState.fromHour = h;
    ClockState.fromMinute = m;
  } else {
    ClockState.toHour = h;
    ClockState.toMinute = m;
  }

  updateClockModalUI();
}

function applyClockShiftPreset(fromStr, toStr) {
  const f = parseTimeString(fromStr, 7, 0);
  const t = parseTimeString(toStr, 15, 0);

  ClockState.fromHour = f.h;
  ClockState.fromMinute = f.m;
  ClockState.toHour = t.h;
  ClockState.toMinute = t.m;

  updateClockModalUI();
  showToast(`شیفت کاری ${fromStr} تا ${toStr} تنظیم شد`, 'info');
}

function clearClockFilter() {
  ClockState.fromHour = 0;
  ClockState.fromMinute = 0;
  ClockState.toHour = 23;
  ClockState.toMinute = 59;

  const fInput = document.getElementById('filterTimeFrom');
  const tInput = document.getElementById('filterTimeTo');
  if (fInput) fInput.value = '';
  if (tInput) tInput.value = '';

  closeAnalogClockModal();
  applyAdminFilters();
  showToast('فیلتر ساعت پاکسازی شد', 'info');
}

function confirmAnalogClockSelection() {
  const fInput = document.getElementById('filterTimeFrom');
  const tInput = document.getElementById('filterTimeTo');

  const fTime = formatClockTime(ClockState.fromHour, ClockState.fromMinute);
  const tTime = formatClockTime(ClockState.toHour, ClockState.toMinute);

  if (fInput) fInput.value = fTime;
  if (tInput) tInput.value = tTime;

  closeAnalogClockModal();
  applyAdminFilters();
  showToast(`فیلتر زمانی از ${fTime} تا ${tTime} اعمال شد`, 'success');
}

function updateClockModalUI() {
  const isFrom = ClockState.currentTarget === 'from';
  const h = isFrom ? ClockState.fromHour : ClockState.toHour;
  const m = isFrom ? ClockState.fromMinute : ClockState.toMinute;

  const prevFrom = document.getElementById('clockPreviewFrom');
  const prevTo = document.getElementById('clockPreviewTo');
  if (prevFrom) prevFrom.textContent = formatClockTime(ClockState.fromHour, ClockState.fromMinute);
  if (prevTo) prevTo.textContent = formatClockTime(ClockState.toHour, ClockState.toMinute);

  const tabFromBtn = document.getElementById('clockTabFromBtn');
  const tabToBtn = document.getElementById('clockTabToBtn');
  const activeTabClass = 'py-2 px-3 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 bg-cyan-500 text-slate-950 shadow';
  const inactiveTabClass = 'py-2 px-3 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 text-slate-400 hover:text-slate-200 bg-slate-900 border border-slate-800';

  if (tabFromBtn) tabFromBtn.className = isFrom ? activeTabClass : inactiveTabClass;
  if (tabToBtn) tabToBtn.className = !isFrom ? activeTabClass : inactiveTabClass;

  const modeHourBtn = document.getElementById('clockModeHourBtn');
  const modeMinuteBtn = document.getElementById('clockModeMinuteBtn');
  if (modeHourBtn) {
    modeHourBtn.className = ClockState.mode === 'hour'
      ? 'px-3.5 py-1.5 rounded-lg font-bold transition bg-cyan-500 text-slate-950 shadow'
      : 'px-3.5 py-1.5 rounded-lg font-bold transition text-slate-400 hover:text-slate-200';
  }
  if (modeMinuteBtn) {
    modeMinuteBtn.className = ClockState.mode === 'minute'
      ? 'px-3.5 py-1.5 rounded-lg font-bold transition bg-cyan-500 text-slate-950 shadow'
      : 'px-3.5 py-1.5 rounded-lg font-bold transition text-slate-400 hover:text-slate-200';
  }

  const activeDisp = document.getElementById('clockActiveDisplay');
  if (activeDisp) {
    activeDisp.textContent = formatClockTime(h, m);
  }

  renderAnalogClockDial(h, m);
}

function renderAnalogClockDial(h, m) {
  const svg = document.getElementById('analogClockSvg');
  const numGroup = document.getElementById('clockNumbersGroup');
  const hourHand = document.getElementById('clockHourHand');
  const minuteHand = document.getElementById('clockMinuteHand');

  if (!svg || !numGroup || !hourHand || !minuteHand) return;

  numGroup.innerHTML = '';
  const cx = 120;
  const cy = 120;

  const hourAngle = ((h % 12) * 30) + (m * 0.5);
  const hourRad = (hourAngle - 90) * Math.PI / 180;
  const hourLen = (h >= 13 || h === 0) ? 46 : 64;
  hourHand.setAttribute('x1', cx);
  hourHand.setAttribute('y1', cy);
  hourHand.setAttribute('x2', (cx + hourLen * Math.cos(hourRad)).toFixed(1));
  hourHand.setAttribute('y2', (cy + hourLen * Math.sin(hourRad)).toFixed(1));
  hourHand.setAttribute('stroke', ClockState.mode === 'hour' ? '#38bdf8' : '#f59e0b');

  const minuteAngle = m * 6;
  const minuteRad = (minuteAngle - 90) * Math.PI / 180;
  const minuteLen = 82;
  minuteHand.setAttribute('x1', cx);
  minuteHand.setAttribute('y1', cy);
  minuteHand.setAttribute('x2', (cx + minuteLen * Math.cos(minuteRad)).toFixed(1));
  minuteHand.setAttribute('y2', (cy + minuteLen * Math.sin(minuteRad)).toFixed(1));
  minuteHand.setAttribute('stroke', ClockState.mode === 'minute' ? '#38bdf8' : '#06b6d4');

  if (ClockState.mode === 'hour') {
    for (let i = 1; i <= 12; i++) {
      const angle = (i * 30 - 90) * Math.PI / 180;
      const r = 84;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);

      const isCurrentH = (h === i || (h === 0 && i === 12 && false));
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x.toFixed(1));
      text.setAttribute('y', (y + 4.5).toFixed(1));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '12');
      text.setAttribute('font-family', 'monospace');
      text.setAttribute('font-weight', isCurrentH ? '900' : 'bold');
      text.setAttribute('fill', isCurrentH ? '#38bdf8' : '#cbd5e1');
      text.textContent = i;
      numGroup.appendChild(text);
    }

    for (let i = 13; i <= 24; i++) {
      const displayVal = i === 24 ? '00' : String(i);
      const hourVal = i === 24 ? 0 : i;
      const angle = ((i - 12) * 30 - 90) * Math.PI / 180;
      const r = 54;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);

      const isCurrentH = h === hourVal;
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x.toFixed(1));
      text.setAttribute('y', (y + 3.5).toFixed(1));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '10');
      text.setAttribute('font-family', 'monospace');
      text.setAttribute('font-weight', isCurrentH ? '900' : 'normal');
      text.setAttribute('fill', isCurrentH ? '#38bdf8' : '#94a3b8');
      text.textContent = displayVal;
      numGroup.appendChild(text);
    }
  } else {
    for (let i = 0; i < 60; i += 5) {
      const angle = (i * 6 - 90) * Math.PI / 180;
      const r = 82;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);

      const isCurrentM = Math.abs(m - i) <= 2;
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x.toFixed(1));
      text.setAttribute('y', (y + 4.5).toFixed(1));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '11');
      text.setAttribute('font-family', 'monospace');
      text.setAttribute('font-weight', isCurrentM ? '900' : 'bold');
      text.setAttribute('fill', isCurrentM ? '#38bdf8' : '#94a3b8');
      text.textContent = String(i).padStart(2, '0');
      numGroup.appendChild(text);
    }
  }
}

var _clockEventsInitialized = false;
function initAnalogClockEvents() {
  if (_clockEventsInitialized) return;
  const container = document.getElementById('analogClockContainer');
  if (!container) return;

  function handleInteraction(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    let angleDeg = (Math.atan2(dy, dx) * 180 / Math.PI) + 90;
    if (angleDeg < 0) angleDeg += 360;

    const isFrom = ClockState.currentTarget === 'from';

    if (ClockState.mode === 'hour') {
      let h = Math.round(angleDeg / 30) % 12;
      if (h === 0) h = 12;

      const isInner = dist < (rect.width / 2) * 0.62;
      if (isInner) {
        h = (h === 12) ? 0 : (h + 12);
      }

      if (isFrom) {
        ClockState.fromHour = h;
      } else {
        ClockState.toHour = h;
      }
    } else {
      let m = Math.round(angleDeg / 6) % 60;
      if (isFrom) {
        ClockState.fromMinute = m;
      } else {
        ClockState.toMinute = m;
      }
    }

    updateClockModalUI();
  }

  container.addEventListener('pointerdown', (e) => {
    ClockState.isDragging = true;
    handleInteraction(e.clientX, e.clientY);
  });

  window.addEventListener('pointermove', (e) => {
    if (ClockState.isDragging) {
      handleInteraction(e.clientX, e.clientY);
    }
  });

  window.addEventListener('pointerup', () => {
    if (ClockState.isDragging) {
      ClockState.isDragging = false;
      if (ClockState.mode === 'hour') {
        setTimeout(() => {
          setClockSelectionMode('minute');
        }, 250);
      }
    }
  });

  _clockEventsInitialized = true;
}

// ==========================================
// استخراج جامع داده‌های گزارش برای جدول، اکسل و PDF
// ==========================================
function getReportRowData(r, idx) {
  const op = r.operator || {};
  const cond = r.conditionalFields || {};
  const loc = r.location || {};

  const personnelId = op.personnelId || '---';
  const fullName = `${op.firstName || ''} ${op.lastName || ''}`.trim() || '---';
  const supervision = op.supervision || '---';
  const unit = op.unit || '---';
  const role = op.role || '---';
  const asett = r.asett || cond.asett || '---';
  const rebuildable = r.rebuildable || cond.rebuildable || '---';

  let activityFull = '';
  if (Array.isArray(r.activities) && r.activities.length > 0) {
    activityFull = r.activities.map((act, i) => {
      const parts = [act.type];
      const c = act.conditionalFields || {};
      if (c.footage) parts.push(`متراژ: ${c.footage}م`);
      if (c.equipmentId) parts.push(`شناسه تجهیز: ${c.equipmentId}`);
      if (c.deviceTag) parts.push(`تگ: ${c.deviceTag}`);
      if (c.referenceTool) parts.push(`مرجع: ${c.referenceTool}`);
      const actDur = act.durationFormatted || act.durationDigital || (act.durationTotalSeconds ? `${Math.floor(act.durationTotalSeconds/3600)}:${String(Math.floor((act.durationTotalSeconds%3600)/60)).padStart(2,'0')}` : '');
      if (actDur) {
        parts.push(`زمان: ${actDur} (${act.durationMethod || 'دستی'})`);
      }
      return (r.activities.length > 1 ? `(${i + 1}) ` : '') + parts.join(' - ');
    }).join(' | ');
  } else {
    const parts = [r.activityType || '---'];
    if (cond.footage) parts.push(`متراژ: ${cond.footage}م`);
    if (cond.equipmentId) parts.push(`تجهیز: ${cond.equipmentId}`);
    if (cond.deviceTag) parts.push(`تگ: ${cond.deviceTag}`);
    if (cond.referenceTool) parts.push(`مرجع: ${cond.referenceTool}`);
    const rDur = r.durationFormatted || r.durationDigital || (r.durationTotalSeconds ? `${Math.floor(r.durationTotalSeconds/3600)}:${String(Math.floor((r.durationTotalSeconds%3600)/60)).padStart(2,'0')}` : '');
    if (rDur) {
      parts.push(`زمان: ${rDur} (${r.durationMethod || 'دستی'})`);
    }
    activityFull = parts.join(' - ');
  }

  let durationMethod = r.durationMethod;
  if (!durationMethod) {
    if ((r.durationSeconds && r.durationSeconds > 0) || r.durationSource === 'stopwatch') {
      durationMethod = 'اتوماتیک (کرنومتر)';
    } else if (r.durationTotalSeconds > 0 || r.durationHours > 0 || r.durationMinutes > 0) {
      durationMethod = 'دستی';
    } else {
      durationMethod = 'نامشخص';
    }
  }
  const durationValue = r.durationFormatted || (r.durationDigital ? r.durationDigital : (r.durationTotalSeconds ? `${r.durationTotalSeconds} ثانیه` : '---'));
  const durationWithMethod = durationValue !== '---' ? `${durationValue} (${durationMethod})` : '---';

  const notes = r.reportNotes || '---';

  const colleaguesList = (r.colleagues || []).map((c) => {
    if (typeof c === 'object' && c !== null) {
      return `${c.name || ''} (${c.code || ''})`.trim();
    }
    return String(c);
  }).filter(Boolean);
  const colleaguesStr = colleaguesList.length > 0 ? colleaguesList.join('، ') : 'بدون همکار';

  const photosList = Array.isArray(r.photos) && r.photos.length > 0 ? r.photos : (r.photo ? [r.photo] : []);

  const dateTimeStr = `${r.jalaliDate || '---'} ساعت ${r.jalaliTime || '---'}`;

  let locationStr = '---';
  if (loc.lat && loc.lng) {
    locationStr = `${parseFloat(loc.lat).toFixed(5)}, ${parseFloat(loc.lng).toFixed(5)}`;
    if (loc.accuracy) locationStr += ` (دقت: ${Math.round(loc.accuracy)}م)`;
  }

  return {
    index: idx + 1,
    personnelId,
    fullName,
    supervision,
    unit,
    role,
    asett,
    rebuildable,
    activityFull,
    durationWithMethod,
    durationValue,
    durationMethod,
    notes,
    colleaguesStr,
    photosList,
    dateTimeStr,
    jalaliDate: r.jalaliDate || '---',
    jalaliTime: r.jalaliTime || '---',
    locationStr,
    id: r.id
  };
}

function applyAdminFilters() {
  let list = window.AppState.allReports || [];

  const search = (document.getElementById('filterSearchInput')?.value || '').toLowerCase().trim();
  const activity = document.getElementById('filterActivitySelect')?.value || '';
  const supervision = document.getElementById('filterSupervisionSelect')?.value || '';
  const unit = document.getElementById('filterUnitSelect')?.value || '';
  const dateFrom = document.getElementById('filterDateFrom')?.value.trim() || '';
  const dateTo = document.getElementById('filterDateTo')?.value.trim() || '';
  const timeFrom = document.getElementById('filterTimeFrom')?.value.trim() || '';
  const timeTo = document.getElementById('filterTimeTo')?.value.trim() || '';

  if (search) {
    list = list.filter((r) => {
      const notes = (r.reportNotes || '').toLowerCase();
      const asett = (r.asett || '').toLowerCase();
      const rebuild = (r.rebuildable || '').toLowerCase();
      const opName = r.operator ? `${r.operator.firstName} ${r.operator.lastName} ${r.operator.personnelId}`.toLowerCase() : '';
      const colleagues = (r.colleagues || []).map(c => typeof c === 'object' && c !== null ? `${c.name} ${c.code}` : c).join(' ').toLowerCase();
      return notes.includes(search) || asett.includes(search) || rebuild.includes(search) || opName.includes(search) || colleagues.includes(search);
    });
  }

  if (activity) {
    if (activity.includes('conf') || activity.includes('calib')) {
      list = list.filter((r) => (r.activityType || '').includes('conf') || (r.activityType || '').includes('calib') || (r.activityType || '').includes('تنظیمات حرفه‌ای'));
    } else if (activity.includes('مکانیکال') || activity.includes('آچارکشی اتصالات')) {
      list = list.filter((r) => (r.activityType || '').includes('مکانیکال') || (r.activityType || '').includes('آچارکشی اتصالات'));
    } else if (activity.includes('نظارت')) {
      list = list.filter((r) => (r.activityType || '').includes('نظارت'));
    } else {
      list = list.filter((r) => r.activityType === activity);
    }
  }

  if (supervision) {
    list = list.filter((r) => {
      const rSup = r.operator ? (r.operator.supervision || '').trim() : '';
      if (rSup === supervision) return true;
      const allUnits = getStoredUnits();
      const uObj = allUnits.find((u) => u.name === (r.operator ? r.operator.unit : ''));
      return uObj && uObj.supervision === supervision;
    });
  }

  if (unit) {
    list = list.filter((r) => r.operator && r.operator.unit === unit);
  }

  if (dateFrom) {
    list = list.filter((r) => (r.jalaliDate || '') >= dateFrom);
  }

  if (dateTo) {
    list = list.filter((r) => (r.jalaliDate || '') <= dateTo);
  }

  // فیلتر ساعت (از ساعت مشخص تا ساعت مشخص)
  if (timeFrom || timeTo) {
    const fromMin = normalizeTimeToMinutes(timeFrom);
    const toMin = normalizeTimeToMinutes(timeTo);

    list = list.filter((r) => {
      let recMin = null;
      if (r.jalaliTime) {
        recMin = normalizeTimeToMinutes(r.jalaliTime);
      }
      if (recMin === null && r.timestamp) {
        const d = new Date(r.timestamp);
        recMin = (d.getHours() * 60) + d.getMinutes();
      }
      if (recMin === null) return true;

      if (fromMin !== null && toMin !== null) {
        if (fromMin <= toMin) {
          return recMin >= fromMin && recMin <= toMin;
        } else {
          // عبور از نیمه شب (مانند شیفت شب از ۲۲:۰۰ تا ۰۶:۰۰)
          return recMin >= fromMin || recMin <= toMin;
        }
      } else if (fromMin !== null) {
        return recMin >= fromMin;
      } else if (toMin !== null) {
        return recMin <= toMin;
      }
      return true;
    });
  }

  window.AppState.filteredReports = list;
  renderReportsTable(list);
}

function resetAdminFilters() {
  if (document.getElementById('filterSearchInput')) document.getElementById('filterSearchInput').value = '';
  if (document.getElementById('filterActivitySelect')) document.getElementById('filterActivitySelect').value = '';
  if (document.getElementById('filterDateFrom')) document.getElementById('filterDateFrom').value = '';
  if (document.getElementById('filterDateTo')) document.getElementById('filterDateTo').value = '';
  if (document.getElementById('filterTimeFrom')) document.getElementById('filterTimeFrom').value = '';
  if (document.getElementById('filterTimeTo')) document.getElementById('filterTimeTo').value = '';

  const user = window.AppState.currentUser;
  const isSuperAdmin = isMasterAdmin(user);
  const userSup = user ? (user.supervision || '').trim() : '';
  const userUnit = user ? (user.unit || '').trim() : '';
  const isGlobalSup = isSuperAdmin || !userSup || userSup === 'همه سرپرستی‌ها' || userSup === 'کل سرپرستی‌ها';
  const isGlobalUnit = isSuperAdmin || !userUnit || userUnit === 'همه واحدها' || userUnit === 'کل واحدها';

  const filterSupSelect = document.getElementById('filterSupervisionSelect');
  const filterUnitSelect = document.getElementById('filterUnitSelect');

  if (isGlobalSup) {
    if (filterSupSelect) filterSupSelect.value = '';
  } else {
    if (filterSupSelect) filterSupSelect.value = userSup;
  }

  if (isGlobalSup && isGlobalUnit) {
    if (filterUnitSelect) filterUnitSelect.value = '';
  } else if (!isGlobalSup && isGlobalUnit) {
    if (filterUnitSelect) filterUnitSelect.value = '';
  } else {
    if (filterUnitSelect) filterUnitSelect.value = userUnit;
  }

  applyAdminFilters();
}

function renderReportsTable(list) {
  const tbody = document.getElementById('reportsTableBody');
  const emptyBox = document.getElementById('reportsEmptyState');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (!list || list.length === 0) {
    if (emptyBox) emptyBox.classList.remove('hidden');
    return;
  }
  if (emptyBox) emptyBox.classList.add('hidden');

  list.forEach((r, idx) => {
    const d = getReportRowData(r, idx);
    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-800 hover:bg-slate-800/40 transition';

    let photoThumb = '<span class="text-xs text-slate-500">بدون تصویر</span>';
    if (d.photosList.length === 1) {
      photoThumb = `<img src="${d.photosList[0]}" onclick="showDetailModal(${r.id})" class="w-10 h-10 object-cover rounded cursor-pointer border border-slate-700 hover:scale-105 transition" title="مشاهده تصویر">`;
    } else if (d.photosList.length > 1) {
      photoThumb = `
        <div class="relative inline-block cursor-pointer" onclick="showDetailModal(${r.id})" title="مشاهده ${d.photosList.length} تصویر">
          <img src="${d.photosList[0]}" class="w-10 h-10 object-cover rounded border border-amber-500/60 shadow hover:scale-105 transition">
          <span class="absolute -top-1.5 -left-1.5 bg-amber-500 text-slate-950 font-bold text-[9px] px-1 rounded-full border border-slate-900 shadow">
            +${d.photosList.length}
          </span>
        </div>
      `;
    }

    const durationBadgeClass = d.durationMethod.includes('اتوماتیک')
      ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-800/60'
      : 'bg-amber-950/80 text-amber-300 border border-amber-800/60';

    tr.innerHTML = `
      <td class="p-3 text-center text-slate-400 font-mono text-xs">${d.index}</td>
      <td class="p-3 font-mono font-bold text-amber-300 text-xs whitespace-nowrap">${escapeHtml(d.personnelId)}</td>
      <td class="p-3 whitespace-nowrap font-medium text-slate-100">${escapeHtml(d.fullName)}</td>
      <td class="p-3 whitespace-nowrap text-slate-300 text-xs">${escapeHtml(d.supervision)}</td>
      <td class="p-3 whitespace-nowrap text-slate-300 text-xs">${escapeHtml(d.unit)}</td>
      <td class="p-3 whitespace-nowrap text-slate-400 text-xs">${escapeHtml(d.role)}</td>
      <td class="p-3 font-mono text-xs text-amber-400 whitespace-nowrap font-bold">${escapeHtml(d.asett)}</td>
      <td class="p-3 font-mono text-xs text-cyan-400 whitespace-nowrap font-bold">${escapeHtml(d.rebuildable)}</td>
      <td class="p-3 text-xs min-w-[200px]"><div class="font-bold text-slate-200">${escapeHtml(d.activityFull)}</div></td>
      <td class="p-3 text-xs whitespace-nowrap">
        <span class="font-mono font-bold text-cyan-300">${escapeHtml(d.durationValue)}</span>
        <span class="text-[10px] px-1.5 py-0.5 rounded font-bold mr-1 ${durationBadgeClass}">${escapeHtml(d.durationMethod)}</span>
      </td>
      <td class="p-3 text-xs text-slate-300 min-w-[180px] max-w-[260px] truncate" title="${escapeHtml(d.notes)}">${escapeHtml(d.notes)}</td>
      <td class="p-3 text-xs text-slate-300 min-w-[140px] whitespace-normal">${escapeHtml(d.colleaguesStr)}</td>
      <td class="p-3 text-center whitespace-nowrap">${photoThumb}</td>
      <td class="p-3 whitespace-nowrap">
        <div class="font-bold text-slate-200 text-xs">${escapeHtml(d.jalaliDate)}</div>
        <div class="text-[11px] text-slate-400 font-mono">${escapeHtml(d.jalaliTime)}</div>
      </td>
      <td class="p-3 font-mono text-[11px] text-slate-400 whitespace-nowrap text-right" dir="ltr">${escapeHtml(d.locationStr)}</td>
      <td class="p-3 text-center whitespace-nowrap sticky left-0 bg-slate-950/90 shadow-md">
        <div class="flex items-center justify-center gap-1.5">
          <button onclick="showDetailModal(${r.id})" class="p-1.5 rounded-lg bg-blue-900/40 hover:bg-blue-800 text-blue-300 transition" title="مشاهده کامل">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
          </button>
          <button onclick="confirmDeleteReport(${r.id})" class="p-1.5 rounded-lg bg-red-950/50 hover:bg-red-900 text-red-400 transition" title="حذف رکورد">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function showDetailModal(id) {
  const record = (window.AppState.allReports || []).find((r) => r.id === id);
  if (!record) return;

  const content = document.getElementById('reportDetailContent');
  if (!content) return;

  const op = record.operator || {};

  // پردازش و نمایش فعالیت‌های چندگانه همراه با زمان اختصاصی هر فعالیت
  let activitiesHtml = '';
  if (Array.isArray(record.activities) && record.activities.length > 0) {
    activitiesHtml = record.activities.map((act, i) => {
      let conds = '';
      if (act.conditionalFields) {
        if (act.conditionalFields.footage) conds += ` - متراژ: ${act.conditionalFields.footage} متر`;
        if (act.conditionalFields.equipmentId) conds += ` - شناسایی تجهیز: ${act.conditionalFields.equipmentId}`;
        if (act.conditionalFields.deviceTag) conds += ` - شماره تجهیز: ${act.conditionalFields.deviceTag}`;
        if (act.conditionalFields.referenceTool) conds += ` - مرجع: ${act.conditionalFields.referenceTool}`;
      }

      const actTime = (act.durationFormatted || act.durationDigital) 
        ? `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">⏱️ ${escapeHtml(act.durationFormatted || act.durationDigital)} <span class="text-[10px] text-slate-400 font-sans font-normal">(${escapeHtml(act.durationMethod || 'دستی')})</span></span>`
        : `<span class="text-slate-500 text-[11px] bg-slate-900 px-2 py-0.5 rounded border border-slate-800">بدون زمان تفکیکی</span>`;

      const rebText = act.rebuildable
        ? `<span class="text-cyan-300 text-[11px] font-mono font-bold bg-cyan-950/80 px-2 py-0.5 rounded border border-cyan-800/60">Rebuildble ID: ${escapeHtml(act.rebuildable)}</span>`
        : '';

      return `
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-950/90 border border-slate-800 text-xs">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="w-5 h-5 rounded-md bg-amber-500/20 text-amber-400 font-mono font-bold flex items-center justify-center text-[11px] border border-amber-500/30 shrink-0">${i + 1}</span>
            <span class="font-bold text-slate-100">${escapeHtml(act.type)}</span>
            ${rebText}
            <span class="text-slate-400 text-[11px]">${escapeHtml(conds)}</span>
          </div>
          <div class="shrink-0 flex items-center gap-1.5 mr-auto sm:mr-0 pt-1 sm:pt-0">
            <span class="text-[11px] text-slate-400">مدت اختصاصی:</span>
            ${actTime}
          </div>
        </div>
      `;
    }).join('');
  } else {
    let conditionRows = '';
    if (record.conditionalFields) {
      if (record.conditionalFields.footage) conditionRows += ` (متراژ: ${record.conditionalFields.footage} متر)`;
      if (record.conditionalFields.equipmentId) conditionRows += ` (تجهیز: ${record.conditionalFields.equipmentId})`;
      if (record.conditionalFields.deviceTag) conditionRows += ` (تگ: ${record.conditionalFields.deviceTag} - مرجع: ${record.conditionalFields.referenceTool})`;
    }
    activitiesHtml = `<div class="font-bold text-amber-300 text-xs">${record.activityType} ${conditionRows}</div>`;
  }

  // پردازش و نمایش تصاویر چندگانه
  const photosList = Array.isArray(record.photos) && record.photos.length > 0
    ? record.photos
    : (record.photo ? [record.photo] : []);

  let photosHtml = '';
  if (photosList.length > 0) {
    photosHtml = `
      <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-800 space-y-2">
        <h4 class="font-bold text-amber-400 text-xs border-b border-slate-800 pb-1">تصاویر ثبت شده از تجهیز و محیط کار (${photosList.length} عکس)</h4>
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5 pt-1">
          ${photosList.map((p, idx) => `
            <div class="group relative aspect-square rounded-lg overflow-hidden border border-slate-700 bg-slate-950 cursor-pointer shadow hover:border-amber-500 transition" onclick="openPhotoViewerModal('${p}', ${idx})">
              <img src="${p}" class="w-full h-full object-cover group-hover:scale-105 transition duration-200" alt="عکس شماره ${idx + 1}">
              <span class="absolute top-1 right-1 bg-slate-900/80 text-[10px] font-mono text-amber-300 px-1.5 py-0.5 rounded border border-slate-700">#${idx + 1}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  const mapLink = record.location && record.location.lat
    ? `<a href="https://www.google.com/maps?q=${record.location.lat},${record.location.lng}" target="_blank" class="text-blue-400 underline font-mono">نمایش روی نقشه (${record.location.lat}, ${record.location.lng})</a>`
    : '<span class="text-slate-500">ثبت نشده</span>';

  content.innerHTML = `
    <div class="space-y-4 text-sm">
      <div class="grid grid-cols-2 gap-3 bg-slate-900/60 p-3 rounded-xl border border-slate-800">
        <div><span class="text-slate-400 text-xs">تاریخ و ساعت:</span> <div class="font-bold text-slate-200 mt-1">${record.jalaliFull || record.jalaliDate}</div></div>
        <div><span class="text-slate-400 text-xs">وضعیت همگام‌سازی:</span> <div class="mt-1">${record.syncStatus === 'synced' ? '<span class="text-emerald-400 font-bold">همگام‌شده با سرور</span>' : '<span class="text-amber-400 font-bold">در صف انتظار محلی</span>'}</div></div>
      </div>

      <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-800 space-y-2">
        <h4 class="font-bold text-amber-400 text-xs border-b border-slate-800 pb-1">اطلاعات مجری و سرپرستی</h4>
        <div class="grid grid-cols-2 gap-2 text-xs">
          <div>نام و پرسنلی: <strong class="text-slate-200">${op.firstName || ''} ${op.lastName || ''} (${op.personnelId || '-'})</strong></div>
          <div>نام پدر: <strong class="text-slate-200">${op.fatherName || '---'}</strong></div>
          <div>واحد خدمتی: <strong class="text-slate-200">${op.unit || '-'}</strong></div>
          <div>سرپرستی: <strong class="text-slate-200">${op.supervision || '-'}</strong></div>
          <div>سمت: <strong class="text-slate-200">${op.role || '-'}</strong></div>
        </div>
      </div>

      <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-800 space-y-2">
        <h4 class="font-bold text-amber-400 text-xs border-b border-slate-800 pb-1">فعالیت‌های انجام‌شده</h4>
        <div class="space-y-1.5 pt-1">
          ${activitiesHtml}
        </div>
        <div class="pt-2 border-t border-slate-800 space-y-1 text-xs">
          <div class="flex justify-between py-1 border-b border-slate-800/60"><span class="text-slate-400">کد تجهیز (ASETT ID):</span><span class="font-mono text-slate-200">${record.asett || '---'}</span></div>
          <div class="flex justify-between py-1 border-b border-slate-800/60"><span class="text-slate-400">شناسه داغی (rebuidable ID):</span><span class="font-mono text-slate-200">${record.rebuildable || '---'}</span></div>
          <div class="flex justify-between py-1 border-b border-slate-800/60"><span class="text-slate-400">مدت زمان فعالیت:</span><span class="font-mono text-cyan-300 font-bold">${record.durationFormatted ? `${record.durationFormatted} (${record.durationDigital || ''})` : 'ثبت نشده'}</span></div>
          <div class="flex justify-between py-1 border-b border-slate-800/60"><span class="text-slate-400">موقعیت مکانی (GPS):</span>${mapLink}</div>
          <div class="flex justify-between py-1"><span class="text-slate-400">همکاران همراه:</span><span class="font-mono text-slate-200">${(record.colleagues || []).map(c => typeof c === 'object' && c !== null ? `${c.name} (${c.code})` : c).join('، ') || 'ندارد'}</span></div>
        </div>
      </div>

      <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-800">
        <h4 class="font-bold text-amber-400 text-xs mb-2">توضیحات تکمیلی:</h4>
        <p class="text-slate-200 whitespace-pre-wrap leading-relaxed bg-slate-950/60 p-3 rounded-lg border border-slate-800/80">${record.reportNotes || '<span class="text-slate-500 italic">توضیحی ثبت نشده است.</span>'}</p>
      </div>

      ${photosHtml}
    </div>
  `;

  openModal('reportDetailModal');
}

async function confirmDeleteReport(id) {
  if (confirm(`آیا از حذف دائمی گراف شماره #${id} اطمینان دارید؟`)) {
    try {
      await deleteGraphRecord(id);
      showToast('گراف با موفقیت حذف گردید.', 'success');
      loadAdminReports();
    } catch (e) {
      showToast('خطا در حذف رکورد', 'error');
    }
  }
}

// ==========================================
// ۱۵. خروجی اکسل (Excel / CSV با ساختار جامع ۱۴ فیلد اطلاعاتی)
// ==========================================
function exportToExcel() {
  const list = window.AppState.filteredReports || window.AppState.allReports || [];
  if (list.length === 0) {
    showToast('رکوردی جهت خروجی اکسل وجود ندارد', 'warning');
    return;
  }

  const headers = [
    'ردیف',
    'شماره پرسنلی',
    'نام و نام خانوادگی',
    'سرپرستی',
    'واحد',
    'سمت سازمانی',
    'ASETT ID',
    'Rebuildble ID',
    'نوع اقدام / فعالیت به همراه اطلاعات دیگر',
    'مدت زمان فعالیت با ذکر دستی یا اتوماتیک',
    'توضیحات تکمیلی',
    'همکاران همراه',
    'تصویر تجهیز و محیط کار',
    'زمان و تاریخ ثبت',
    'موقعیت مکانی خودکار'
  ];

  const dataRows = list.map((r, idx) => {
    const d = getReportRowData(r, idx);
    const photoStatus = d.photosList.length > 0 ? `${d.photosList.length} تصویر ثبت شده` : 'بدون تصویر';
    return [
      d.index,
      d.personnelId,
      d.fullName,
      d.supervision,
      d.unit,
      d.role,
      d.asett,
      d.rebuildable,
      d.activityFull,
      d.durationWithMethod,
      d.notes,
      d.colleaguesStr,
      photoStatus,
      d.dateTimeStr,
      d.locationStr
    ];
  });

  const filename = `گزارش_فعالیت_ها_${getFormattedJalali().dateNumStr.replace(/\//g, '-')}.xlsx`;

  if (typeof XLSX !== 'undefined') {
    const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    if (!ws['!views']) ws['!views'] = [];
    ws['!views'].push({ rightToLeft: true });
    ws['!cols'] = [
      { wch: 6 },
      { wch: 14 },
      { wch: 22 },
      { wch: 20 },
      { wch: 18 },
      { wch: 16 },
      { wch: 14 },
      { wch: 14 },
      { wch: 35 },
      { wch: 24 },
      { wch: 30 },
      { wch: 24 },
      { wch: 18 },
      { wch: 22 },
      { wch: 24 }
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'گزارش فعالیت‌ها');
    XLSX.writeFile(wb, filename);
    showToast('فایل اکسل با موفقیت ایجاد و دانلود شد', 'success');
  } else {
    const csvContent = '\uFEFF' + [headers, ...dataRows].map(row => row.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename.replace('.xlsx', '.csv'));
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('فایل اکسل با موفقیت ایجاد و دانلود شد', 'success');
  }
}

// ==========================================
// ۱۶. خروجی PDF و چاپ رسمی فرم صنعتی با تمام فیلدهای درخواستی
// ==========================================
function printReportsAsPDF() {
  const list = window.AppState.filteredReports || window.AppState.allReports || [];
  if (list.length === 0) {
    showToast('رکوردی جهت چاپ وجود ندارد', 'warning');
    return;
  }

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    window.print();
    return;
  }

  const jalaliNow = getFormattedJalali().fullPersian;
  let tableRows = '';
  list.forEach((r, idx) => {
    const d = getReportRowData(r, idx);
    const photoText = d.photosList.length > 0 ? `${d.photosList.length} عکس` : '-';
    tableRows += `
      <tr>
        <td style="text-align:center;">${d.index}</td>
        <td style="text-align:center; font-family:monospace; font-weight:bold;">${escapeHtml(d.personnelId)}</td>
        <td>${escapeHtml(d.fullName)}</td>
        <td>${escapeHtml(d.supervision)}</td>
        <td>${escapeHtml(d.unit)}</td>
        <td>${escapeHtml(d.role)}</td>
        <td style="font-family:monospace;">${escapeHtml(d.asett)}</td>
        <td style="font-family:monospace;">${escapeHtml(d.rebuildable)}</td>
        <td>${escapeHtml(d.activityFull)}</td>
        <td>${escapeHtml(d.durationWithMethod)}</td>
        <td style="font-size:10px;">${escapeHtml(d.notes)}</td>
        <td style="font-size:10px;">${escapeHtml(d.colleaguesStr)}</td>
        <td style="text-align:center;">${photoText}</td>
        <td style="font-size:10px;">${escapeHtml(d.dateTimeStr)}</td>
        <td style="font-size:10px; font-family:monospace;" dir="ltr">${escapeHtml(d.locationStr)}</td>
      </tr>
    `;
  });

  printWindow.document.write(`
    <!DOCTYPE html>
    <html dir="rtl" lang="fa">
    <head>
      <meta charset="utf-8">
      <title>گزارش رسمی فعالیت‌های اتوماسیون و ارتباطات</title>
      <style>
        body { font-family: Tahoma, 'Segoe UI', sans-serif; direction: rtl; padding: 15px; color: #111; font-size: 11px; }
        .header { border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; }
        .header h2 { margin: 0; font-size: 16px; color: #0f172a; }
        .header p { margin: 4px 0 0 0; font-size: 11px; color: #475569; }
        table { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 10px; }
        th, td { border: 1px solid #64748b; padding: 5px 6px; text-align: right; }
        th { background: #f1f5f9; color: #0f172a; font-weight: bold; }
        tr:nth-child(even) { background: #f8fafc; }
        .signatures { margin-top: 40px; display: flex; justify-content: space-between; font-size: 11px; padding: 0 30px; page-break-inside: avoid; }
        @media print {
          @page { size: landscape; margin: 10mm; }
          button { display: none; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div>
          <h2>مدیریت اتوماسیون و ارتباطات</h2>
          <p>صورت‌جلسه و گزارش رسمی فعالیت‌های ثبت‌شده، نگهداری و تعمیرات میدانی</p>
        </div>
        <div style="text-align:left; font-size:11px;">
          <div><strong>تاریخ تهیه گزارش:</strong> ${jalaliNow}</div>
          <div><strong>تعداد رکوردها:</strong> ${list.length}</div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th style="width:25px; text-align:center;">#</th>
            <th style="width:65px; text-align:center;">پرسنلی</th>
            <th style="width:110px;">نام و نام خانوادگی</th>
            <th style="width:85px;">سرپرستی</th>
            <th style="width:75px;">واحد</th>
            <th style="width:75px;">سمت</th>
            <th style="width:65px;">ASETT ID</th>
            <th style="width:65px;">Rebuildble</th>
            <th style="width:130px;">نوع اقدام و فعالیت</th>
            <th style="width:100px;">مدت زمان (دستی/اتوماتیک)</th>
            <th>توضیحات تکمیلی</th>
            <th style="width:90px;">همکاران همراه</th>
            <th style="width:45px; text-align:center;">تصویر</th>
            <th style="width:105px;">زمان و تاریخ ثبت</th>
            <th style="width:95px;">موقعیت مکانی</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>

      <div class="signatures">
        <div><strong>امضاء تکنسین / مجری عملیات</strong><br><br>.....................................</div>
        <div><strong>امضاء سرپرست مربوطه</strong><br><br>.....................................</div>
        <div><strong>تایید مدیریت اتوماسیون و ارتباطات</strong><br><br>.....................................</div>
      </div>
      <script>
        window.onload = function() { window.print(); };
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

// ==========================================
// ۱۷. پشتیبان‌گیری (Backup) و بازنشانی (Restore)
// ==========================================
async function exportFullBackup() {
  if (!canAccessBackup()) {
    showToast('دسترسی غیرمجاز: شما مجوز دسترسی به ماژول پشتیبان‌گیری را ندارید', 'error');
    return;
  }
  try {
    const graphs = await getAllGraphRecords();
    const admins = await getAdminsList();
    const operator = window.AppState.operator;
    const supervisions = getStoredSupervisions();
    const units = getStoredUnits();
    const assetRebuildables = await getAllAssetRebuildableRecordsFromDB();

    const backupData = {
      version: '2.1',
      exportedAt: new Date().toISOString(),
      jalaliExportedAt: getFormattedJalali().fullPersian,
      data: { graphs, admins, operator, supervisions, units, assetRebuildables }
    };

    const str = JSON.stringify(backupData, null, 2);
    const blob = new Blob([str], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Automation_Backup_${getFormattedJalali().dateNumStr.replace(/\//g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('فایل پشتیبان JSON با موفقیت دریافت گردید', 'success');
  } catch (err) {
    console.error('Backup error', err);
    showToast('خطا در تهیه فایل پشتیبان', 'error');
  }
}

async function handleRestoreFile(e) {
  if (!canAccessBackup()) {
    showToast('دسترسی غیرمجاز: شما مجوز دسترسی به ماژول بازنشانی اطلاعات را ندارید', 'error');
    if (e && e.target) e.target.value = '';
    return;
  }
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  if (!confirm('آیا مطمئن هستید؟ بازنشانی پشتیبان ممکن است رکوردهای قبلی را به‌روزرسانی کند.')) {
    e.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      if (!parsed || !parsed.data || !Array.isArray(parsed.data.graphs)) {
        showToast('فرمت فایل پشتیبان نامعتبر است', 'error');
        return;
      }

      for (const item of parsed.data.graphs) {
        await updateGraphRecord(item);
      }

      if (Array.isArray(parsed.data.admins)) {
        for (const admin of parsed.data.admins) {
          await saveAdminUser(admin);
        }
      }

      if (parsed.data.operator) {
        localStorage.setItem('automation_operator_profile', JSON.stringify(parsed.data.operator));
        loadOperatorProfile();
      }

      if (Array.isArray(parsed.data.supervisions)) {
        saveStoredSupervisions(parsed.data.supervisions);
      }

      if (Array.isArray(parsed.data.units)) {
        saveStoredUnits(parsed.data.units);
      }

      if (Array.isArray(parsed.data.assetRebuildables)) {
        await saveMultipleAssetRebuildablesToDB(parsed.data.assetRebuildables);
        window.AppState.assetRecords = parsed.data.assetRebuildables;
      }

      showToast(`بازنشانی با موفقیت انجام شد: ${parsed.data.graphs.length} رکورد بازیابی گردید.`, 'success');
      loadAdminReports();
      loadAdminUsersList();
      renderOrgManagementUI();
      populateOrgDropdowns();
      updatePendingQueueCount();
      if (typeof renderAssetRebuildableUI === 'function') {
        renderAssetRebuildableUI();
      }
    } catch (err) {
      console.error('Restore error', err);
      showToast('خطا در پردازش فایل پشتیبان', 'error');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
}

// ==========================================
// ۱۸. مدیریت مدیران توسط Super Admin با تفکیک دقیق حوزه دسترسی (RBAC)
// ==========================================
async function loadAdminUsersList() {
  const container = document.getElementById('adminUsersListContainer');
  if (!container) return;

  try {
    const list = await getAdminsList();
    container.innerHTML = '';

    // ۱. ردیف مدیر ارشد سیستم (admin)
    const superRow = document.createElement('div');
    superRow.className = 'p-3.5 rounded-xl bg-slate-900/80 border border-amber-500/30 shadow-sm space-y-2';
    superRow.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="font-extrabold text-amber-300 text-sm">احسان ابوالقاسمی (مدیر نرم افزار )</span>
          <span class="text-[11px] bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded-md font-bold">مدیر ارشد (admin)</span>
        </div>
        <span class="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded font-bold">دسترسی جامع و نامحدود</span>
      </div>
      <div class="text-xs text-slate-400 font-mono">نام کاربری: admin</div>
      <div class="text-[11px] text-emerald-400 font-sans font-medium flex items-center gap-1.5">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block"></span>
        <span>حوزه دسترسی سازمانی: تمام سرپرستی‌ها و تمام واحدهای سازمان</span>
      </div>
      <div class="flex flex-wrap gap-1.5 pt-1 border-t border-slate-800/80">
        <span class="text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded font-bold">✓ تعریف سرپرستی‌ها و واحدها</span>
        <span class="text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded font-bold">✓ تعریف و سطوح مدیران</span>
        <span class="text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded font-bold">✓ پشتیبان‌گیری و بازنشانی</span>
        <span class="text-[10px] bg-teal-500/10 text-teal-300 border border-teal-500/30 px-2 py-0.5 rounded font-bold">✓ ماژول پرسنل (کامل)</span>
        <span class="text-[10px] bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 px-2 py-0.5 rounded font-bold">✓ ماژول asset &Rebuildble (کامل)</span>
      </div>
    `;
    container.appendChild(superRow);

    // ۲. ردیف مدیر اتوماسیون و ارتباطات (مهندس محسن جعفری - نام کاربری 417734)
    const managerRow = document.createElement('div');
    managerRow.className = 'p-3.5 rounded-xl bg-slate-900/80 border border-cyan-500/30 shadow-sm space-y-2';
    managerRow.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="font-extrabold text-cyan-300 text-sm">مهندس محسن جعفری (مدیراتوماسیون و ارتباطات )</span>
          <span class="text-[11px] bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 px-2 py-0.5 rounded-md font-bold">مدیر ارشد (417734)</span>
        </div>
        <span class="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded font-bold">دسترسی جامع و نامحدود</span>
      </div>
      <div class="text-xs text-slate-400 font-mono">نام کاربری: 417734</div>
      <div class="text-[11px] text-emerald-400 font-sans font-medium flex items-center gap-1.5">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block"></span>
        <span>حوزه دسترسی سازمانی: تمام سرپرستی‌ها و تمام واحدهای سازمان</span>
      </div>
      <div class="flex flex-wrap gap-1.5 pt-1 border-t border-slate-800/80">
        <span class="text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded font-bold">✓ دسترسی کامل به همه ماژول‌ها</span>
        <span class="text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded font-bold">✓ تعریف سرپرستی‌ها و واحدها</span>
        <span class="text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded font-bold">✓ تعریف و سطوح مدیران</span>
        <span class="text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded font-bold">✓ پشتیبان‌گیری و بازنشانی</span>
        <span class="text-[10px] bg-teal-500/10 text-teal-300 border border-teal-500/30 px-2 py-0.5 rounded font-bold">✓ ماژول پرسنل (کامل)</span>
        <span class="text-[10px] bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 px-2 py-0.5 rounded font-bold">✓ ماژول asset &Rebuildble (کامل)</span>
      </div>
    `;
    container.appendChild(managerRow);

    const subAdmins = list.filter((a) => a.username !== 'admin' && a.username !== '417734' && a.username !== '417737');

    if (subAdmins.length === 0) {
      const p = document.createElement('div');
      p.className = 'text-xs text-slate-400 p-3.5 text-center bg-slate-900/30 rounded-xl border border-dashed border-slate-800';
      p.textContent = 'مدیر فرعی دیگری هنوز تعریف نشده است. از فرم بالا برای تعریف مدیر با حوزه و دسترسی‌های مشخص استفاده نمایید.';
      container.appendChild(p);
      return;
    }

    subAdmins.forEach((admin) => {
      const isGlobalSup = !admin.supervision || admin.supervision === 'همه سرپرستی‌ها' || admin.supervision === 'کل سرپرستی‌ها';
      const isGlobalUnit = !admin.unit || admin.unit === 'همه واحدها' || admin.unit === 'کل واحدها' || admin.unit === 'همه واحدهای سرپرستی';

      let scopeBadgeHtml = '';
      let scopeDescHtml = '';

      if (isGlobalSup && isGlobalUnit) {
        scopeBadgeHtml = '<span class="text-[11px] bg-purple-950/80 text-purple-300 border border-purple-800 px-2 py-0.5 rounded font-bold">کل سازمان</span>';
        scopeDescHtml = 'دسترسی نامحدود به تمامی سرپرستی‌ها و واحدها';
      } else if (!isGlobalSup && isGlobalUnit) {
        scopeBadgeHtml = '<span class="text-[11px] bg-blue-950/80 text-blue-300 border border-blue-800 px-2 py-0.5 rounded font-bold">سرپرستی (همه واحدها)</span>';
        scopeDescHtml = `سرپرستی: <strong class="text-slate-100">${admin.supervision}</strong> (تمام واحدهای زیرمجموعه)`;
      } else if (!isGlobalSup && !isGlobalUnit) {
        scopeBadgeHtml = '<span class="text-[11px] bg-amber-950/80 text-amber-300 border border-amber-800 px-2 py-0.5 rounded font-bold">تک‌واحدی</span>';
        scopeDescHtml = `سرپرستی: <strong class="text-slate-100">${admin.supervision}</strong> ➔ واحد: <strong class="text-amber-300">${admin.unit}</strong>`;
      } else {
        scopeBadgeHtml = `<span class="text-[11px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-bold">واحد: ${admin.unit}</span>`;
        scopeDescHtml = `محدود به واحد ${admin.unit}`;
      }

      const hasOrgPerm = !!(admin.permissions && admin.permissions.orgManage);
      const hasAdminPerm = !!(admin.permissions && admin.permissions.adminManage);
      const hasBackupPerm = !!(admin.permissions && admin.permissions.backup);
      const hasPersonnelPerm = !!(admin.permissions && admin.permissions.personnelManage);
      const hasAssetPerm = !(admin.permissions && admin.permissions.assetRebuildable === false);

      const row = document.createElement('div');
      row.className = 'p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition space-y-2.5';
      row.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <span class="font-bold text-slate-200 text-sm">${escapeHtml(admin.fullName || admin.username)}</span>
              ${scopeBadgeHtml}
            </div>
            <div class="text-xs text-slate-400 font-mono">نام کاربری: ${escapeHtml(admin.username)}</div>
            <div class="text-[11px] text-slate-300 font-sans mt-0.5">${scopeDescHtml}</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button type="button" onclick="openEditAdminModal('${escapeHtml(admin.username)}')" class="px-2.5 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 transition flex items-center gap-1 text-xs font-bold shadow-sm" title="ویرایش مشخصات، کلمه عبور، واحد و دسترسی‌های مدیر با حفظ تنظیمات قبلی">
              <svg class="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
              <span>ویرایش</span>
            </button>
            <button type="button" onclick="confirmDeleteAdmin('${escapeHtml(admin.username)}')" class="p-1.5 rounded-lg bg-red-950/60 hover:bg-red-900 text-red-400 hover:text-red-200 transition" title="حذف مدیر">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        </div>

        <!-- نوار وضعیت و کلیدهای اعطا / سلب دسترسی ماژول‌ها توسط admin -->
        <div class="flex flex-col gap-1.5 pt-2 border-t border-slate-800/80">
          <div class="flex items-center justify-between text-[11px] text-slate-400">
            <span class="font-bold text-slate-300">سطوح دسترسی به ماژول‌ها (کلیک جهت اعطا یا سلب):</span>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <!-- ۱. دسترسی به تب پرسنل (درخواستی کاربر) -->
            <button type="button" onclick="toggleAdminModulePermission('${escapeHtml(admin.username)}', 'personnelManage')" class="px-2.5 py-1 text-[11px] rounded-lg border font-medium transition inline-flex items-center gap-1.5 ${hasPersonnelPerm ? 'bg-teal-950/80 hover:bg-teal-900 border-teal-600/80 text-teal-300 shadow-sm' : 'bg-slate-950/60 hover:bg-slate-800 border-slate-800 text-slate-500 hover:text-slate-300'}" title="کلیک جهت ${hasPersonnelPerm ? 'سلب' : 'اعطای'} دسترسی به ماژول پرسنل">
              <span class="w-2 h-2 rounded-full ${hasPersonnelPerm ? 'bg-teal-400 shadow-[0_0_6px_#2dd4bf]' : 'bg-slate-600'}"></span>
              <span>تب پرسنل: <strong class="${hasPersonnelPerm ? 'text-teal-200 font-bold' : 'text-slate-400'}">${hasPersonnelPerm ? 'مجاز ✓' : 'مسدود ✕'}</strong></span>
            </button>

            <!-- ۲. دسترسی به ماژول ساختار سازمانی (سرپرستی و واحدها) -->
            <button type="button" onclick="toggleAdminModulePermission('${escapeHtml(admin.username)}', 'orgManage')" class="px-2.5 py-1 text-[11px] rounded-lg border font-medium transition inline-flex items-center gap-1.5 ${hasOrgPerm ? 'bg-emerald-950/80 hover:bg-emerald-900 border-emerald-600/80 text-emerald-300 shadow-sm' : 'bg-slate-950/60 hover:bg-slate-800 border-slate-800 text-slate-500 hover:text-slate-300'}" title="کلیک جهت ${hasOrgPerm ? 'سلب' : 'اعطای'} دسترسی به ماژول سرپرستی و واحدها">
              <span class="w-2 h-2 rounded-full ${hasOrgPerm ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-slate-600'}"></span>
              <span>سرپرستی و واحدها: <strong class="${hasOrgPerm ? 'text-emerald-200 font-bold' : 'text-slate-400'}">${hasOrgPerm ? 'مجاز ✓' : 'مسدود ✕'}</strong></span>
            </button>

            <!-- ۳. دسترسی به ماژول تعریف مدیران -->
            <button type="button" onclick="toggleAdminModulePermission('${escapeHtml(admin.username)}', 'adminManage')" class="px-2.5 py-1 text-[11px] rounded-lg border font-medium transition inline-flex items-center gap-1.5 ${hasAdminPerm ? 'bg-blue-950/80 hover:bg-blue-900 border-blue-600/80 text-blue-300 shadow-sm' : 'bg-slate-950/60 hover:bg-slate-800 border-slate-800 text-slate-500 hover:text-slate-300'}" title="کلیک جهت ${hasAdminPerm ? 'سلب' : 'اعطای'} دسترسی به ماژول تعریف مدیران">
              <span class="w-2 h-2 rounded-full ${hasAdminPerm ? 'bg-blue-400 shadow-[0_0_6px_#60a5fa]' : 'bg-slate-600'}"></span>
              <span>تعریف مدیران: <strong class="${hasAdminPerm ? 'text-blue-200 font-bold' : 'text-slate-400'}">${hasAdminPerm ? 'مجاز ✓' : 'مسدود ✕'}</strong></span>
            </button>

            <!-- ۴. دسترسی به ماژول پشتیبان‌گیری -->
            <button type="button" onclick="toggleAdminModulePermission('${escapeHtml(admin.username)}', 'backup')" class="px-2.5 py-1 text-[11px] rounded-lg border font-medium transition inline-flex items-center gap-1.5 ${hasBackupPerm ? 'bg-amber-950/80 hover:bg-amber-900 border-amber-600/80 text-amber-300 shadow-sm' : 'bg-slate-950/60 hover:bg-slate-800 border-slate-800 text-slate-500 hover:text-slate-300'}" title="کلیک جهت ${hasBackupPerm ? 'سلب' : 'اعطای'} دسترسی به ماژول پشتیبان‌گیری">
              <span class="w-2 h-2 rounded-full ${hasBackupPerm ? 'bg-amber-400 shadow-[0_0_6px_#fbbf24]' : 'bg-slate-600'}"></span>
              <span>پشتیبان‌گیری: <strong class="${hasBackupPerm ? 'text-amber-200 font-bold' : 'text-slate-400'}">${hasBackupPerm ? 'مجاز ✓' : 'مسدود ✕'}</strong></span>
            </button>

            <!-- ۵. دسترسی به ماژول asset &Rebuildble -->
            <button type="button" onclick="toggleAdminModulePermission('${escapeHtml(admin.username)}', 'assetRebuildable')" class="px-2.5 py-1 text-[11px] rounded-lg border font-medium transition inline-flex items-center gap-1.5 ${hasAssetPerm ? 'bg-cyan-950/80 hover:bg-cyan-900 border-cyan-600/80 text-cyan-300 shadow-sm' : 'bg-slate-950/60 hover:bg-slate-800 border-slate-800 text-slate-500 hover:text-slate-300'}" title="کلیک جهت ${hasAssetPerm ? 'سلب' : 'اعطای'} دسترسی به ماژول asset &Rebuildble">
              <span class="w-2 h-2 rounded-full ${hasAssetPerm ? 'bg-cyan-400 shadow-[0_0_6px_#22d3ee]' : 'bg-slate-600'}"></span>
              <span>asset &Rebuildble: <strong class="${hasAssetPerm ? 'text-cyan-200 font-bold' : 'text-slate-400'}">${hasAssetPerm ? 'مجاز ✓' : 'مسدود ✕'}</strong></span>
            </button>
          </div>
        </div>
      `;
      container.appendChild(row);
    });
  } catch (err) {
    console.error('Error loading admins', err);
  }
}

function onNewAdminSupervisionChange() {
  const supSelect = document.getElementById('newAdminSupervision');
  const unitSelect = document.getElementById('newAdminUnit');
  if (!supSelect || !unitSelect) return;

  const selectedSup = supSelect.value.trim();
  const allUnits = getStoredUnits();

  unitSelect.innerHTML = '';

  if (!selectedSup || selectedSup === 'همه سرپرستی‌ها' || selectedSup === 'کل سرپرستی‌ها') {
    const opt = document.createElement('option');
    opt.value = 'همه واحدها';
    opt.textContent = 'همه واحدها (دسترسی نامحدود به کل سازمان)';
    unitSelect.appendChild(opt);
  } else {
    // سرپرستی خاص انتخاب شده است
    const allInSupOpt = document.createElement('option');
    allInSupOpt.value = 'همه واحدها';
    allInSupOpt.textContent = `همه واحدهای این سرپرستی (دسترسی به کل زیرمجموعه)`;
    unitSelect.appendChild(allInSupOpt);

    const filteredUnits = allUnits.filter((u) => !u.supervision || u.supervision === selectedSup);
    filteredUnits.forEach((u) => {
      const opt = document.createElement('option');
      opt.value = u.name;
      opt.textContent = `فقط واحد اختصاصی: ${u.name}`;
      unitSelect.appendChild(opt);
    });

    if (filteredUnits.length === 0) {
      allUnits.forEach((u) => {
        const opt = document.createElement('option');
        opt.value = u.name;
        opt.textContent = `واحد: ${u.name}`;
        unitSelect.appendChild(opt);
      });
    }
  }

  updateNewAdminScopeHint();
}

function updateNewAdminScopeHint() {
  const supSelect = document.getElementById('newAdminSupervision');
  const unitSelect = document.getElementById('newAdminUnit');
  const hintText = document.getElementById('newAdminScopePreviewText');
  if (!supSelect || !unitSelect || !hintText) return;

  const sup = supSelect.value.trim();
  const unit = unitSelect.value.trim();

  const isGlobalSup = !sup || sup === 'همه سرپرستی‌ها' || sup === 'کل سرپرستی‌ها';
  const isGlobalUnit = !unit || unit === 'همه واحدها' || unit === 'کل واحدها' || unit === 'همه واحدهای سرپرستی';

  let scopePart = '';
  if (isGlobalSup && isGlobalUnit) {
    scopePart = '<span class="text-emerald-400 font-bold">✓ دسترسی سازمانی:</span> دسترسی کامل به اطلاعات و گراف‌های ثبت‌شده در <strong class="text-slate-100">تمامی سرپرستی‌ها و تمامی واحدهای سازمان</strong>.';
  } else if (!isGlobalSup && isGlobalUnit) {
    scopePart = `<span class="text-blue-400 font-bold">✓ دسترسی سرپرستی:</span> دسترسی به تمامی اطلاعات و گراف‌های ثبت‌شده برای <strong class="text-slate-100">کل واحدهای زیرمجموعه «${sup}»</strong>.`;
  } else if (!isGlobalSup && !isGlobalUnit) {
    scopePart = `<span class="text-amber-400 font-bold">✓ دسترسی تک‌واحدی:</span> منحصراً به اطلاعات ثبت‌شده برای واحد <strong class="text-amber-300 font-extrabold">«${unit}»</strong> در سرپرستی «${sup}».`;
  } else {
    scopePart = `<span class="text-amber-400 font-bold">✓ دسترسی واحد:</span> محدود به واحد «${unit}».`;
  }

  // ماژول‌های انتخابی
  const permOrg = document.getElementById('permOrgManage')?.checked;
  const permAdmin = document.getElementById('permAdminManage')?.checked;
  const permBackup = document.getElementById('permBackup')?.checked;
  const permPersonnel = document.getElementById('permPersonnelManage')?.checked;
  const permAsset = document.getElementById('permAssetRebuildable')?.checked;

  const selectedModules = [];
  if (permPersonnel) selectedModules.push('بانک اطلاعات پرسنل (تب پرسنل)');
  if (permOrg) selectedModules.push('تعریف سرپرستی‌ها و واحدها');
  if (permAdmin) selectedModules.push('تعریف و سطوح مدیران');
  if (permBackup) selectedModules.push('پشتیبان‌گیری و بازنشانی');
  if (permAsset) selectedModules.push('ماژول asset &Rebuildble');

  let modulesPart = '';
  if (selectedModules.length > 0) {
    modulesPart = `<div class="mt-2 pt-2 border-t border-slate-800 text-[11px] text-teal-300 flex items-center gap-1.5 flex-wrap"><span class="font-bold text-slate-300">ماژول‌های مجاز اعطاشده:</span> ${selectedModules.map(m => `<span class="px-2 py-0.5 rounded bg-teal-950/70 border border-teal-800 font-medium">${m}</span>`).join(' ')}</div>`;
  } else {
    modulesPart = `<div class="mt-2 pt-2 border-t border-slate-800 text-[11px] text-slate-400">این مدیر فاقد دسترسی به ماژول‌های ویژه (تب پرسنل، سرپرستی‌ها، پشتیبان‌گیری) بوده و صرفاً به تب گزارش‌ها دسترسی خواهد داشت.</div>`;
  }

  hintText.innerHTML = `<div>${scopePart}</div>${modulesPart}`;
}

async function handleCreateNewAdmin(e) {
  e.preventDefault();
  if (!canAccessAdminManage()) {
    showToast('دسترسی غیرمجاز: تنها کاربر admin یا مدیران مجاز به ماژول مدیریت مدیران، امکان تعریف مدیر جدید دارند', 'error');
    return;
  }
  const fullName = document.getElementById('newAdminFullName').value.trim();
  const username = document.getElementById('newAdminUsername').value.trim().toLowerCase();
  const password = document.getElementById('newAdminPassword').value.trim();
  const unit = document.getElementById('newAdminUnit').value.trim();
  const supervision = document.getElementById('newAdminSupervision').value.trim();

  // دریافت مجوزهای ماژول‌های ویژه انتخابی توسط admin
  const permOrgManage = document.getElementById('permOrgManage')?.checked || false;
  const permAdminManage = document.getElementById('permAdminManage')?.checked || false;
  const permBackup = document.getElementById('permBackup')?.checked || false;
  const permPersonnelManage = document.getElementById('permPersonnelManage')?.checked || false;
  const permAssetRebuildable = document.getElementById('permAssetRebuildable')?.checked || false;

  if (!username || !password) {
    showToast('نام کاربری و رمز عبور الزامی است', 'error');
    return;
  }
  if (username === 'admin' || username === '417734' || username === '417737') {
    showToast('نام کاربری admin و 417734 مخصوص مدیران ارشد سیستم است', 'error');
    return;
  }

  const newAdmin = {
    fullName: fullName || username,
    username,
    password,
    unit: unit || 'همه واحدها',
    supervision: supervision || 'همه سرپرستی‌ها',
    permissions: {
      orgManage: permOrgManage,
      adminManage: permAdminManage,
      backup: permBackup,
      personnelManage: permPersonnelManage,
      assetRebuildable: permAssetRebuildable
    },
    createdAt: new Date().toISOString()
  };

  try {
    await saveAdminUser(newAdmin);
    showToast(`مدیر جدید با نام کاربری «${username}» و دسترسی‌های تعیین‌شده با موفقیت ثبت شد`, 'success');
    document.getElementById('newAdminForm').reset();
    populateOrgDropdowns();
    updateNewAdminScopeHint();
    loadAdminUsersList();
  } catch (err) {
    console.error('Admin create error', err);
    showToast('خطا در ذخیره‌سازی مدیر جدید', 'error');
  }
}

async function confirmDeleteAdmin(username) {
  if (!canAccessAdminManage()) {
    showToast('دسترسی غیرمجاز: شما مجوز حذف مدیران را ندارید', 'error');
    return;
  }
  if (confirm(`آیا از حذف مدیر با نام کاربری "${username}" اطمینان دارید؟`)) {
    try {
      await deleteAdminUser(username);
      showToast('مدیر حذف گردید', 'success');
      loadAdminUsersList();
    } catch (e) {
      showToast('خطا در حذف مدیر', 'error');
    }
  }
}

// تغییر وضعیت دسترسی ماژول‌های ویژه برای مدیران توسط admin
async function toggleAdminModulePermission(username, moduleKey) {
  if (!canAccessAdminManage()) {
    showToast('تنها کاربر admin مجوز تغییر دسترسی‌های مدیران را دارد', 'error');
    return;
  }
  try {
    const admins = await getAdminsList();
    const admin = admins.find(a => a.username === username);
    if (!admin) {
      showToast('مدیر مورد نظر یافت نشد', 'error');
      return;
    }
    if (!admin.permissions) admin.permissions = {};
    const newStatus = (admin.permissions[moduleKey] !== undefined) ? !admin.permissions[moduleKey] : false;
    admin.permissions[moduleKey] = newStatus;
    await saveAdminUser(admin);

    const labels = {
      personnelManage: 'ماژول بانک پرسنل',
      orgManage: 'ماژول سرپرستی و واحدها',
      adminManage: 'ماژول تعریف مدیران',
      backup: 'ماژول پشتیبان‌گیری',
      assetRebuildable: 'ماژول asset &Rebuildble'
    };
    const modLabel = labels[moduleKey] || moduleKey;
    showToast(`دسترسی به «${modLabel}» برای مدیر «${admin.fullName || username}» ${newStatus ? 'اعطا شد (فعال)' : 'سلب گردید (مسدود)'}`, 'success');

    // اگر خود کاربر در حال حاضر با این نام کاربری لاگین است، وضعیت سشن و تب‌ها بلافاصله به‌روزرسانی شود
    if (window.AppState.currentUser && window.AppState.currentUser.username === username) {
      window.AppState.currentUser.permissions[moduleKey] = newStatus;
      sessionStorage.setItem('automation_admin_session', JSON.stringify(window.AppState.currentUser));
      const tabBtnMap = {
        personnelManage: 'tabBtnPersonnelManage',
        orgManage: 'tabBtnOrgManage',
        adminManage: 'tabBtnAdminManage',
        backup: 'tabBtnBackup',
        assetRebuildable: 'tabBtnAssetRebuildable'
      };
      const btn = document.getElementById(tabBtnMap[moduleKey]);
      if (btn) {
        if (newStatus) btn.classList.remove('hidden');
        else btn.classList.add('hidden');
      }
    }

    loadAdminUsersList();
  } catch (e) {
    console.error('Error toggling admin module permission:', e);
    showToast('خطا در تغییر دسترسی مدیر', 'error');
  }
}

async function toggleAdminPersonnelAccess(username) {
  return toggleAdminModulePermission(username, 'personnelManage');
}

// ==========================================
// ۱۸.۱. ویرایش اطلاعات، رمز عبور و دسترسی‌های مدیر با حفظ تنظیمات قبلی
// ==========================================
async function openEditAdminModal(username) {
  if (!canAccessAdminManage()) {
    showToast('دسترسی غیرمجاز: تنها کاربر admin یا مدیران مجاز امکان ویرایش مدیران را دارند', 'error');
    return;
  }
  try {
    const admins = await getAdminsList();
    const admin = admins.find(a => a.username === username);
    if (!admin) {
      showToast('مدیر مورد نظر یافت نشد', 'error');
      return;
    }

    // ۱. پر کردن مشخصات اولیه مدیر با حفظ تنظیمات قبلی
    const fullNameInp = document.getElementById('editAdminFullName');
    const userInp = document.getElementById('editAdminUsername');
    const passInp = document.getElementById('editAdminPassword');
    const supSelect = document.getElementById('editAdminSupervision');

    if (fullNameInp) fullNameInp.value = admin.fullName || admin.username;
    if (userInp) userInp.value = admin.username;
    if (passInp) passInp.value = ''; // رمز خالی یعنی حفظ رمز فعلی مدیر

    // ۲. پر کردن لیست سرپرستی‌ها و انتخاب مقدار قبلی
    const supervisions = getStoredSupervisions();
    if (supSelect) {
      supSelect.innerHTML = '<option value="همه سرپرستی‌ها">همه سرپرستی‌ها (کل سازمان)</option>';
      supervisions.forEach((sup) => {
        const opt = document.createElement('option');
        opt.value = sup;
        opt.textContent = sup;
        supSelect.appendChild(opt);
      });
      supSelect.value = admin.supervision || 'همه سرپرستی‌ها';
    }

    // ۳. پر کردن لیست واحدهای وابسته و انتخاب واحد قبلی مدیر
    populateEditAdminUnitsDropdown(admin.unit || 'همه واحدها');

    // ۴. بارگذاری دسترسی‌های قبلی مدیر در چک‌باکس‌ها (حفظ وضعیت پیشین)
    const perms = admin.permissions || {};
    const chkPersonnel = document.getElementById('editPermPersonnelManage');
    const chkOrg = document.getElementById('editPermOrgManage');
    const chkAdmin = document.getElementById('editPermAdminManage');
    const chkBackup = document.getElementById('editPermBackup');
    const chkAsset = document.getElementById('editPermAssetRebuildable');

    if (chkPersonnel) chkPersonnel.checked = !!perms.personnelManage;
    if (chkOrg) chkOrg.checked = !!perms.orgManage;
    if (chkAdmin) chkAdmin.checked = !!perms.adminManage;
    if (chkBackup) chkBackup.checked = !!perms.backup;
    if (chkAsset) chkAsset.checked = (perms.assetRebuildable !== undefined) ? !!perms.assetRebuildable : true;

    // ۵. به‌روزرسانی پیش‌نمایش زنده سطح دسترسی و گشودن مودال
    updateEditAdminScopeHint();
    openModal('editAdminModal');
  } catch (err) {
    console.error('Error opening edit admin modal:', err);
    showToast('خطا در بارگذاری اطلاعات مدیر جهت ویرایش', 'error');
  }
}

function populateEditAdminUnitsDropdown(targetUnit) {
  const supSelect = document.getElementById('editAdminSupervision');
  const unitSelect = document.getElementById('editAdminUnit');
  if (!supSelect || !unitSelect) return;

  const selectedSup = supSelect.value.trim();
  const allUnits = getStoredUnits();

  unitSelect.innerHTML = '';

  if (!selectedSup || selectedSup === 'همه سرپرستی‌ها' || selectedSup === 'کل سرپرستی‌ها') {
    const opt = document.createElement('option');
    opt.value = 'همه واحدها';
    opt.textContent = 'همه واحدها (دسترسی نامحدود به کل سازمان)';
    unitSelect.appendChild(opt);
  } else {
    const allInSupOpt = document.createElement('option');
    allInSupOpt.value = 'همه واحدها';
    allInSupOpt.textContent = 'همه واحدهای این سرپرستی (دسترسی به کل زیرمجموعه)';
    unitSelect.appendChild(allInSupOpt);

    const filteredUnits = allUnits.filter(u => !u.supervision || u.supervision === selectedSup);
    filteredUnits.forEach((u) => {
      const opt = document.createElement('option');
      opt.value = u.name;
      opt.textContent = `فقط واحد اختصاصی: ${u.name}`;
      unitSelect.appendChild(opt);
    });

    if (filteredUnits.length === 0) {
      allUnits.forEach((u) => {
        const opt = document.createElement('option');
        opt.value = u.name;
        opt.textContent = `واحد: ${u.name}`;
        unitSelect.appendChild(opt);
      });
    }
  }

  if (targetUnit) {
    unitSelect.value = targetUnit;
  }
}

function onEditAdminSupervisionChange() {
  populateEditAdminUnitsDropdown();
  updateEditAdminScopeHint();
}

function updateEditAdminScopeHint() {
  const supSelect = document.getElementById('editAdminSupervision');
  const unitSelect = document.getElementById('editAdminUnit');
  const hintText = document.getElementById('editAdminScopePreviewText');
  if (!supSelect || !unitSelect || !hintText) return;

  const sup = supSelect.value.trim();
  const unit = unitSelect.value.trim();

  const isGlobalSup = !sup || sup === 'همه سرپرستی‌ها' || sup === 'کل سرپرستی‌ها';
  const isGlobalUnit = !unit || unit === 'همه واحدها' || unit === 'کل واحدها' || unit === 'همه واحدهای سرپرستی';

  let scopePart = '';
  if (isGlobalSup && isGlobalUnit) {
    scopePart = '<span class="text-emerald-400 font-bold">✓ دسترسی سازمانی:</span> دسترسی به تمامی اطلاعات و گراف‌های ثبت‌شده در <strong class="text-slate-100">تمامی سرپرستی‌ها و تمامی واحدهای سازمان</strong>.';
  } else if (!isGlobalSup && isGlobalUnit) {
    scopePart = `<span class="text-blue-400 font-bold">✓ دسترسی سرپرستی:</span> دسترسی به تمامی اطلاعات و گراف‌های ثبت‌شده برای <strong class="text-slate-100">کل واحدهای زیرمجموعه «${sup}»</strong>.`;
  } else if (!isGlobalSup && !isGlobalUnit) {
    scopePart = `<span class="text-amber-400 font-bold">✓ دسترسی تک‌واحدی:</span> منحصراً به اطلاعات ثبت‌شده برای واحد <strong class="text-amber-300 font-extrabold">«${unit}»</strong> در سرپرستی «${sup}».`;
  } else {
    scopePart = `<span class="text-amber-400 font-bold">✓ دسترسی واحد:</span> محدود به واحد «${unit}».`;
  }

  const permPersonnel = document.getElementById('editPermPersonnelManage')?.checked;
  const permOrg = document.getElementById('editPermOrgManage')?.checked;
  const permAdmin = document.getElementById('editPermAdminManage')?.checked;
  const permBackup = document.getElementById('editPermBackup')?.checked;
  const permAsset = document.getElementById('editPermAssetRebuildable')?.checked;

  const selectedModules = [];
  if (permPersonnel) selectedModules.push('بانک اطلاعات پرسنل (تب پرسنل)');
  if (permOrg) selectedModules.push('تعریف سرپرستی‌ها و واحدها');
  if (permAdmin) selectedModules.push('تعریف و سطوح مدیران');
  if (permBackup) selectedModules.push('پشتیبان‌گیری و بازنشانی');
  if (permAsset) selectedModules.push('ماژول asset &Rebuildble');

  let modulesPart = '';
  if (selectedModules.length > 0) {
    modulesPart = `<div class="mt-2 pt-2 border-t border-slate-800 text-[11px] text-teal-300 flex items-center gap-1.5 flex-wrap"><span class="font-bold text-slate-300">ماژول‌های مجاز اعطاشده:</span> ${selectedModules.map(m => `<span class="px-2 py-0.5 rounded bg-teal-950/70 border border-teal-800 font-medium">${m}</span>`).join(' ')}</div>`;
  } else {
    modulesPart = `<div class="mt-2 pt-2 border-t border-slate-800 text-[11px] text-slate-400">این مدیر فاقد دسترسی به ماژول‌های ویژه بوده و صرفاً به تب گزارش‌ها دسترسی خواهد داشت.</div>`;
  }

  hintText.innerHTML = `<div>${scopePart}</div>${modulesPart}`;
}

async function handleEditAdminSubmit(e) {
  e.preventDefault();
  if (!canAccessAdminManage()) {
    showToast('دسترسی غیرمجاز: تنها کاربر admin یا مدیران مجاز امکان ویرایش مدیران را دارند', 'error');
    return;
  }
  const username = document.getElementById('editAdminUsername')?.value.trim().toLowerCase();
  const fullName = document.getElementById('editAdminFullName')?.value.trim();
  const newPassword = document.getElementById('editAdminPassword')?.value.trim();
  const supervision = document.getElementById('editAdminSupervision')?.value.trim();
  const unit = document.getElementById('editAdminUnit')?.value.trim();

  const permPersonnel = document.getElementById('editPermPersonnelManage')?.checked || false;
  const permOrg = document.getElementById('editPermOrgManage')?.checked || false;
  const permAdmin = document.getElementById('editPermAdminManage')?.checked || false;
  const permBackup = document.getElementById('editPermBackup')?.checked || false;
  const permAsset = document.getElementById('editPermAssetRebuildable')?.checked || false;

  if (!username) {
    showToast('شناسه کاربری نامعتبر است', 'error');
    return;
  }

  try {
    const admins = await getAdminsList();
    const existing = admins.find(a => a.username === username);
    if (!existing) {
      showToast('مدیر مورد نظر جهت ویرایش یافت نشد', 'error');
      return;
    }

    // بروزرسانی مشخصات با حفظ تنظیمات و مقادیر قبلی
    existing.fullName = fullName || existing.fullName || username;
    if (newPassword) {
      existing.password = newPassword; // فقط در صورت وارد کردن مقدار جدید تغییر می‌کند
    }
    existing.supervision = supervision || existing.supervision || 'همه سرپرستی‌ها';
    existing.unit = unit || existing.unit || 'همه واحدها';
    existing.permissions = {
      personnelManage: permPersonnel,
      orgManage: permOrg,
      adminManage: permAdmin,
      backup: permBackup,
      assetRebuildable: permAsset
    };
    existing.updatedAt = new Date().toISOString();

    await saveAdminUser(existing);

    // اگر مدیر جاری همان کاربر ویرایش‌شده باشد، سشن فعال نیز بلافاصله به‌روزرسانی شود
    if (window.AppState.currentUser && window.AppState.currentUser.username === username) {
      window.AppState.currentUser = { ...existing };
      sessionStorage.setItem('automation_admin_session', JSON.stringify(window.AppState.currentUser));
      const tabBtnMap = {
        personnelManage: 'tabBtnPersonnelManage',
        orgManage: 'tabBtnOrgManage',
        adminManage: 'tabBtnAdminManage',
        backup: 'tabBtnBackup',
        assetRebuildable: 'tabBtnAssetRebuildable'
      };
      Object.keys(tabBtnMap).forEach((key) => {
        const btn = document.getElementById(tabBtnMap[key]);
        if (btn) {
          if (existing.permissions[key]) btn.classList.remove('hidden');
          else btn.classList.add('hidden');
        }
      });
    }

    closeModal('editAdminModal');
    showToast(`اطلاعات و سطوح دسترسی مدیر «${existing.fullName || username}» با موفقیت به‌روزرسانی شد`, 'success');
    loadAdminUsersList();
  } catch (err) {
    console.error('Error saving edited admin:', err);
    showToast('خطا در ذخیره‌سازی تغییرات مدیر', 'error');
  }
}

// ==========================================
// ۱۹. مدیریت سرپرستی‌ها و واحدهای سازمانی (Org Structure)
// ==========================================
var ORG_STRUCTURE_VERSION = 'v3_telecom_tech_workshops';

var DEFAULT_SUPERVISIONS = [
  'سرپرستی مخابرات',
  'سرپرستی خدمات فنی',
  'سرپرستی اتوماسیون کارگاه ها'
];

var DEFAULT_UNITS = [
  // سرپرستی مخابرات
  { name: 'واحد اعلام حریق', supervision: 'سرپرستی مخابرات' },
  { name: 'واحد صوتی و تصویری', supervision: 'سرپرستی مخابرات' },
  { name: 'واحد شبکه مخابرات', supervision: 'سرپرستی مخابرات' },
  { name: 'واحد اسکادا', supervision: 'سرپرستی مخابرات' },
  { name: 'واحد تعمیرگاه مخابرات', supervision: 'سرپرستی مخابرات' },
  { name: 'واحد مراکز تلفن', supervision: 'سرپرستی مخابرات' },

  // سرپرستی خدمات فنی
  { name: 'واحد توزین', supervision: 'سرپرستی خدمات فنی' },
  { name: 'واحد کارگاه مکانیک', supervision: 'سرپرستی خدمات فنی' },
  { name: 'واحد ابزار دقیق', supervision: 'سرپرستی خدمات فنی' },
  { name: 'واحد ازمایشگاه الکترونیک و کامپیوتر', supervision: 'سرپرستی خدمات فنی' },

  // سرپرستی اتوماسیون کارگاه ها
  { name: 'اتوماسیون نورد', supervision: 'سرپرستی اتوماسیون کارگاه ها' },
  { name: 'اتوماسیون کک سازی', supervision: 'سرپرستی اتوماسیون کارگاه ها' },
  { name: 'اتوماسیون فولادسازی', supervision: 'سرپرستی اتوماسیون کارگاه ها' },
  { name: 'اتوماسیون آگلومراسیون', supervision: 'سرپرستی اتوماسیون کارگاه ها' },
  { name: 'اتوماسیون نیروگاهها', supervision: 'سرپرستی اتوماسیون کارگاه ها' },
  { name: 'اتوماسیون انرژی', supervision: 'سرپرستی اتوماسیون کارگاه ها' },
  { name: 'اتوماسیون آبرسانی', supervision: 'سرپرستی اتوماسیون کارگاه ها' }
];

function getStoredSupervisions() {
  try {
    const ver = localStorage.getItem('automation_org_version');
    if (ver !== ORG_STRUCTURE_VERSION) {
      localStorage.setItem('automation_org_version', ORG_STRUCTURE_VERSION);
      localStorage.setItem('automation_supervisions', JSON.stringify(DEFAULT_SUPERVISIONS));
      localStorage.setItem('automation_units', JSON.stringify(DEFAULT_UNITS));
      return [...DEFAULT_SUPERVISIONS];
    }
    const raw = localStorage.getItem('automation_supervisions');
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.error('Error reading supervisions', e);
  }
  return [...DEFAULT_SUPERVISIONS];
}

function saveStoredSupervisions(list) {
  localStorage.setItem('automation_supervisions', JSON.stringify(list));
  populateOrgDropdowns();
  renderOrgManagementUI();
}

function getStoredUnits() {
  try {
    const ver = localStorage.getItem('automation_org_version');
    if (ver !== ORG_STRUCTURE_VERSION) {
      localStorage.setItem('automation_org_version', ORG_STRUCTURE_VERSION);
      localStorage.setItem('automation_supervisions', JSON.stringify(DEFAULT_SUPERVISIONS));
      localStorage.setItem('automation_units', JSON.stringify(DEFAULT_UNITS));
      return [...DEFAULT_UNITS];
    }
    const raw = localStorage.getItem('automation_units');
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((u) => (typeof u === 'string' ? { name: u, supervision: '' } : u));
      }
    }
  } catch (e) {
    console.error('Error reading units', e);
  }
  return [...DEFAULT_UNITS];
}

function saveStoredUnits(list) {
  localStorage.setItem('automation_units', JSON.stringify(list));
  populateOrgDropdowns();
  renderOrgManagementUI();
}

function handleCreateSupervision(e) {
  if (e) e.preventDefault();
  if (!canAccessOrgManage()) {
    showToast('دسترسی غیرمجاز: تنها کاربر admin یا مدیران مجاز امکان تعریف سرپرستی‌ها و واحدها را دارند', 'error');
    return;
  }
  const input = document.getElementById('newSupervisionInput');
  const name = input ? input.value.trim() : '';
  if (!name) {
    showToast('لطفاً عنوان سرپرستی را وارد کنید', 'error');
    return;
  }
  const current = getStoredSupervisions();
  if (current.includes(name)) {
    showToast('این سرپرستی قبلاً در سامانه ثبت شده است', 'warning');
    return;
  }
  current.push(name);
  saveStoredSupervisions(current);
  if (input) input.value = '';
  showToast(`سرپرستی «${name}» با موفقیت اضافه شد`, 'success');
}

function handleDeleteSupervision(index) {
  if (!canAccessOrgManage()) {
    showToast('دسترسی غیرمجاز: شما مجوز حذف سرپرستی‌ها را ندارید', 'error');
    return;
  }
  const current = getStoredSupervisions();
  const item = current[index];
  if (!item) return;
  if (confirm(`آیا از حذف سرپرستی «${item}» اطمینان دارید؟`)) {
    current.splice(index, 1);
    saveStoredSupervisions(current);
    showToast(`سرپرستی «${item}» حذف گردید`, 'info');
  }
}

function handleEditSupervision(index) {
  if (!canAccessOrgManage()) {
    showToast('دسترسی غیرمجاز: شما مجوز ویرایش سرپرستی‌ها را ندارید', 'error');
    return;
  }
  const current = getStoredSupervisions();
  const item = current[index];
  if (!item) return;
  const newName = prompt('عنوان جدید سرپرستی را وارد نمایید:', item);
  if (newName && newName.trim() && newName.trim() !== item) {
    const cleanName = newName.trim();
    current[index] = cleanName;
    const units = getStoredUnits();
    units.forEach((u) => {
      if (u.supervision === item) u.supervision = cleanName;
    });
    localStorage.setItem('automation_units', JSON.stringify(units));
    saveStoredSupervisions(current);
    showToast('عنوان سرپرستی با موفقیت ویرایش شد', 'success');
  }
}

function handleCreateUnit(e) {
  if (e) e.preventDefault();
  if (!canAccessOrgManage()) {
    showToast('دسترسی غیرمجاز: تنها کاربر admin یا مدیران مجاز امکان تعریف واحدها را دارند', 'error');
    return;
  }
  const input = document.getElementById('newUnitInput');
  const supSelect = document.getElementById('newUnitSupervisionSelect');
  const name = input ? input.value.trim() : '';
  const supervision = supSelect ? supSelect.value : '';

  if (!name) {
    showToast('لطفاً عنوان واحد سازمانی را وارد نمایید', 'error');
    return;
  }
  const current = getStoredUnits();
  if (current.some((u) => u.name === name)) {
    showToast('این واحد قبلاً در سامانه تعریف شده است', 'warning');
    return;
  }
  current.push({ name, supervision });
  saveStoredUnits(current);
  if (input) input.value = '';
  showToast(`واحد سازمانی «${name}» با موفقیت افزوده شد`, 'success');
}

function handleDeleteUnit(index) {
  if (!canAccessOrgManage()) {
    showToast('دسترسی غیرمجاز: شما مجوز حذف واحدها را ندارید', 'error');
    return;
  }
  const current = getStoredUnits();
  const item = current[index];
  if (!item) return;
  if (confirm(`آیا از حذف واحد «${item.name}» اطمینان دارید؟`)) {
    current.splice(index, 1);
    saveStoredUnits(current);
    showToast(`واحد «${item.name}» حذف گردید`, 'info');
  }
}

function handleEditUnit(index) {
  if (!canAccessOrgManage()) {
    showToast('دسترسی غیرمجاز: شما مجوز ویرایش واحدها را ندارید', 'error');
    return;
  }
  const current = getStoredUnits();
  const item = current[index];
  if (!item) return;
  const newName = prompt('عنوان جدید واحد سازمانی را وارد نمایید:', item.name);
  if (newName && newName.trim() && newName.trim() !== item.name) {
    current[index].name = newName.trim();
    saveStoredUnits(current);
    showToast('عنوان واحد با موفقیت ویرایش شد', 'success');
  }
}

function resetOrgStructureToDefault() {
  if (!canAccessOrgManage()) {
    showToast('دسترسی غیرمجاز: شما مجوز بازنشانی ساختار سازمانی را ندارید', 'error');
    return;
  }
  if (confirm('آیا از بازنشانی سرپرستی‌ها و واحدها به مقادیر پیش‌فرض اطمینان دارید؟')) {
    localStorage.setItem('automation_org_version', ORG_STRUCTURE_VERSION);
    saveStoredSupervisions([...DEFAULT_SUPERVISIONS]);
    saveStoredUnits([...DEFAULT_UNITS]);
    showToast('ساختار سازمانی به حالت پیش‌فرض بازنشانی شد', 'success');
  }
}

function renderOrgManagementUI() {
  const supContainer = document.getElementById('supervisionsListContainer');
  const unitContainer = document.getElementById('unitsListContainer');
  const supCountBadge = document.getElementById('supervisionsCountBadge');
  const unitCountBadge = document.getElementById('unitsCountBadge');
  const supSelectInUnitForm = document.getElementById('newUnitSupervisionSelect');

  const supervisions = getStoredSupervisions();
  const units = getStoredUnits();

  if (supCountBadge) supCountBadge.textContent = `${supervisions.length} سرپرستی`;
  if (unitCountBadge) unitCountBadge.textContent = `${units.length} واحد`;

  // رندر لیست سرپرستی‌ها
  if (supContainer) {
    supContainer.innerHTML = '';
    if (supervisions.length === 0) {
      supContainer.innerHTML = '<div class="text-xs text-slate-500 py-3 text-center">هیچ سرپرستی‌ای ثبت نشده است.</div>';
    } else {
      supervisions.forEach((sup, idx) => {
        const itemEl = document.createElement('div');
        itemEl.className = 'flex items-center justify-between p-3 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition';
        itemEl.innerHTML = `
          <div class="flex items-center gap-2.5">
            <span class="w-6 h-6 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 text-xs flex items-center justify-center font-mono font-bold">${idx + 1}</span>
            <span class="text-sm font-semibold text-slate-200">${sup}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" onclick="handleEditSupervision(${idx})" class="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-amber-300 hover:bg-slate-700 transition" title="ویرایش">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
            </button>
            <button type="button" onclick="handleDeleteSupervision(${idx})" class="p-1.5 rounded-lg bg-red-950/60 text-red-400 hover:bg-red-900 hover:text-red-200 transition" title="حذف">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        `;
        supContainer.appendChild(itemEl);
      });
    }
  }

  // رندر انتخاب سرپرستی والد در فرم واحد جدید
  if (supSelectInUnitForm) {
    const prevVal = supSelectInUnitForm.value;
    supSelectInUnitForm.innerHTML = '<option value="">-- بدون سرپرستی والد (مستقل) --</option>';
    supervisions.forEach((sup) => {
      const opt = document.createElement('option');
      opt.value = sup;
      opt.textContent = sup;
      supSelectInUnitForm.appendChild(opt);
    });
    if (prevVal) supSelectInUnitForm.value = prevVal;
  }

  // رندر لیست واحدها
  if (unitContainer) {
    unitContainer.innerHTML = '';
    if (units.length === 0) {
      unitContainer.innerHTML = '<div class="text-xs text-slate-500 py-3 text-center">هیچ واحدی ثبت نشده است.</div>';
    } else {
      units.forEach((unit, idx) => {
        const itemEl = document.createElement('div');
        itemEl.className = 'flex items-center justify-between p-3 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition';
        itemEl.innerHTML = `
          <div>
            <div class="flex items-center gap-2">
              <span class="w-6 h-6 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20 text-xs flex items-center justify-center font-mono font-bold">${idx + 1}</span>
              <span class="text-sm font-semibold text-slate-200">${unit.name}</span>
            </div>
            ${unit.supervision ? `<div class="text-xs text-slate-400 font-sans mt-0.5 pr-8">سرپرستی: ${unit.supervision}</div>` : ''}
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" onclick="handleEditUnit(${idx})" class="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-amber-300 hover:bg-slate-700 transition" title="ویرایش">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
            </button>
            <button type="button" onclick="handleDeleteUnit(${idx})" class="p-1.5 rounded-lg bg-red-950/60 text-red-400 hover:bg-red-900 hover:text-red-200 transition" title="حذف">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        `;
        unitContainer.appendChild(itemEl);
      });
    }
  }
}

function updateModalUnitsDropdown(preserveValue) {
  const modalSupSelect = document.getElementById('modalSupervision');
  const modalUnitSelect = document.getElementById('modalUnit');
  if (!modalUnitSelect) return;

  const selectedSup = modalSupSelect ? modalSupSelect.value.trim() : '';
  const allUnits = getStoredUnits();
  const curVal = preserveValue !== undefined ? preserveValue : modalUnitSelect.value;

  modalUnitSelect.innerHTML = '<option value="">-- انتخاب واحد خدمتی --</option>';

  const filteredUnits = selectedSup
    ? allUnits.filter((u) => !u.supervision || u.supervision === selectedSup)
    : allUnits;

  if (filteredUnits.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.disabled = true;
    opt.textContent = selectedSup
      ? 'واحدی برای این سرپرستی توسط مدیر تعریف نشده است'
      : 'هیچ واحدی توسط مدیر ثبت نشده است';
    modalUnitSelect.appendChild(opt);
  } else {
    filteredUnits.forEach((u) => {
      const opt = document.createElement('option');
      opt.value = u.name;
      opt.textContent = u.supervision && !selectedSup ? `${u.name} (${u.supervision})` : u.name;
      modalUnitSelect.appendChild(opt);
    });
  }

  if (curVal && filteredUnits.some((u) => u.name === curVal)) {
    modalUnitSelect.value = curVal;
  } else if (curVal) {
    const opt = document.createElement('option');
    opt.value = curVal;
    opt.textContent = curVal;
    modalUnitSelect.appendChild(opt);
    modalUnitSelect.value = curVal;
  }
}

function populateOrgDropdowns() {
  const supervisions = getStoredSupervisions();
  const units = getStoredUnits();

  // ۱. نوار انتخاب سرپرستی در مشخصات پرسنلی
  const modalSupSelect = document.getElementById('modalSupervision');
  if (modalSupSelect) {
    const curVal = modalSupSelect.value;
    modalSupSelect.innerHTML = '<option value="">-- انتخاب سرپرستی مربوطه --</option>';
    if (supervisions.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.disabled = true;
      opt.textContent = 'هیچ سرپرستی‌ای توسط مدیر تعریف نشده است';
      modalSupSelect.appendChild(opt);
    } else {
      supervisions.forEach((sup) => {
        const opt = document.createElement('option');
        opt.value = sup;
        opt.textContent = sup;
        modalSupSelect.appendChild(opt);
      });
    }
    if (curVal && supervisions.includes(curVal)) {
      modalSupSelect.value = curVal;
    }
  }

  // ۲. نوار انتخاب واحد در مشخصات پرسنلی
  updateModalUnitsDropdown();

  // ۳. هماهنگ‌سازی منوهای فیلتر گزارش‌های پنل ادمین
  updateAdminFilterDropdowns();

  // ۴. تعریف مدیر جدید - گزینه‌های سرپرستی و هماهنگ‌سازی پویای واحدها
  const newAdminSupSelect = document.getElementById('newAdminSupervision');
  if (newAdminSupSelect) {
    const curVal = newAdminSupSelect.value;
    newAdminSupSelect.innerHTML = '<option value="همه سرپرستی‌ها">همه سرپرستی‌ها (کل سازمان)</option>';
    supervisions.forEach((sup) => {
      const opt = document.createElement('option');
      opt.value = sup;
      opt.textContent = sup;
      newAdminSupSelect.appendChild(opt);
    });
    if (curVal && (curVal === 'همه سرپرستی‌ها' || supervisions.includes(curVal))) {
      newAdminSupSelect.value = curVal;
    }
    // به‌روزرسانی پویای منوی واحدهای وابسته و راهنمای محدوده دسترسی
    onNewAdminSupervisionChange();
  }
}

function preparePersonnelModal() {
  const pidInput = document.getElementById('modalPersonnelId');
  const nidInput = document.getElementById('modalNationalId');
  const badge = document.getElementById('modalPersonnelMatchBadge');

  if (pidInput) {
    pidInput.value = '';
    pidInput.classList.remove('border-rose-500');
  }
  if (nidInput) {
    nidInput.value = '';
    nidInput.classList.remove('border-rose-500');
  }
  if (badge) {
    badge.innerHTML = '';
  }

  setTimeout(() => {
    if (pidInput) pidInput.focus();
  }, 100);
}

// ==========================================
// ۲۰. سیستم اعلان‌ها (Toasts) و مودال‌ها
// ==========================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  let bg = 'bg-slate-800 text-slate-100 border-slate-700';
  let icon = '<svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';

  if (type === 'success') {
    bg = 'bg-emerald-950/95 text-emerald-100 border-emerald-600';
    icon = '<svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>';
  } else if (type === 'error') {
    bg = 'bg-red-950/95 text-red-100 border-red-600';
    icon = '<svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>';
  } else if (type === 'warning') {
    bg = 'bg-amber-950/95 text-amber-100 border-amber-600';
    icon = '<svg class="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>';
  }

  toast.className = `flex items-center gap-3 p-3.5 rounded-xl border shadow-xl text-sm font-medium transition-all transform duration-300 translate-y-2 opacity-0 ${bg}`;
  toast.innerHTML = `
    <div class="shrink-0">${icon}</div>
    <div class="flex-1 text-right leading-snug">${message}</div>
    <button type="button" class="text-slate-400 hover:text-slate-200" onclick="this.parentElement.remove()">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
    </button>
  `;

  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 350);
  }, 4500);
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('hidden');
    if (id === 'personnelModal') {
      preparePersonnelModal();
    } else if (id === 'loginModal') {
      const loginForm = document.getElementById('adminLoginForm');
      if (loginForm) loginForm.reset();
      const userInp = document.getElementById('loginUsername');
      const passInp = document.getElementById('loginPassword');
      if (userInp) userInp.value = '';
      if (passInp) passInp.value = '';
    }
  }
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('hidden');
}

// ==========================================
// ۲۱. آماده‌سازی PWA و نصب روی موبایل و رایانه
// ==========================================
function handlePWAInstallClick() {
  if (window.pwaDeferredPrompt) {
    triggerDirectInstall();
  } else {
    if (typeof openModal === 'function') {
      openModal('pwaInstallModal');
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
      const isAndroid = /Android/.test(navigator.userAgent);
      if (isIOS) switchInstallTab('ios');
      else if (isAndroid) switchInstallTab('android');
      else switchInstallTab('desktop');
    }
  }
}

async function triggerDirectInstall() {
  if (window.pwaDeferredPrompt) {
    try {
      window.pwaDeferredPrompt.prompt();
      const { outcome } = await window.pwaDeferredPrompt.userChoice;
      if (outcome === 'accepted') {
        showToast('برنامه با موفقیت در حال نصب روی دستگاه شما است', 'success');
        const btn = document.getElementById('pwaInstallBtn');
        if (btn) btn.classList.add('hidden');
        const banner = document.getElementById('pwaInstallBanner');
        if (banner) banner.classList.add('hidden');
        closeModal('pwaInstallModal');
      }
      window.pwaDeferredPrompt = null;
    } catch (e) {
      console.warn('[PWA] Prompt error:', e);
      openModal('pwaInstallModal');
    }
  } else {
    openModal('pwaInstallModal');
  }
}

function switchInstallTab(tab) {
  const tabs = ['android', 'desktop', 'ios'];
  tabs.forEach((t) => {
    const el = document.getElementById(`installTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
    const btn = document.getElementById(`installTab${t.charAt(0).toUpperCase() + t.slice(1)}Btn`);
    if (el) el.classList.add('hidden');
    if (btn) {
      btn.className = 'pb-2 px-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200';
    }
  });

  const activeEl = document.getElementById(`installTab${tab.charAt(0).toUpperCase() + tab.slice(1)}`);
  const activeBtn = document.getElementById(`installTab${tab.charAt(0).toUpperCase() + tab.slice(1)}Btn`);
  if (activeEl) activeEl.classList.remove('hidden');
  if (activeBtn) {
    activeBtn.className = 'pb-2 px-2 border-b-2 border-amber-500 text-amber-400';
  }
}

function dismissPWABanner() {
  const banner = document.getElementById('pwaInstallBanner');
  if (banner) banner.classList.add('hidden');
  localStorage.setItem('pwa_banner_dismissed', 'true');
}

var newWorkerWaiting = null;
var updateBannerDismissed = false;
var pendingUpdateServerVersion = null;

function parseVersionNumbers(v) {
  if (!v) return [0, 0, 0];
  const cleaned = String(v).replace(/^v/i, '').trim();
  const parts = cleaned.split('.').map(x => parseInt(x, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function isVersionNewer(newVer, baseVer) {
  if (!newVer || !baseVer) return false;
  const n = parseVersionNumbers(newVer);
  const b = parseVersionNumbers(baseVer);
  for (let i = 0; i < Math.max(n.length, b.length); i++) {
    const numN = n[i] || 0;
    const numB = b[i] || 0;
    if (numN > numB) return true;
    if (numN < numB) return false;
  }
  return false;
}

function getCurrentPwaVersion() {
  const stored = localStorage.getItem('app_installed_version');
  if (stored && isVersionNewer(stored, APP_VERSION)) {
    return stored;
  }
  return APP_VERSION;
}

function showPwaUpdateBanner(latestVersion) {
  const currentVer = getCurrentPwaVersion();
  // ۱. بررسی قطعی: آیا نسخه سرور حقیقتاً بالاتر از نسخه نصب‌شده است؟
  if (!latestVersion || !isVersionNewer(latestVersion, currentVer)) {
    return;
  }
  // ۲. بررسی قطعی: اگر این بروزرسانی قبلاً دریافت شده باشد، دیگر نباید نمایش داده شود
  if (localStorage.getItem(`pwa_update_received_${latestVersion}`) === 'true') {
    return;
  }
  if (updateBannerDismissed) return;

  pendingUpdateServerVersion = latestVersion;
  const banner = document.getElementById('pwaUpdateBanner');
  const msgEl = document.getElementById('pwaUpdateMessage');
  if (banner) {
    if (msgEl) {
      msgEl.textContent = `نگارش جدید (${latestVersion}) منتشر شده است (نسخه فعلی شما: v${currentVer}). جهت اعمال و بارگذاری سریع کلیک کنید:`;
    }
    banner.classList.remove('hidden');
  }
}

function dismissAppUpdate() {
  updateBannerDismissed = true;
  const banner = document.getElementById('pwaUpdateBanner');
  if (banner) banner.classList.add('hidden');
}

async function applyAppUpdate() {
  const targetVer = pendingUpdateServerVersion || APP_VERSION;

  // ۱. فوراً ماژول پنهان شود تا به هیچ عنوان مجدداً نمایش داده نشود
  dismissAppUpdate();

  // ۲. ثبت قطعی دریافت این نسخه در حافظه دائم مرورگر تا پس از رفرش دیگر هرگز نمایش داده نشود
  localStorage.setItem('app_installed_version', targetVer);
  localStorage.setItem(`pwa_update_received_${targetVer}`, 'true');

  showToast('در حال بارگذاری نگارش جدید و به‌روزرسانی اپلیکیشن...', 'info');

  try {
    if (newWorkerWaiting) {
      newWorkerWaiting.postMessage({ type: 'SKIP_WAITING' });
    } else if (window.swRegistration && window.swRegistration.waiting) {
      window.swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }

    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }

    if (window.swRegistration) {
      try {
        await window.swRegistration.update();
      } catch (e) {}
    }

    setTimeout(() => {
      window.location.reload(true);
    }, 450);
  } catch (err) {
    console.error('Update apply error:', err);
    window.location.reload(true);
  }
}

async function checkAppUpdate(isManual = false) {
  const currentVer = getCurrentPwaVersion();
  if (isManual) {
    showToast('در حال بررسی نسخه جدید بر روی سرور...', 'info');
  }

  try {
    const res = await fetch(`/version.json?_t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const serverVersion = (data.version || '').trim();

      // شرط اصلی: ماژول آپدیت فقط در صورت پایین‌تر بودن نسخه PWA نصب‌شده نمایش داده شود
      if (serverVersion && isVersionNewer(serverVersion, currentVer)) {
        // و اگر کاربر قبلاً دکمه دریافت را نزده باشد
        if (localStorage.getItem(`pwa_update_received_${serverVersion}`) !== 'true') {
          showPwaUpdateBanner(serverVersion);
          if (isManual) {
            showToast(`نگارش جدید (${serverVersion}) در دسترس است! لطفاً دکمه بروزرسانی را لمس فرمایید.`, 'success');
          }
          return;
        }
      }
    }

    if (window.swRegistration) {
      try {
        await window.swRegistration.update();
      } catch (e) {
        console.warn('SW update check note:', e);
      }
      if (window.swRegistration.waiting) {
        newWorkerWaiting = window.swRegistration.waiting;
      }
    }

    if (isManual) {
      showToast(`شما در حال حاضر از آخرین نگارش سامانه (v${currentVer}) استفاده می‌فرمایید.`, 'success');
    }
  } catch (err) {
    console.warn('checkAppUpdate failed:', err);
    if (isManual) {
      showToast(`اتصال به سرور بررسی نشد (نسخه فعلی: v${currentVer}).`, 'warning');
    }
  }
}

function setupPWAInstall() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                       window.navigator.standalone === true;

  const btn = document.getElementById('pwaInstallBtn');
  const badge = document.getElementById('pwaInstalledBadge');
  const banner = document.getElementById('pwaInstallBanner');

  if (isStandalone) {
    if (btn) btn.classList.add('hidden');
    // طبق درخواست کاربر نشانگر و عبارت «نصب شده» از سربرگ حذف گردید
    if (badge) badge.classList.add('hidden');
    if (banner) banner.classList.add('hidden');
  } else {
    if (btn) btn.classList.remove('hidden');
    const isDismissed = localStorage.getItem('pwa_banner_dismissed') === 'true';
    if (!isDismissed && banner) {
      banner.classList.remove('hidden');
    }
  }

  window.addEventListener('pwaPromptReady', () => {
    console.log('[PWA] Prompt is ready for install');
    const directBox = document.getElementById('pwaDirectInstallBox');
    if (directBox) directBox.classList.remove('hidden');
  });

  window.addEventListener('pwaInstalled', () => {
    if (btn) btn.classList.add('hidden');
    if (badge) badge.classList.remove('hidden');
    if (banner) banner.classList.add('hidden');
    showToast('نصب اپلیکیشن ثبت گراف با موفقیت تکمیل شد', 'success');
  });

  // ثبت مطمئن و پایدار Service Worker با بررسی خودکار بروزرسانی‌ها برای حالت نصب‌شده (PWA)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      .then((reg) => {
        window.swRegistration = reg;
        console.log('[PWA] Service Worker registered with scope:', reg.scope);

        if (reg.waiting) {
          newWorkerWaiting = reg.waiting;
          checkAppUpdate(false);
        }

        reg.addEventListener('updatefound', () => {
          const installingWorker = reg.installing;
          if (!installingWorker) return;
          installingWorker.addEventListener('statechange', () => {
            if (installingWorker.state === 'installed') {
              if (navigator.serviceWorker.controller) {
                newWorkerWaiting = installingWorker;
                checkAppUpdate(false);
              }
            }
          });
        });
      })
      .catch((err) => console.warn('[PWA] Service Worker registration failed:', err));

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });

    // بروزرسانی نشانگرهای نگارش در هدر و صفحه درباره سامانه بر اساس نسخه جاری
    const curV = getCurrentPwaVersion();
    const headerVerEl = document.getElementById('appHeaderVersionBadge');
    if (headerVerEl) headerVerEl.textContent = 'v' + curV;
    const aboutVerEl = document.getElementById('aboutModalVersionBadge');
    if (aboutVerEl) aboutVerEl.textContent = 'v' + curV;

    // بررسی خودکار نسخه سرور در فواصل زمانی مشخص
    setTimeout(() => {
      checkAppUpdate(false);
    }, 3500);

    setInterval(() => {
      if (navigator.onLine) {
        checkAppUpdate(false);
      }
    }, 15 * 60 * 1000);
  }
}

// ==========================================
// ۲۲. آغاز به کار سیستم (Init)
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  initThemeUI();
  loadOperatorProfile();
  loadPersonnelData();
  populateOrgDropdowns();
  renderOrgManagementUI();
  updateLiveClock();
  setInterval(updateLiveClock, 1000);
  updateStopwatchDisplay();
  updateDurationFormattedDisplay();
  startAutoGPS();
  setupCameraInput();
  updateNetworkStatusIndicator();
  updatePendingQueueCount();
  setupPWAInstall();
  initAssetRebuildables().then(() => populateAsettDatalist());

  const graphForm = document.getElementById('graphRegistrationForm');
  if (graphForm) graphForm.addEventListener('submit', handleGraphFormSubmit);

  const authForm = document.getElementById('personnelAuthForm');
  if (authForm) {
    authForm.addEventListener('submit', (e) => {
      e.preventDefault();
      checkPersonnelCredentials();
    });
  }

  const modalPidInput = document.getElementById('modalPersonnelId');
  const modalNidInput = document.getElementById('modalNationalId');


  const modalSupSelect = document.getElementById('modalSupervision');
  if (modalSupSelect) {
    modalSupSelect.addEventListener('change', () => updateModalUnitsDropdown());
  }

  const modalUnitSelect = document.getElementById('modalUnit');
  if (modalUnitSelect) {
    modalUnitSelect.addEventListener('change', () => {
      const selectedUnitName = modalUnitSelect.value;
      const modalSup = document.getElementById('modalSupervision');
      if (modalSup && !modalSup.value && selectedUnitName) {
        const allUnits = getStoredUnits();
        const found = allUnits.find((u) => u.name === selectedUnitName);
        if (found && found.supervision) {
          modalSup.value = found.supervision;
          updateModalUnitsDropdown(selectedUnitName);
        }
      }
    });
  }

  const loginForm = document.getElementById('adminLoginForm');
  if (loginForm) loginForm.addEventListener('submit', handleAdminLogin);

  const newAdminForm = document.getElementById('newAdminForm');
  if (newAdminForm) newAdminForm.addEventListener('submit', handleCreateNewAdmin);

  const newSupForm = document.getElementById('newSupervisionForm');
  if (newSupForm) newSupForm.addEventListener('submit', handleCreateSupervision);

  const newUnitForm = document.getElementById('newUnitForm');
  if (newUnitForm) newUnitForm.addEventListener('submit', handleCreateUnit);

  const newPersonnelForm = document.getElementById('newPersonnelForm');
  if (newPersonnelForm) newPersonnelForm.addEventListener('submit', handleNewPersonnelSubmit);

  const restoreInput = document.getElementById('restoreFileInput');
  if (restoreInput) restoreInput.addEventListener('change', handleRestoreFile);

  const addActivityBtn = document.getElementById('addActivityBtn');
  if (addActivityBtn) {
    addActivityBtn.addEventListener('click', (e) => {
      e.preventDefault();
      addSelectedActivity();
    });
  }
});

// ==========================================
// ۲۱. ماژول مدیریت پرسنل (Personnel Management) در پنل مدیریت
// ==========================================
function renderPersonnelTable() {
  const tbody = document.getElementById('personnelTableBody');
  const countText = document.getElementById('personnelFilterCountText');
  const totalBadge = document.getElementById('personnelTotalBadge');
  const pageInfo = document.getElementById('personnelPaginationInfo');
  const paginationControls = document.getElementById('personnelPaginationControls');
  if (!tbody) return;

  if (!window.AppState.personnel || window.AppState.personnel.length === 0) {
    if (window.INITIAL_PERSONNEL_DATA && Array.isArray(window.INITIAL_PERSONNEL_DATA) && window.INITIAL_PERSONNEL_DATA.length > 0) {
      initPersonnelState(window.INITIAL_PERSONNEL_DATA);
    }
  }

  const allPersonnel = window.AppState.personnel || [];
  if (totalBadge) {
    totalBadge.textContent = `${allPersonnel.length.toLocaleString('fa-IR')} پرسنل`;
  }

  if (allPersonnel.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="py-10 text-center text-slate-400 font-sans">
          <div class="flex flex-col items-center justify-center gap-2">
            <svg class="w-6 h-6 text-amber-400 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg>
            <span>در حال بارگذاری اطلاعات بانک پرسنل...</span>
          </div>
        </td>
      </tr>
    `;
    setTimeout(() => {
      if (window.INITIAL_PERSONNEL_DATA && window.INITIAL_PERSONNEL_DATA.length > 0) {
        initPersonnelState(window.INITIAL_PERSONNEL_DATA);
        renderPersonnelTable();
      } else {
        fetch('/personnel-data.json')
          .then((res) => res.json())
          .then((data) => {
            if (data && data.length) {
              window.INITIAL_PERSONNEL_DATA = data;
              initPersonnelState(data);
              renderPersonnelTable();
            }
          })
          .catch(() => {});
      }
    }, 150);
    return;
  }

  const query = (window.AppState.personnelSearchQuery || '').trim().toLowerCase();
  let filtered = allPersonnel;
  if (query) {
    filtered = allPersonnel.filter((p) => {
      const code = String(p.code || '').toLowerCase();
      const name = String(p.name || '').toLowerCase();
      const nid = String(p.nationalId || '').toLowerCase();
      const sup = String(p.supervision || '').toLowerCase();
      const unit = String(p.serviceUnit || p.unit || '').toLowerCase();
      const role = String(p.jobTitle || p.role || '').toLowerCase();
      return code.includes(query) || name.includes(query) || nid.includes(query) || sup.includes(query) || unit.includes(query) || role.includes(query);
    });
  }

  const total = filtered.length;
  const pageSize = window.AppState.personnelPageSize || 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (window.AppState.personnelCurrentPage > totalPages) {
    window.AppState.personnelCurrentPage = totalPages;
  }
  if (window.AppState.personnelCurrentPage < 1) {
    window.AppState.personnelCurrentPage = 1;
  }
  const currentPage = window.AppState.personnelCurrentPage;

  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, total);
  const pageItems = filtered.slice(startIndex, endIndex);

  if (countText) {
    if (query) {
      countText.textContent = `یافت‌شده: ${total.toLocaleString('fa-IR')} از کل ${allPersonnel.length.toLocaleString('fa-IR')} نفر`;
    } else {
      countText.textContent = `نمایش ${startIndex + 1} تا ${endIndex} از کل ${total.toLocaleString('fa-IR')} پرسنل`;
    }
  }

  if (pageInfo) {
    pageInfo.textContent = `صفحه ${currentPage.toLocaleString('fa-IR')} از ${totalPages.toLocaleString('fa-IR')} (تعداد کل: ${total.toLocaleString('fa-IR')})`;
  }

  if (pageItems.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" class="py-10 text-center text-slate-500 font-sans">
          پرسنلی با مشخصات جستجو شده یافت نشد.
        </td>
      </tr>
    `;
  } else {
    tbody.innerHTML = pageItems.map((p, idx) => {
      const rowNum = startIndex + idx + 1;
      const safeCode = escapeHtml(p.code);
      const safeName = escapeHtml(p.name || `${p.firstName || ''} ${p.lastName || ''}`);
      const safeNId = escapeHtml(p.nationalId || '---');
      const safeMobile = escapeHtml(p.mobile ? ('0' + String(p.mobile).replace(/^0+/, '')) : '---');
      const safeMgmt = escapeHtml(p.management || 'مدیریت اتوماسیون و ارتباطات');
      const safeSup = escapeHtml(p.supervision || '---');
      const safeUnit = escapeHtml(p.serviceUnit || p.unit || '---');
      const safeRole = escapeHtml(p.jobTitle || p.role || '---');

      return `
        <tr class="hover:bg-slate-800/50 transition border-b border-slate-800/40">
          <td class="py-2.5 px-2 text-center text-slate-500 text-[11px] font-mono">${rowNum}</td>
          <td class="py-2.5 px-3 font-mono font-bold text-amber-300">${safeCode}</td>
          <td class="py-2.5 px-3 text-slate-200 font-medium">${safeName}</td>
          <td class="py-2.5 px-3 font-mono text-slate-300">${safeNId}</td>
          <td class="py-2.5 px-3 font-mono text-slate-300">${safeMobile}</td>
          <td class="py-2.5 px-3 text-slate-300">${safeMgmt}</td>
          <td class="py-2.5 px-3 text-amber-200">${safeSup}</td>
          <td class="py-2.5 px-3 text-emerald-300">${safeUnit}</td>
          <td class="py-2.5 px-3 text-slate-100">${safeRole}</td>
          <td class="py-2.5 px-3 text-center">
            <div class="flex items-center justify-center gap-1.5">
              <button type="button" onclick="editPersonnelRecord('${safeCode}')" class="px-2 py-1 text-[11px] bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 hover:text-amber-200 border border-amber-500/30 rounded-lg transition" title="ویرایش پرسنل">
                ویرایش
              </button>
              <button type="button" onclick="confirmDeletePersonnel('${safeCode}')" class="px-2 py-1 text-[11px] bg-red-950/40 hover:bg-red-900/60 text-red-300 hover:text-red-100 border border-red-800/60 rounded-lg transition active:scale-95" title="حذف از بانک پرسنل">
                حذف
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // ایجاد دکمه‌های کنترل صفحه‌بندی
  if (paginationControls) {
    let html = '';
    html += `<button type="button" onclick="goToPersonnelPage(1)" ${currentPage === 1 ? 'disabled' : ''} class="px-2 py-1 rounded bg-slate-800 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 text-xs">« اول</button>`;
    html += `<button type="button" onclick="goToPersonnelPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''} class="px-2.5 py-1 rounded bg-slate-800 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 text-xs">قبلی</button>`;

    const startP = Math.max(1, currentPage - 2);
    const endP = Math.min(totalPages, currentPage + 2);
    for (let i = startP; i <= endP; i++) {
      if (i === currentPage) {
        html += `<span class="px-2.5 py-1 rounded bg-amber-500 text-slate-950 font-bold text-xs">${i.toLocaleString('fa-IR')}</span>`;
      } else {
        html += `<button type="button" onclick="goToPersonnelPage(${i})" class="px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs">${i.toLocaleString('fa-IR')}</button>`;
      }
    }

    html += `<button type="button" onclick="goToPersonnelPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''} class="px-2.5 py-1 rounded bg-slate-800 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 text-xs">بعدی</button>`;
    html += `<button type="button" onclick="goToPersonnelPage(${totalPages})" ${currentPage === totalPages ? 'disabled' : ''} class="px-2 py-1 rounded bg-slate-800 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 text-xs">آخر »</button>`;
    paginationControls.innerHTML = html;
  }
}

function toggleAddPersonnelForm(show) {
  const container = document.getElementById('addPersonnelFormContainer');
  if (!container) return;
  if (show === undefined) {
    container.classList.toggle('hidden');
  } else if (show) {
    container.classList.remove('hidden');
  } else {
    container.classList.add('hidden');
  }
  if (!container.classList.contains('hidden')) {
    const codeInput = document.getElementById('newPersonnelCode');
    if (codeInput) {
      setTimeout(() => codeInput.focus(), 50);
    }
  }
}

async function handleNewPersonnelSubmit(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  const codeInput = document.getElementById('newPersonnelCode');
  const nameInput = document.getElementById('newPersonnelName');
  if (!codeInput || !nameInput) return;

  const code = codeInput.value.trim();
  const name = nameInput.value.trim();
  if (!code || !name) {
    showToast('شماره پرسنلی و نام پرسنل الزامی است', 'error');
    return;
  }

  const existing = window.AppState.personnelMap ? window.AppState.personnelMap.get(code) : null;
  if (existing) {
    if (!confirm(`پرسنل با شماره پرسنلی ${code} قبلاً با نام «${existing.name}» ثبت شده است. آیا می‌خواهید اطلاعات به‌روزرسانی شود؟`)) {
      return;
    }
  }

  const newRecord = { code, name };

  // ۱. به‌روزرسانی فوری در حافظه رم
  if (!window.AppState.personnel) window.AppState.personnel = [];
  const existingIdx = window.AppState.personnel.findIndex((p) => String(p.code).trim() === code);
  if (existingIdx >= 0) {
    window.AppState.personnel[existingIdx] = newRecord;
  } else {
    window.AppState.personnel.unshift(newRecord);
  }

  if (window.AppState.personnelMap) {
    window.AppState.personnelMap.set(code, newRecord);
    const unpadded = code.replace(/^0+/, '');
    if (unpadded) window.AppState.personnelMap.set(unpadded, newRecord);
    const padded7 = code.padStart(7, '0');
    if (padded7) window.AppState.personnelMap.set(padded7, newRecord);
  }

  // ۲. پاک‌سازی فرم و بستن پنجره
  codeInput.value = '';
  nameInput.value = '';
  toggleAddPersonnelForm(false);

  // انتقال به صفحه اول بدون فیلتر جهت مشاهده رکورد جدید
  window.AppState.personnelSearchQuery = '';
  const searchInput = document.getElementById('personnelSearchInput');
  if (searchInput) searchInput.value = '';
  const clearBtn = document.getElementById('clearPersonnelSearchBtn');
  if (clearBtn) clearBtn.classList.add('hidden');
  window.AppState.personnelCurrentPage = 1;

  renderPersonnelTable();
  showToast(`پرسنل «${name}» با شماره ${code} با موفقیت ثبت شد`, 'success');

  // ۳. ذخیره در IndexedDB در پس‌زمینه
  try {
    await savePersonnelRecordToDB(newRecord);
  } catch (dbErr) {
    console.warn('Background save new personnel error:', dbErr);
  }
}

function editPersonnelRecord(code) {
  if (!code) return;
  const cleanCode = String(code).trim();
  const p = (window.AppState.personnelMap && window.AppState.personnelMap.get(cleanCode)) ||
            (window.AppState.personnel || []).find((x) => String(x.code).trim() === cleanCode);
  if (!p) return;

  const newName = prompt(`ویرایش نام پرسنل با شماره پرسنلی ${cleanCode}:`, p.name);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed) {
    showToast('نام پرسنل نمی‌تواند خالی باشد', 'error');
    return;
  }

  p.name = trimmed;
  if (window.AppState.personnelMap) {
    window.AppState.personnelMap.set(cleanCode, p);
  }
  renderPersonnelTable();
  showToast(`نام پرسنل با موفقیت به «${trimmed}» به‌روزرسانی شد`, 'success');
  savePersonnelRecordToDB(p).catch((e) => console.warn(e));
}

async function confirmDeletePersonnel(code) {
  if (!code) return;
  const cleanCode = String(code).trim();
  const p = (window.AppState.personnelMap && window.AppState.personnelMap.get(cleanCode)) ||
            (window.AppState.personnel || []).find((x) => String(x.code).trim() === cleanCode);
  const name = p ? p.name : cleanCode;

  if (!confirm(`آیا از حذف پرسنل «${name}» با شماره پرسنلی ${cleanCode} اطمینان دارید؟`)) {
    return;
  }

  // ۱. حذف فوری از حافظه رم جهت پاسخدهی آنی
  window.AppState.personnel = (window.AppState.personnel || []).filter((item) => String(item.code).trim() !== cleanCode);
  if (window.AppState.personnelMap) {
    window.AppState.personnelMap.delete(cleanCode);
    const unpadded = cleanCode.replace(/^0+/, '');
    if (unpadded) window.AppState.personnelMap.delete(unpadded);
    const padded7 = cleanCode.padStart(7, '0');
    if (padded7) window.AppState.personnelMap.delete(padded7);
  }

  // ۲. رندر مجدد جدول و نمایش پیام به کاربر
  renderPersonnelTable();
  showToast(`پرسنل «${name}» (${cleanCode}) با موفقیت حذف گردید`, 'info');

  // ۳. حذف پایدار در پس‌زمینه از دیتابیس
  try {
    await deletePersonnelFromDB(cleanCode);
  } catch (dbErr) {
    console.warn('Background delete personnel error:', dbErr);
  }
}

async function confirmResetPersonnelData() {
  if (!confirm('آیا از بازنشانی کامل اطلاعات پرسنل به فایل اولیه اکسل (۷,۵۲۷ رکورد) اطمینان دارید؟ هرگونه تغییر دستی بازنشانی خواهد شد.')) {
    return;
  }
  try {
    let sourceData = window.INITIAL_PERSONNEL_DATA;
    if (!sourceData || !sourceData.length) {
      const res = await fetch('/personnel-data.json');
      sourceData = await res.json();
    }
    await clearPersonnelDB();
    saveMultiplePersonnelToDB(sourceData).catch(() => {});
    window.AppState.personnel = [...sourceData];
    initPersonnelState(window.AppState.personnel);
    window.AppState.personnelCurrentPage = 1;
    renderPersonnelTable();
    showToast('بانک اطلاعات پرسنل با موفقیت به فایل اولیه اکسل بازنشانی شد', 'success');
  } catch (e) {
    console.error('Error resetting personnel data:', e);
    showToast('خطا در بازنشانی اطلاعات پرسنل', 'error');
  }
}

function onPersonnelSearchInput(val) {
  window.AppState.personnelSearchQuery = val || '';
  window.AppState.personnelCurrentPage = 1;
  const clearBtn = document.getElementById('clearPersonnelSearchBtn');
  if (clearBtn) {
    if (val) clearBtn.classList.remove('hidden');
    else clearBtn.classList.add('hidden');
  }
  renderPersonnelTable();
}

function clearPersonnelSearch() {
  const input = document.getElementById('personnelSearchInput');
  if (input) input.value = '';
  onPersonnelSearchInput('');
}

function onPersonnelPageSizeChange(size) {
  window.AppState.personnelPageSize = Number(size) || 50;
  window.AppState.personnelCurrentPage = 1;
  renderPersonnelTable();
}

function goToPersonnelPage(page) {
  window.AppState.personnelCurrentPage = Number(page);
  renderPersonnelTable();
}

// تعاریف نام‌های مستعار برای حذف و سوئیچ تب‌ها
async function deleteRecord(id) {
  return confirmDeleteReport(id);
}

async function deleteAdmin(username) {
  return confirmDeleteAdmin(username);
}

function showAdminTab(tabName) {
  let user = window.AppState && window.AppState.currentUser;
  if (!user) {
    try {
      const session = sessionStorage.getItem('automation_admin_session');
      if (session) user = JSON.parse(session);
    } catch (e) {}
  }
  const isSuper = !user || user.username === 'admin' || user.username === '417734' || user.username === '417737' || user.isSuperAdmin;

  const canOrg = isSuper || !!(user && user.permissions && user.permissions.orgManage);
  const canAdmin = isSuper || !!(user && user.permissions && user.permissions.adminManage);
  const canBackup = isSuper || !!(user && user.permissions && user.permissions.backup);
  const canPersonnel = isSuper || !!(user && user.permissions && user.permissions.personnelManage);
  const canAssetRebuildable = isSuper || (user && user.permissions ? user.permissions.assetRebuildable !== false : true);

  if (tabName === 'orgManage' && !canOrg) tabName = 'reports';
  if (tabName === 'adminManage' && !canAdmin) tabName = 'reports';
  if (tabName === 'backup' && !canBackup) tabName = 'reports';
  if (tabName === 'personnelManage' && !canPersonnel) tabName = 'reports';
  if (tabName === 'assetRebuildable' && !canAssetRebuildable) tabName = 'reports';

  const tabs = ['adminTabReports', 'adminTabOrg', 'adminTabManage', 'adminTabBackup', 'adminTabPersonnel', 'adminTabAssetRebuildable'];
  tabs.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });

  const inactiveClass = 'px-4 py-2.5 text-xs sm:text-sm font-bold border-b-2 border-transparent text-slate-400 hover:text-slate-200 flex items-center gap-1.5 transition';
  const activeClass = 'px-4 py-2.5 text-xs sm:text-sm font-bold border-b-2 border-amber-500 text-amber-400 flex items-center gap-1.5 transition';

  const btnReports = document.getElementById('tabBtnReports');
  const btnOrg = document.getElementById('tabBtnOrgManage');
  const btnManage = document.getElementById('tabBtnAdminManage');
  const btnBackup = document.getElementById('tabBtnBackup');
  const btnPersonnel = document.getElementById('tabBtnPersonnelManage');
  const btnAsset = document.getElementById('tabBtnAssetRebuildable');

  if (btnReports) btnReports.className = inactiveClass;
  if (btnOrg) btnOrg.className = inactiveClass;
  if (btnManage) btnManage.className = inactiveClass;
  if (btnBackup) btnBackup.className = inactiveClass;
  if (btnPersonnel) btnPersonnel.className = inactiveClass;
  if (btnAsset) btnAsset.className = inactiveClass;

  if (tabName === 'reports') {
    const el = document.getElementById('adminTabReports');
    if (el) el.classList.remove('hidden');
    if (btnReports) btnReports.className = activeClass;
  } else if (tabName === 'orgManage' && canOrg) {
    const el = document.getElementById('adminTabOrg');
    if (el) el.classList.remove('hidden');
    if (btnOrg) btnOrg.className = activeClass;
    if (typeof renderOrgManagementUI === 'function') renderOrgManagementUI();
  } else if (tabName === 'adminManage' && canAdmin) {
    const el = document.getElementById('adminTabManage');
    if (el) el.classList.remove('hidden');
    if (btnManage) btnManage.className = activeClass;
  } else if (tabName === 'backup' && canBackup) {
    const el = document.getElementById('adminTabBackup');
    if (el) el.classList.remove('hidden');
    if (btnBackup) btnBackup.className = activeClass;
  } else if (tabName === 'personnelManage' && canPersonnel) {
    const el = document.getElementById('adminTabPersonnel');
    if (el) el.classList.remove('hidden');
    if (btnPersonnel) btnPersonnel.className = activeClass;
    renderPersonnelTable();
  } else if (tabName === 'assetRebuildable') {
    const el = document.getElementById('adminTabAssetRebuildable');
    if (el) el.classList.remove('hidden');
    if (btnAsset) btnAsset.className = 'px-4 py-2.5 text-xs sm:text-sm font-bold border-b-2 border-cyan-500 text-cyan-400 flex items-center gap-1.5 transition';
    renderAssetRebuildableUI();
  }
}

// ==========================================
// ۲۲. ماژول بانک اطلاعات تجهیزات و قطعات بازسازی (asset &Rebuildble)
// ==========================================
var DEFAULT_INITIAL_ASSETS = [];

function getUserAssetScope() {
  let user = window.AppState && window.AppState.currentUser;
  if (!user) {
    try {
      const session = sessionStorage.getItem('automation_admin_session');
      if (session) user = JSON.parse(session);
    } catch (e) {}
  }
  const isSuper = !user || user.username === 'admin' || user.username === '417734' || user.username === '417737' || user.isSuperAdmin;
  const userSup = user && user.supervision ? user.supervision.trim() : '';
  const userUnit = user && user.unit ? user.unit.trim() : '';

  const isGlobalSup = isSuper || !userSup || userSup === 'همه سرپرستی‌ها' || userSup === 'کل سرپرستی‌ها';
  const isGlobalUnit = isSuper || !userUnit || userUnit === 'همه واحدها' || userUnit === 'کل واحدها' || userUnit === 'همه واحدهای سرپرستی';

  return {
    user,
    isSuper,
    isGlobalSup,
    isGlobalUnit,
    supervision: userSup,
    unit: userUnit
  };
}

function canUserAccessAssetRecord(record, scope) {
  if (!scope) scope = getUserAssetScope();
  if (scope.isSuper) return true;
  if (scope.isGlobalSup && scope.isGlobalUnit) return true;

  if (!scope.isGlobalSup) {
    if (record.supervision && record.supervision !== scope.supervision) return false;
  }
  if (!scope.isGlobalUnit) {
    if (record.unit && record.unit !== scope.unit) return false;
  }
  return true;
}

async function initAssetRebuildables() {
  let records = await getAllAssetRebuildableRecordsFromDB();
  const defaultRebuildables = [
    'کارت پردازنده اصلی CPU 414-4H',
    'ماژول ورودی/خروجی آنالوگ AI 8x13Bit',
    'پوزیشنر هوشمند Fisher DVC6200',
    'اکچویتور پنوماتیک دیافراگمی 657',
    'فرستنده-گیرنده UHF تله‌متری',
    'پاور ماژولار ریداندنت 12V 450W'
  ];
  if (records && records.length > 0) {
    const toDelete = records.filter(r => defaultRebuildables.includes((r.rebuildable || '').trim()));
    if (toDelete.length > 0) {
      for (const r of toDelete) {
        if (r.id) await deleteAssetRebuildableRecordFromDB(r.id);
      }
      records = records.filter(r => !defaultRebuildables.includes((r.rebuildable || '').trim()));
      localStorage.setItem('automation_asset_rebuildables', JSON.stringify(records));
    }
  }
  records = await ensureDefaultAssetRebuildables(records);
  window.AppState.assetRecords = records || [];
  await populateAsettDatalist();
  return window.AppState.assetRecords;
}

function updateAssetScopeUI(scope) {
  const badgeText = document.getElementById('assetUserScopeText');
  const supWrapper = document.getElementById('assetSupFilterWrapper');
  const unitWrapper = document.getElementById('assetUnitFilterWrapper');

  if (badgeText) {
    if (scope.isSuper || (scope.isGlobalSup && scope.isGlobalUnit)) {
      badgeText.innerHTML = '<span class="text-emerald-400 font-black">دسترسی نامحدود سازمانی</span> (رویت و مدیریت کل تجهیزات)';
    } else if (!scope.isGlobalSup && scope.isGlobalUnit) {
      badgeText.innerHTML = `سرپرستی: <strong class="text-amber-300">«${escapeHtml(scope.supervision)}»</strong> (تمامی واحدهای زیرمجموعه)`;
    } else {
      badgeText.innerHTML = `سرپرستی: <strong class="text-amber-300">«${escapeHtml(scope.supervision)}»</strong> | واحد: <strong class="text-cyan-300">«${escapeHtml(scope.unit)}»</strong>`;
    }
  }

  if (supWrapper) {
    if (scope.isGlobalSup) {
      supWrapper.classList.remove('hidden');
      supWrapper.classList.add('flex');
    } else {
      supWrapper.classList.add('hidden');
      supWrapper.classList.remove('flex');
    }
  }

  if (unitWrapper) {
    if (scope.isGlobalUnit) {
      unitWrapper.classList.remove('hidden');
      unitWrapper.classList.add('flex');
    } else {
      unitWrapper.classList.add('hidden');
      unitWrapper.classList.remove('flex');
    }
  }
}

function populateAssetFilterDropdowns(scope) {
  const supSelect = document.getElementById('assetFilterSupervision');
  const unitSelect = document.getElementById('assetFilterUnit');

  if (supSelect && scope.isGlobalSup) {
    const supervisions = getStoredSupervisions();
    let optionsHtml = '<option value="همه">همه سرپرستی‌ها</option>';
    supervisions.forEach(s => {
      optionsHtml += `<option value="${escapeHtml(s.title)}">${escapeHtml(s.title)}</option>`;
    });
    supSelect.innerHTML = optionsHtml;
  }

  if (unitSelect) {
    let units = [];
    if (scope.isGlobalSup) {
      units = getStoredUnits();
    } else {
      units = getStoredUnits().filter(u => u.supervision === scope.supervision);
    }
    let optionsHtml = '<option value="همه">همه واحدها</option>';
    units.forEach(u => {
      optionsHtml += `<option value="${escapeHtml(u.name)}">${escapeHtml(u.name)}</option>`;
    });
    unitSelect.innerHTML = optionsHtml;
  }
}

function onAssetFilterSupervisionChange() {
  const supSelect = document.getElementById('assetFilterSupervision');
  const unitSelect = document.getElementById('assetFilterUnit');
  if (supSelect && unitSelect) {
    const selectedSup = supSelect.value;
    let units = getStoredUnits();
    if (selectedSup && selectedSup !== 'همه') {
      units = units.filter(u => u.supervision === selectedSup);
    }
    let optionsHtml = '<option value="همه">همه واحدها</option>';
    units.forEach(u => {
      optionsHtml += `<option value="${escapeHtml(u.name)}">${escapeHtml(u.name)}</option>`;
    });
    unitSelect.innerHTML = optionsHtml;
  }
  applyAssetFiltersAndRender();
}

function onAssetFilterUnitChange() {
  applyAssetFiltersAndRender();
}

function onAssetSearchInput(val) {
  window.AppState.assetSearchQuery = val || '';
  const clearBtn = document.getElementById('clearAssetSearchBtn');
  if (clearBtn) {
    if (val && val.trim().length > 0) clearBtn.classList.remove('hidden');
    else clearBtn.classList.add('hidden');
  }
  applyAssetFiltersAndRender();
}

function clearAssetSearch() {
  const input = document.getElementById('assetSearchInput');
  if (input) input.value = '';
  onAssetSearchInput('');
}

async function renderAssetRebuildableUI() {
  await initAssetRebuildables();
  const scope = getUserAssetScope();
  updateAssetScopeUI(scope);
  populateAssetFilterDropdowns(scope);
  applyAssetFiltersAndRender();
}

function applyAssetFiltersAndRender() {
  const scope = getUserAssetScope();
  const allRecords = window.AppState.assetRecords || [];

  // ۱. فیلتر امنیتی سطرها بر اساس حوزه کاربر
  let list = allRecords.filter(r => canUserAccessAssetRecord(r, scope));

  // ۲. فیلتر انتخابی سرپرستی
  const supSelect = document.getElementById('assetFilterSupervision');
  if (supSelect && supSelect.value && supSelect.value !== 'همه') {
    list = list.filter(r => r.supervision === supSelect.value);
  }

  // ۳. فیلتر انتخابی واحد
  const unitSelect = document.getElementById('assetFilterUnit');
  if (unitSelect && unitSelect.value && unitSelect.value !== 'همه') {
    list = list.filter(r => r.unit === unitSelect.value);
  }

  // ۴. فیلتر متن جستجو
  const q = (window.AppState.assetSearchQuery || '').trim().toLowerCase();
  if (q) {
    list = list.filter(r => {
      const assetStr = (r.asset || '').toLowerCase();
      const rebStr = (r.rebuildable || '').toLowerCase();
      const descStr = (r.description || '').toLowerCase();
      const supStr = (r.supervision || '').toLowerCase();
      const unitStr = (r.unit || '').toLowerCase();
      return assetStr.includes(q) || rebStr.includes(q) || descStr.includes(q) || supStr.includes(q) || unitStr.includes(q);
    });
  }

  window.AppState.filteredAssetRecords = list;

  const countEl = document.getElementById('assetRecordsCountText');
  if (countEl) countEl.textContent = list.length.toLocaleString('fa-IR');

  renderAssetRebuildableTable(list, scope);
}

function renderAssetRebuildableTable(list, scope) {
  const tbody = document.getElementById('assetTableBody');
  const paginationInfo = document.getElementById('assetPaginationInfo');
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="py-12 px-4 text-center">
          <div class="flex flex-col items-center justify-center space-y-3">
            <div class="w-14 h-14 rounded-2xl bg-slate-800/80 border border-slate-700 flex items-center justify-center text-slate-500">
              <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
            <div class="text-sm font-bold text-slate-300">هیچ رکوردی در بانک اطلاعات تجهیزات یافت نشد</div>
            <p class="text-xs text-slate-500 max-w-sm">برای ثبت تجهیز و قطعات بازسازی جدید از دکمه «افزودن ASETT / Rebuildable» یا بارگذاری فایل اکسل استفاده فرمایید.</p>
            <button type="button" onclick="openAddAssetModal()" class="mt-2 px-3.5 py-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/30 rounded-xl text-xs font-bold transition">
              + ثبت اولین رکورد برای این واحد
            </button>
          </div>
        </td>
      </tr>
    `;
    if (paginationInfo) paginationInfo.textContent = '۰ رکورد نمایش داده شده است';
    return;
  }

  // شمارش تعداد قطعات هر ASETT جهت نمایش برچسب رابطه‌ای
  const assetCounts = {};
  list.forEach(r => {
    const k = (r.asset || '').trim();
    assetCounts[k] = (assetCounts[k] || 0) + 1;
  });

  let rowsHtml = '';
  list.forEach((r, idx) => {
    const isUserAllowedToMutate = canUserAccessAssetRecord(r, scope);
    const countForAsset = assetCounts[(r.asset || '').trim()] || 1;

    rowsHtml += `
      <tr class="hover:bg-slate-800/40 transition border-b border-slate-800/50">
        <!-- ۱. شماره ردیف -->
        <td class="py-3 px-3 text-center font-mono font-bold text-slate-400 text-xs">
          ${idx + 1}
        </td>

        <!-- ۲. ASETT -->
        <td class="py-3 px-4 font-extrabold text-slate-100">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-slate-100 font-bold">${escapeHtml(r.asset || '---')}</span>
            ${countForAsset > 1 ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950/70 text-cyan-300 border border-cyan-800 font-mono" title="این تجهیز دارای ${countForAsset} قطعه بازسازی در لیست می‌باشد">${countForAsset} قطعه</span>` : ''}
          </div>
        </td>

        <!-- ۳. Rebuildble -->
        <td class="py-3 px-4">
          <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-semibold text-xs">
            <svg class="w-3 h-3 shrink-0 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/></svg>
            <span>${escapeHtml(r.rebuildable || '---')}</span>
          </span>
        </td>

        <!-- ۴. توضیحات -->
        <td class="py-3 px-4 text-slate-300 leading-relaxed text-xs max-w-xs">
          ${r.description ? escapeHtml(r.description) : '<span class="text-slate-600 font-mono">---</span>'}
        </td>

        <!-- ۵. سرپرستی -->
        <td class="py-3 px-4 text-slate-300 text-xs">
          <span class="inline-block px-2 py-0.5 rounded bg-slate-800 text-amber-300 border border-slate-700 text-[11px] font-medium">
            ${escapeHtml(r.supervision || '---')}
          </span>
        </td>

        <!-- ۶. واحد -->
        <td class="py-3 px-4 text-slate-300 text-xs">
          <span class="inline-block px-2 py-0.5 rounded bg-slate-800 text-cyan-300 border border-slate-700 text-[11px] font-medium">
            ${escapeHtml(r.unit || '---')}
          </span>
        </td>

        <!-- عملیات -->
        <td class="py-3 px-3 text-center">
          ${isUserAllowedToMutate ? `
            <div class="inline-flex items-center gap-1">
              <button type="button" onclick="openEditAssetModal(${r.id})" class="p-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 transition" title="ویرایش رکورد">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
              </button>
              <button type="button" onclick="confirmDeleteAssetRecord(${r.id})" class="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 border border-rose-500/30 transition" title="حذف رکورد">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
              </button>
            </div>
          ` : `
            <span class="text-[10px] text-slate-600 font-mono">فقط خواندنی</span>
          `}
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = rowsHtml;
  if (paginationInfo) {
    paginationInfo.textContent = `نمایش ${list.length.toLocaleString('fa-IR')} رکورد`;
  }
}

// ==========================================
// عملیات افزودن و ویرایش رکورد با پشتیبانی از چند Rebuildble برای هر ASETT
// ==========================================
function openAddAssetModal() {
  const form = document.getElementById('newAssetRebuildableForm');
  if (form) form.reset();

  const scope = getUserAssetScope();
  const supSelect = document.getElementById('newAssetSupervision');
  const unitSelect = document.getElementById('newAssetUnit');
  const lockNote = document.getElementById('newAssetScopeLockNote');
  const lockText = document.getElementById('newAssetScopeLockNoteText');

  // مقداردهی دراپ‌داون سرپرستی
  if (supSelect) {
    const supervisions = getStoredSupervisions();
    let optionsHtml = '';

    if (!scope.isGlobalSup) {
      // قفل شده به سرپرستی کاربر
      optionsHtml = `<option value="${escapeHtml(scope.supervision)}">${escapeHtml(scope.supervision)}</option>`;
      supSelect.innerHTML = optionsHtml;
      supSelect.value = scope.supervision;
      supSelect.disabled = true;
    } else {
      optionsHtml = '<option value="">-- انتخاب سرپرستی --</option>';
      supervisions.forEach(s => {
        const sName = (typeof s === 'object' && s !== null) ? (s.name || s.title || '') : String(s);
        if (sName) {
          optionsHtml += `<option value="${escapeHtml(sName)}">${escapeHtml(sName)}</option>`;
        }
      });
      supSelect.innerHTML = optionsHtml;
      supSelect.disabled = false;
    }
  }

  // مقداردهی دراپ‌داون واحد
  populateNewAssetUnitsDropdown();

  if (lockNote && lockText) {
    if (!scope.isGlobalSup || !scope.isGlobalUnit) {
      lockNote.classList.remove('hidden');
      lockText.textContent = `توجه: با توجه به سطح دسترسی شما، این رکورد در سرپرستی «${scope.supervision}» و واحد «${scope.unit}» ثبت خواهد شد.`;
    } else {
      lockNote.classList.add('hidden');
    }
  }

  // آماده‌سازی بخش اقلام Rebuildable با یک سطر اولیه
  const container = document.getElementById('rebuildablesContainer');
  if (container) {
    container.innerHTML = '';
    addNewRebuildableItemRow('', '');
  }

  openModal('assetAddModal');
}

function onNewAssetSupervisionChange() {
  populateNewAssetUnitsDropdown();
}

function populateNewAssetUnitsDropdown() {
  const scope = getUserAssetScope();
  const supSelect = document.getElementById('newAssetSupervision');
  const unitSelect = document.getElementById('newAssetUnit');
  if (!unitSelect) return;

  const currentSup = (!scope.isGlobalSup && scope.supervision)
    ? scope.supervision
    : (supSelect ? supSelect.value : '');

  let units = getStoredUnits();
  if (currentSup) {
    units = units.filter(u => u.supervision === currentSup);
  }

  if (!scope.isGlobalUnit && scope.unit) {
    unitSelect.innerHTML = `<option value="${escapeHtml(scope.unit)}">${escapeHtml(scope.unit)}</option>`;
    unitSelect.value = scope.unit;
    unitSelect.disabled = true;
  } else {
    let optionsHtml = '<option value="">-- انتخاب واحد سازمانی --</option>';
    units.forEach(u => {
      optionsHtml += `<option value="${escapeHtml(u.name)}">${escapeHtml(u.name)}</option>`;
    });
    unitSelect.innerHTML = optionsHtml;
    unitSelect.disabled = false;
  }
}

function addNewRebuildableItemRow(initialName = '', initialDesc = '') {
  const container = document.getElementById('rebuildablesContainer');
  if (!container) return;

  const rowCount = container.children.length + 1;
  const rowDiv = document.createElement('div');
  rowDiv.className = 'rebuildable-row p-3 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2 relative transition hover:border-slate-700';

  rowDiv.innerHTML = `
    <div class="flex items-center justify-between">
      <span class="text-[11px] font-bold text-cyan-400 flex items-center gap-1.5">
        <span class="w-2 h-2 rounded-full bg-cyan-400"></span>
        <span>Rebuildble شماره <strong class="row-num font-mono">${rowCount}</strong></span>
      </span>
      <button type="button" onclick="removeRebuildableItemRow(this)" class="text-rose-400 hover:text-rose-300 text-xs px-2 py-0.5 rounded hover:bg-rose-950/40 transition">
        حذف سطر ✕
      </button>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
      <div>
        <label class="block text-[11px] text-slate-300 mb-1 font-semibold">عنوان یا کد Rebuildble: <span class="text-red-400">*</span></label>
        <input type="text" required value="${escapeHtml(initialName)}" placeholder="عنوان یا کد قطعه بازسازی..." class="rebuildable-name-input w-full bg-slate-900 border border-slate-700 focus:border-cyan-500 rounded-lg px-3 py-1.5 text-xs text-slate-100 outline-none">
      </div>
      <div>
        <label class="block text-[11px] text-slate-300 mb-1 font-semibold">توضیحات و مشخصات بازسازی:</label>
        <input type="text" value="${escapeHtml(initialDesc)}" placeholder="توضیحات بازسازی (اختیاری)..." class="rebuildable-desc-input w-full bg-slate-900 border border-slate-700 focus:border-cyan-500 rounded-lg px-3 py-1.5 text-xs text-slate-100 outline-none">
      </div>
    </div>
  `;

  container.appendChild(rowDiv);
  refreshRebuildableRowNumbers();
}

function removeRebuildableItemRow(btn) {
  const container = document.getElementById('rebuildablesContainer');
  if (!container) return;
  const row = btn.closest('.rebuildable-row');
  if (row) {
    if (container.children.length <= 1) {
      showToast('حداقل یک قطعه Rebuildble باید تعریف گردد', 'warning');
      return;
    }
    row.remove();
    refreshRebuildableRowNumbers();
  }
}

function refreshRebuildableRowNumbers() {
  const container = document.getElementById('rebuildablesContainer');
  if (!container) return;
  const rows = container.querySelectorAll('.rebuildable-row');
  rows.forEach((r, idx) => {
    const numEl = r.querySelector('.row-num');
    if (numEl) numEl.textContent = idx + 1;
  });
}

async function handleNewAssetRebuildableSubmit(e) {
  e.preventDefault();
  const scope = getUserAssetScope();

  const supSelect = document.getElementById('newAssetSupervision');
  const unitSelect = document.getElementById('newAssetUnit');
  const assetInput = document.getElementById('newAssetName');

  const supervision = (!scope.isGlobalSup && scope.supervision) ? scope.supervision : (supSelect ? supSelect.value.trim() : '');
  const unit = (!scope.isGlobalUnit && scope.unit) ? scope.unit : (unitSelect ? unitSelect.value.trim() : '');
  const assetName = assetInput ? assetInput.value.trim() : '';

  if (!supervision) {
    showToast('لطفاً سرپرستی را انتخاب فرمایید', 'warning');
    return;
  }
  if (!unit) {
    showToast('لطفاً واحد سازمانی را انتخاب فرمایید', 'warning');
    return;
  }
  if (!assetName) {
    showToast('لطفاً عنوان تجهیز (ASETT) را وارد فرمایید', 'warning');
    return;
  }

  // جمع‌آوری تمامی سطرهای Rebuildable
  const container = document.getElementById('rebuildablesContainer');
  const rows = container ? container.querySelectorAll('.rebuildable-row') : [];
  const recordsToSave = [];

  for (let i = 0; i < rows.length; i++) {
    const nameInput = rows[i].querySelector('.rebuildable-name-input');
    const descInput = rows[i].querySelector('.rebuildable-desc-input');
    const rName = nameInput ? nameInput.value.trim() : '';
    const rDesc = descInput ? descInput.value.trim() : '';

    if (!rName) {
      showToast(`عنوان Rebuildble در سطر ${i + 1} الزامی است`, 'warning');
      if (nameInput) nameInput.focus();
      return;
    }

    recordsToSave.push({
      asset: assetName,
      rebuildable: rName,
      description: rDesc,
      supervision: supervision,
      unit: unit,
      createdAt: new Date().toISOString()
    });
  }

  if (recordsToSave.length === 0) {
    showToast('حداقل یک قطعه Rebuildble باید مشخص شود', 'warning');
    return;
  }

  await saveMultipleAssetRebuildablesToDB(recordsToSave);
  showToast(`تعداد ${recordsToSave.length} قطعه قابل بازسازی برای تجهیز «${assetName}» با موفقیت ذخیره شد`, 'success');
  closeModal('assetAddModal');
  await populateAsettDatalist();
  syncRebuildablesForAsett();
  renderAssetRebuildableUI();
}

function openEditAssetModal(id) {
  const scope = getUserAssetScope();
  const record = (window.AppState.assetRecords || []).find(r => r.id === id);
  if (!record) {
    showToast('رکورد مورد نظر یافت نشد', 'error');
    return;
  }

  if (!canUserAccessAssetRecord(record, scope)) {
    showToast('شما مجاز به ویرایش این رکورد نیستید', 'error');
    return;
  }

  document.getElementById('editAssetId').value = record.id;
  document.getElementById('editAssetName').value = record.asset || '';
  document.getElementById('editAssetRebuildableName').value = record.rebuildable || '';
  document.getElementById('editAssetDescription').value = record.description || '';

  const supSelect = document.getElementById('editAssetSupervision');
  const unitSelect = document.getElementById('editAssetUnit');

  if (supSelect) {
    const supervisions = getStoredSupervisions();
    if (!scope.isGlobalSup) {
      supSelect.innerHTML = `<option value="${escapeHtml(scope.supervision)}">${escapeHtml(scope.supervision)}</option>`;
      supSelect.value = scope.supervision;
      supSelect.disabled = true;
    } else {
      let optionsHtml = '<option value="">-- انتخاب سرپرستی --</option>';
      supervisions.forEach(s => {
        const sName = (typeof s === 'object' && s !== null) ? (s.name || s.title || '') : String(s);
        if (sName) {
          optionsHtml += `<option value="${escapeHtml(sName)}">${escapeHtml(sName)}</option>`;
        }
      });
      supSelect.innerHTML = optionsHtml;
      supSelect.value = record.supervision || '';
      supSelect.disabled = false;
    }
  }

  if (unitSelect) {
    if (!scope.isGlobalUnit) {
      unitSelect.innerHTML = `<option value="${escapeHtml(scope.unit)}">${escapeHtml(scope.unit)}</option>`;
      unitSelect.value = scope.unit;
      unitSelect.disabled = true;
    } else {
      const units = getStoredUnits();
      let optionsHtml = '';
      units.forEach(u => {
        optionsHtml += `<option value="${escapeHtml(u.name)}">${escapeHtml(u.name)}</option>`;
      });
      unitSelect.innerHTML = optionsHtml;
      unitSelect.value = record.unit || '';
      unitSelect.disabled = false;
    }
  }

  openModal('assetEditModal');
}

function onEditAssetSupervisionChange() {
  const supSelect = document.getElementById('editAssetSupervision');
  const unitSelect = document.getElementById('editAssetUnit');
  if (supSelect && unitSelect) {
    const units = getStoredUnits().filter(u => u.supervision === supSelect.value);
    let optionsHtml = '';
    units.forEach(u => {
      optionsHtml += `<option value="${escapeHtml(u.name)}">${escapeHtml(u.name)}</option>`;
    });
    unitSelect.innerHTML = optionsHtml;
  }
}

async function handleEditAssetSubmit(e) {
  e.preventDefault();
  const id = Number(document.getElementById('editAssetId').value);
  const scope = getUserAssetScope();

  const record = (window.AppState.assetRecords || []).find(r => r.id === id);
  if (!record || !canUserAccessAssetRecord(record, scope)) {
    showToast('شما مجاز به ویرایش این رکورد نیستید', 'error');
    return;
  }

  const supSelect = document.getElementById('editAssetSupervision');
  const unitSelect = document.getElementById('editAssetUnit');

  record.asset = document.getElementById('editAssetName').value.trim();
  record.rebuildable = document.getElementById('editAssetRebuildableName').value.trim();
  record.description = document.getElementById('editAssetDescription').value.trim();

  if (scope.isGlobalSup && supSelect) record.supervision = supSelect.value.trim();
  if (scope.isGlobalUnit && unitSelect) record.unit = unitSelect.value.trim();

  await saveAssetRebuildableRecordToDB(record);
  showToast('رکورد با موفقیت به‌روزرسانی شد', 'success');
  closeModal('assetEditModal');
  await populateAsettDatalist();
  syncRebuildablesForAsett();
  renderAssetRebuildableUI();
}

async function confirmDeleteAssetRecord(id) {
  const scope = getUserAssetScope();
  const record = (window.AppState.assetRecords || []).find(r => r.id === id);
  if (!record) return;

  if (!canUserAccessAssetRecord(record, scope)) {
    showToast('شما فقط مجاز به حذف رکوردهای مربوط به سرپرستی و واحد خود هستید', 'error');
    return;
  }

  const msg = `آیا از حذف قطعه بازسازی «${record.rebuildable}» متعلق به تجهیز «${record.asset}» اطمینان دارید؟`;
  if (!confirm(msg)) return;

  await deleteAssetRebuildableRecordFromDB(id);
  window.AppState.assetRecords = (window.AppState.assetRecords || []).filter(r => r.id !== id);
  showToast('رکورد با موفقیت حذف گردید', 'success');
  await populateAsettDatalist();
  syncRebuildablesForAsett();
  applyAssetFiltersAndRender();
}

// ==========================================
// صادر کردن و وارد کردن فایل اکسل (Excel Import / Export)
// ==========================================
function exportAssetRebuildablesToExcel() {
  const list = window.AppState.filteredAssetRecords || [];
  if (list.length === 0) {
    showToast('رکوردی جهت استخراج به اکسل یافت نشد', 'warning');
    return;
  }

  const aoa = [
    ['شماره ردیف', 'ASETT', 'Rebuildble', 'توضیحات', 'سرپرستی', 'واحد']
  ];

  list.forEach((r, idx) => {
    aoa.push([
      idx + 1,
      r.asset || '',
      r.rebuildable || '',
      r.description || '',
      r.supervision || '',
      r.unit || ''
    ]);
  });

  if (typeof XLSX !== 'undefined') {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);

    ws['!cols'] = [
      { wch: 12 }, // شماره ردیف
      { wch: 32 }, // ASETT
      { wch: 32 }, // Rebuildble
      { wch: 50 }, // توضیحات
      { wch: 28 }, // سرپرستی
      { wch: 28 }  // واحد
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Asset_Rebuildables');
    const todayStr = getFormattedJalali().dateNumStr.replace(/\//g, '-');
    XLSX.writeFile(wb, `Asset_Rebuildables_${todayStr}.xlsx`);
    showToast(`فایل اکسل با ${list.length} رکورد با موفقیت ایجاد شد`, 'success');
  } else {
    // خروجی CSV سازگار
    let csv = '\uFEFF' + aoa.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Asset_Rebuildables.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('فایل با موفقیت بارگیری شد', 'success');
  }
}

function downloadAssetExcelTemplate() {
  const scope = getUserAssetScope();
  const sampleSup = (!scope.isGlobalSup && scope.supervision) ? scope.supervision : 'سرپرستی ابزار دقیق و اتوماسیون';
  const sampleUnit = (!scope.isGlobalUnit && scope.unit) ? scope.unit : 'واحد نگهداری و تعمیرات';

  const aoa = [
    ['شماره ردیف', 'ASETT', 'Rebuildble', 'توضیحات', 'سرپرستی', 'واحد'],
    [1, 'کمپرسور اطلس کوپکو GA-75', 'المنت فیلتر هوا', 'سرویس هر ۵۰۰۰ ساعت و تعویض با کیت اورجینال', sampleSup, sampleUnit],
    [2, 'کمپرسور اطلس کوپکو GA-75', 'شیر آنلودر', 'بررسی اورینگ‌ها و فنر داخلی', sampleSup, sampleUnit],
    [3, 'ترانسمیتر فشار Rosemount 3051', 'کپسول دیافراگمی هسلوی', 'کالیبراسیون ۵ نقطه‌ای و تست نشتی', sampleSup, sampleUnit]
  ];

  if (typeof XLSX !== 'undefined') {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 32 }, { wch: 32 }, { wch: 50 }, { wch: 28 }, { wch: 28 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Sample_Template');
    XLSX.writeFile(wb, 'Asset_Rebuildables_Template.xlsx');
    showToast('فایل قالب نمونه اکسل دانلود شد', 'info');
  } else {
    let csv = '\uFEFF' + aoa.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Asset_Rebuildables_Template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

async function handleAssetExcelUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const scope = getUserAssetScope();

  try {
    const data = await file.arrayBuffer();
    if (typeof XLSX === 'undefined') {
      showToast('کتابخانه پردازش اکسل بارگذاری نشده است', 'error');
      event.target.value = '';
      return;
    }

    const workbook = XLSX.read(data, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    if (!rows || rows.length < 2) {
      showToast('فایل اکسل خالی است یا فاقد سطر داده می‌باشد', 'warning');
      event.target.value = '';
      return;
    }

    // شناسایی ستون‌ها از سطر نخست
    const headerRow = rows[0].map(h => String(h || '').trim().toLowerCase());
    let idxAsset = -1, idxReb = -1, idxDesc = -1, idxSup = -1, idxUnit = -1;

    headerRow.forEach((col, idx) => {
      if (col.includes('asett') || col.includes('asset') || col.includes('تجهیز')) idxAsset = idx;
      else if (col.includes('rebuid') || col.includes('rebuild') || col.includes('قطعه') || col.includes('بازسازی')) idxReb = idx;
      else if (col.includes('توضیح') || col.includes('شرح') || col.includes('desc') || col.includes('note')) idxDesc = idx;
      else if (col.includes('سرپرست') || col.includes('supervision')) idxSup = idx;
      else if (col.includes('واحد') || col.includes('unit')) idxUnit = idx;
    });

    if (idxAsset === -1 && rows[0].length >= 3) {
      idxAsset = 1;
      idxReb = 2;
      idxDesc = 3;
      idxSup = 4;
      idxUnit = 5;
    }

    const recordsToImport = [];
    let skippedCount = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      const assetName = String(row[idxAsset] || '').trim();
      const rebName = String(row[idxReb] || '').trim();
      const desc = idxDesc !== -1 ? String(row[idxDesc] || '').trim() : '';
      let rowSup = idxSup !== -1 ? String(row[idxSup] || '').trim() : '';
      let rowUnit = idxUnit !== -1 ? String(row[idxUnit] || '').trim() : '';

      if (!assetName && !rebName) continue;

      // بررسی سطح دسترسی کاربر
      if (!scope.isGlobalSup) {
        if (rowSup && rowSup !== scope.supervision) {
          skippedCount++;
          continue;
        }
        rowSup = scope.supervision;
      } else if (!rowSup) {
        rowSup = 'سرپرستی ابزار دقیق و اتوماسیون';
      }

      if (!scope.isGlobalUnit) {
        if (rowUnit && rowUnit !== scope.unit) {
          skippedCount++;
          continue;
        }
        rowUnit = scope.unit;
      } else if (!rowUnit) {
        rowUnit = 'واحد عمومی';
      }

      recordsToImport.push({
        asset: assetName || 'تجهیز نامشخص',
        rebuildable: rebName || 'قطعه نامشخص',
        description: desc,
        supervision: rowSup,
        unit: rowUnit,
        createdAt: new Date().toISOString(),
        importedFromExcel: true
      });
    }

    if (recordsToImport.length === 0) {
      if (skippedCount > 0) {
        showToast(`هیچ رکوردی منطبق با حوزه سرپرستی و واحد شما یافت نشد (${skippedCount} سطر مغایر با دسترسی نادیده گرفته شد)`, 'warning');
      } else {
        showToast('رکوردی جهت واردسازی از اکسل یافت نشد', 'warning');
      }
      event.target.value = '';
      return;
    }

    await saveMultipleAssetRebuildablesToDB(recordsToImport);
    showToast(`تعداد ${recordsToImport.length} رکورد با موفقیت از اکسل وارد گردید` + (skippedCount > 0 ? ` (${skippedCount} سطر خارج از دسترسی فیلتر شد)` : ''), 'success');
    event.target.value = '';
    await populateAsettDatalist();
    syncRebuildablesForAsett();
    renderAssetRebuildableUI();
  } catch (err) {
    console.error('Error importing excel:', err);
    showToast('خطا در پردازش فایل اکسل', 'error');
    event.target.value = '';
  }
}

// صادر کردن تمام توابع عمومی و رویدادها در شیء پنجره مرورگر (window)
window.addSelectedActivity = addSelectedActivity;
window.removeAddedActivity = removeAddedActivity;
window.renderAddedActivitiesList = renderAddedActivitiesList;
window.handleActivityChange = handleActivityChange;
window.openPhotoViewerModal = openPhotoViewerModal;
window.closePhotoViewerModal = closePhotoViewerModal;
window.removeSinglePhoto = removeSinglePhoto;
window.removeAllCapturedPhotos = removeAllCapturedPhotos;
window.removeCapturedImage = removeCapturedImage;
window.renderImagePreview = renderImagePreview;
window.addColleague = addColleague;
window.removeColleague = removeColleague;
window.handleColleagueInput = handleColleagueInput;
window.findPersonnelByCode = findPersonnelByCode;
window.renderColleaguesList = renderColleaguesList;
window.clearQrField = clearQrField;
window.handleAsettInput = handleAsettInput;
window.openQrScannerModal = openQrScannerModal;
window.closeQrScannerModal = closeQrScannerModal;
window.openModal = openModal;
window.closeModal = closeModal;
window.toggleTheme = toggleTheme;
window.updateGPSLocation = updateGPSLocation;
window.startAutoGPS = startAutoGPS;
window.switchToHomeView = switchToHomeView;
window.syncPendingRecords = syncPendingRecords;
window.exportToExcel = exportToExcel;
window.printReportsAsPDF = printReportsAsPDF;
window.exportFullBackup = exportFullBackup;
window.resetAdminFilters = resetAdminFilters;
window.resetOrgStructureToDefault = resetOrgStructureToDefault;
window.handleAdminLogout = handleAdminLogout;
window.openAdminAccess = openAdminAccess;
window.closeAdminWelcomeBanner = closeAdminWelcomeBanner;
window.showDetailModal = showDetailModal;
window.deleteRecord = deleteRecord;
window.confirmDeleteReport = confirmDeleteReport;
window.deleteAdmin = deleteAdmin;
window.confirmDeleteAdmin = confirmDeleteAdmin;
window.toggleAdminPersonnelAccess = toggleAdminPersonnelAccess;
window.toggleAdminModulePermission = toggleAdminModulePermission;
window.openEditAdminModal = openEditAdminModal;
window.populateEditAdminUnitsDropdown = populateEditAdminUnitsDropdown;
window.onEditAdminSupervisionChange = onEditAdminSupervisionChange;
window.updateEditAdminScopeHint = updateEditAdminScopeHint;
window.handleEditAdminSubmit = handleEditAdminSubmit;
window.updateNewAdminScopeHint = updateNewAdminScopeHint;
window.handleDeleteSupervision = handleDeleteSupervision;
window.handleEditSupervision = handleEditSupervision;
window.handleDeleteUnit = handleDeleteUnit;
window.handleEditUnit = handleEditUnit;
window.showAdminTab = showAdminTab;
window.renderPersonnelTable = renderPersonnelTable;
window.toggleAddPersonnelForm = toggleAddPersonnelForm;
window.handleNewPersonnelSubmit = handleNewPersonnelSubmit;
window.editPersonnelRecord = editPersonnelRecord;
window.confirmDeletePersonnel = confirmDeletePersonnel;
window.confirmResetPersonnelData = confirmResetPersonnelData;
window.onPersonnelSearchInput = onPersonnelSearchInput;
window.clearPersonnelSearch = clearPersonnelSearch;
window.onPersonnelPageSizeChange = onPersonnelPageSizeChange;
window.goToPersonnelPage = goToPersonnelPage;
window.switchInstallTab = switchInstallTab;
window.handlePWAInstallClick = handlePWAInstallClick;
window.triggerDirectInstall = triggerDirectInstall;
window.dismissPWABanner = dismissPWABanner;
// توابع ماژول مدت زمان و کرنومتر
window.toggleStopwatchPanel = toggleStopwatchPanel;
window.openStopwatchModal = openStopwatchModal;
window.closeStopwatchModal = closeStopwatchModal;
window.toggleStopwatchStartPause = toggleStopwatchStartPause;
window.startStopwatch = startStopwatch;
window.pauseStopwatch = pauseStopwatch;
window.resetStopwatch = resetStopwatch;
window.handleStopwatchSet = handleStopwatchSet;
window.syncStopwatchFromFormInputs = syncStopwatchFromFormInputs;
window.syncStopwatchTimeToFormInputs = syncStopwatchTimeToFormInputs;
window.applyStopwatchTimeToForm = applyStopwatchTimeToForm;
window.saveDurationTime = saveDurationTime;
window.updateDurationFormattedDisplay = updateDurationFormattedDisplay;
window.clearDurationInputs = clearDurationInputs;

// توابع ماژول asset &Rebuildble
window.renderAssetRebuildableUI = renderAssetRebuildableUI;
window.openAddAssetModal = openAddAssetModal;
window.onNewAssetSupervisionChange = onNewAssetSupervisionChange;
window.addNewRebuildableItemRow = addNewRebuildableItemRow;
window.removeRebuildableItemRow = removeRebuildableItemRow;
window.handleNewAssetRebuildableSubmit = handleNewAssetRebuildableSubmit;
window.openEditAssetModal = openEditAssetModal;
window.onEditAssetSupervisionChange = onEditAssetSupervisionChange;
window.handleEditAssetSubmit = handleEditAssetSubmit;
window.confirmDeleteAssetRecord = confirmDeleteAssetRecord;
window.exportAssetRebuildablesToExcel = exportAssetRebuildablesToExcel;
window.downloadAssetExcelTemplate = downloadAssetExcelTemplate;
window.handleAssetExcelUpload = handleAssetExcelUpload;
window.onAssetSearchInput = onAssetSearchInput;
window.clearAssetSearch = clearAssetSearch;
window.onAssetFilterSupervisionChange = onAssetFilterSupervisionChange;
window.onAssetFilterUnitChange = onAssetFilterUnitChange;
window.handleRebuildableSelectChange = handleRebuildableSelectChange;
window.clearRebuildableSelection = clearRebuildableSelection;
window.syncRebuildablesForAsett = syncRebuildablesForAsett;
window.populateAsettDatalist = populateAsettDatalist;
window.DEFAULT_ASSET_REBUILDABLES = DEFAULT_ASSET_REBUILDABLES;
window.ensureDefaultAssetRebuildables = ensureDefaultAssetRebuildables;

// توابع تقویم هجری شمسی و ساعت آنالوگ ماژول گزارش‌ها و کارتابل
window.openPersianCalendarModal = openPersianCalendarModal;
window.closePersianCalendarModal = closePersianCalendarModal;
window.switchCalendarTarget = switchCalendarTarget;
window.navigateCalendarMonth = navigateCalendarMonth;
window.onCalendarSelectChange = onCalendarSelectChange;
window.selectCalendarDay = selectCalendarDay;
window.applyQuickDatePreset = applyQuickDatePreset;
window.confirmPersianCalendarSelection = confirmPersianCalendarSelection;
window.clearDateFilters = clearDateFilters;

window.openAnalogClockModal = openAnalogClockModal;
window.closeAnalogClockModal = closeAnalogClockModal;
window.switchClockTarget = switchClockTarget;
window.setClockSelectionMode = setClockSelectionMode;
window.adjustClockValue = adjustClockValue;
window.applyClockShiftPreset = applyClockShiftPreset;
window.clearClockFilter = clearClockFilter;
window.confirmAnalogClockSelection = confirmAnalogClockSelection;
window.clearTimeFilters = clearTimeFilters;
window.getReportRowData = getReportRowData;

// مدیریت صفحه درباره سامانه و شناسنامه نرم‌افزار
if (typeof openAboutSystemPage !== 'undefined') {
  window.openAboutSystemPage = openAboutSystemPage;
  window.transitionToAboutContent = transitionToAboutContent;
  window.closeAboutSystemPage = closeAboutSystemPage;
}

// مدیریت نسخه و بروزرسانی اپلیکیشن در حالت نصب‌شده PWA
window.checkAppUpdate = checkAppUpdate;
window.applyAppUpdate = applyAppUpdate;
window.dismissAppUpdate = dismissAppUpdate;
window.APP_VERSION = APP_VERSION;



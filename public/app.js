// S3 Reseller Frontend Application
const App = {
  user: null,
  currentPage: 'login',
  storageData: null,
  files: [],
  currentPrefix: '',
  exchangeRates: null,
  selectedCurrency: 'HUF',
  storageViewMode: 'bar', // 'bar' or 'pie'
  maintenanceMode: false,
  uploadProgress: null,

  async init() {
    // Check maintenance mode first
    await this.checkMaintenance();
    if (this.maintenanceMode && !sessionStorage.getItem('maintenanceBypass')) {
      this.showMaintenancePage();
      return;
    }

    await this.checkAuth();
    await this.loadExchangeRates();
    this.render();
  },

  async checkMaintenance() {
    try {
      const res = await fetch('/api/system/maintenance');
      const data = await res.json();
      this.maintenanceMode = data.maintenance;
    } catch (e) { }
  },

  async loadExchangeRates() {
    try {
      const res = await fetch('/api/system/exchange-rates');
      this.exchangeRates = await res.json();
    } catch (e) { }
  },

  showMaintenancePage() {
    document.getElementById('app').innerHTML = this.renderMaintenance();
    document.getElementById('maintenanceCodeForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = e.target.code.value;
      try {
        const res = await fetch('/api/system/maintenance-bypass', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        if (res.ok) {
          sessionStorage.setItem('maintenanceBypass', 'true');
          location.reload();
        } else {
          this.showToast('Hibás kód', 'error');
        }
      } catch (e) {
        this.showToast('Hiba történt', 'error');
      }
    });
  },

  renderMaintenance() {
    return `
      <div class="maintenance-page">
        <div class="maintenance-icon">
          <svg class="w-16 h-16 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>
        <h1 class="text-4xl font-bold text-gradient mb-4">Karbantartás</h1>
        <p class="text-[hsl(var(--muted-foreground))] mb-8 max-w-md">
          A rendszer jelenleg karbantartás alatt van. Kérjük, próbáld újra később.
        </p>
        <form id="maintenanceCodeForm" class="flex gap-3">
          <input type="text" name="code" placeholder="Admin kód" class="input w-48">
          <button type="submit" class="btn-primary">Belépés</button>
        </form>
      </div>
    `;
  },

  // Modal System
  showModal(options) {
    const { title, content, buttons = [], onClose } = options;
    const modalContainer = document.getElementById('modal-container');

    const buttonHtml = buttons.map(btn =>
      `<button onclick="App.handleModalButton('${btn.action}')" class="${btn.class || 'btn-secondary'}">${btn.text}</button>`
    ).join('');

    modalContainer.innerHTML = `
      <div class="modal-overlay" onclick="if(event.target === this) App.closeModal()">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="text-lg font-semibold">${title}</h3>
          </div>
          <div class="modal-body">
            ${content}
          </div>
          <div class="modal-footer">
            ${buttonHtml}
          </div>
        </div>
      </div>
    `;

    this._modalCallbacks = { onClose, buttons };
  },

  handleModalButton(action) {
    const btn = this._modalCallbacks?.buttons?.find(b => b.action === action);
    if (btn?.onClick) {
      btn.onClick();
    }
    if (action !== 'stay') {
      this.closeModal();
    }
  },

  closeModal() {
    document.getElementById('modal-container').innerHTML = '';
    if (this._modalCallbacks?.onClose) {
      this._modalCallbacks.onClose();
    }
    this._modalCallbacks = null;
  },

  // Input Modal
  async promptModal(title, inputLabel, defaultValue = '') {
    return new Promise((resolve) => {
      const modalContainer = document.getElementById('modal-container');
      modalContainer.innerHTML = `
        <div class="modal-overlay" onclick="if(event.target === this) App.closeModal()">
          <div class="modal-content">
            <div class="modal-header">
              <h3 class="text-lg font-semibold">${title}</h3>
            </div>
            <div class="modal-body">
              <label class="block text-sm text-[hsl(var(--muted-foreground))] mb-2">${inputLabel}</label>
              <input type="text" id="modalInput" class="input" value="${defaultValue}">
            </div>
            <div class="modal-footer">
              <button onclick="App.resolvePromptModal(false)" class="btn-ghost">Mégse</button>
              <button onclick="App.resolvePromptModal(true)" class="btn-primary">OK</button>
            </div>
          </div>
        </div>
      `;
      this._promptResolve = resolve;
      document.getElementById('modalInput').focus();
    });
  },

  resolvePromptModal(confirmed) {
    const value = confirmed ? document.getElementById('modalInput')?.value : null;
    this.closeModal();
    if (this._promptResolve) {
      this._promptResolve(value);
      this._promptResolve = null;
    }
  },

  // Confirm Modal
  async confirmModal(title, message) {
    return new Promise((resolve) => {
      this.showModal({
        title,
        content: `<p class="text-[hsl(var(--muted-foreground))]">${message}</p>`,
        buttons: [
          { text: 'Mégse', action: 'cancel', class: 'btn-ghost', onClick: () => resolve(false) },
          { text: 'OK', action: 'confirm', class: 'btn-primary', onClick: () => resolve(true) }
        ]
      });
    });
  },

  // Upload Progress
  showUploadProgress(fileName) {
    const container = document.getElementById('upload-progress-container');
    container.innerHTML = `
      <div class="upload-progress" id="uploadProgressBox">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium truncate max-w-[200px]">${fileName}</span>
          <span class="text-sm text-[hsl(var(--muted-foreground))]" id="uploadPercent">0%</span>
        </div>
        <div class="upload-progress-bar">
          <div class="upload-progress-fill" id="uploadProgressFill" style="width: 0%"></div>
        </div>
      </div>
    `;
  },

  updateUploadProgress(percent, error = false) {
    const fill = document.getElementById('uploadProgressFill');
    const text = document.getElementById('uploadPercent');
    const box = document.getElementById('uploadProgressBox');

    if (fill) fill.style.width = `${percent}%`;
    if (text) text.textContent = `${percent}%`;
    if (error && box) box.classList.add('upload-progress-error');
  },

  hideUploadProgress() {
    setTimeout(() => {
      document.getElementById('upload-progress-container').innerHTML = '';
    }, 1500);
  },

  async checkAuth() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        this.user = await res.json();
        this.currentPage = this.user.is_admin ? 'admin' : 'dashboard';
      }
    } catch (e) { }
  },

  async api(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    return data;
  },

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },

  render() {
    const app = document.getElementById('app');
    if (this.user?.is_suspended) {
      app.innerHTML = this.renderSuspended();
    } else if (this.currentPage === 'login') {
      app.innerHTML = this.renderLogin();
    } else if (this.currentPage === 'register') {
      app.innerHTML = this.renderRegister();
    } else if (this.currentPage === 'dashboard') {
      app.innerHTML = this.renderDashboard();
      this.loadDashboardData();
    } else if (this.currentPage === 'files') {
      app.innerHTML = this.renderFiles();
      this.loadFiles();
    } else if (this.currentPage === 'settings') {
      app.innerHTML = this.renderSettings();
    } else if (this.currentPage === 'admin') {
      app.innerHTML = this.renderAdmin();
      this.loadAdminData();
    } else if (this.currentPage === 'admin_files') {
      app.innerHTML = this.renderAdminUserFiles();
      this.loadAdminUserFiles();
    }
    this.bindEvents();
  },

  renderSuspended() {
    const reason = this.user?.suspension_reason || 'Ismeretlen ok';
    const until = this.user?.suspension_until ? new Date(this.user.suspension_until).toLocaleString('hu-HU') : null;

    return `
      <div class="min-h-screen flex items-center justify-center p-4">
        <div class="glass-card-elevated p-8 max-w-md w-full text-center">
          <div class="w-20 h-20 mx-auto mb-6 rounded-full bg-[hsl(var(--destructive)/0.1)] flex items-center justify-center">
            <svg class="w-10 h-10 text-[hsl(var(--destructive))]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          </div>
          <h1 class="text-2xl font-bold text-[hsl(var(--destructive))] mb-4">Fiók Felfüggesztve</h1>
          <div class="glass-card p-4 mb-6 text-left">
            <p class="text-sm text-[hsl(var(--muted-foreground))] mb-1">Indok:</p>
            <p class="text-[hsl(var(--foreground))]">${reason}</p>
            ${until ? `
              <p class="text-sm text-[hsl(var(--muted-foreground))] mt-3 mb-1">Lejárat:</p>
              <p class="text-[hsl(var(--foreground))]">${until}</p>
            ` : ''}
          </div>
          <button onclick="App.logout()" class="btn-secondary">Kijelentkezés</button>
        </div>
      </div>`;
  },

  renderNav() {
    return `
      <header class="fixed top-0 left-0 right-0 z-50 bg-[hsl(var(--background)/0.8)] backdrop-blur-xl border-b border-[hsl(var(--border)/0.3)]">
        <div class="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <a href="/" class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-gradient-to-br from-white to-gray-400 flex items-center justify-center">
              <svg class="w-5 h-5 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" /></svg>
            </div>
            <div class="flex flex-col">
              <span class="font-bold text-lg leading-tight">Wixity Cloud</span>
              <span class="text-[10px] text-[hsl(var(--muted-foreground))] tracking-widest uppercase">S3 Storage</span>
            </div>
          </a>
          <nav class="flex items-center gap-2">
            ${this.user?.is_admin ? `
              <button onclick="App.goTo('admin')" class="btn-ghost ${this.currentPage === 'admin' ? 'text-white bg-[hsl(var(--secondary))]' : ''}">Admin</button>
            ` : `
              <button onclick="App.goTo('dashboard')" class="btn-ghost ${this.currentPage === 'dashboard' ? 'text-white bg-[hsl(var(--secondary))]' : ''}">Dashboard</button>
              <button onclick="App.goTo('files')" class="btn-ghost ${this.currentPage === 'files' ? 'text-white bg-[hsl(var(--secondary))]' : ''}">Fájlok</button>
            `}
            <button onclick="App.goTo('settings')" class="btn-ghost ${this.currentPage === 'settings' ? 'text-white bg-[hsl(var(--secondary))]' : ''}">Beállítások</button>
            <button onclick="App.logout()" class="btn-ghost hover:text-[hsl(var(--destructive))]">Kilépés</button>
          </nav>
        </div>
      </header>`;
  },

  renderLogin() {
    return `
      <div class="min-h-screen flex items-center justify-center p-4">
        <div class="glass-card p-8 max-w-md w-full animate-slide-up">
          <div class="text-center mb-8">
            <div class="w-20 h-20 rounded-2xl bg-gradient-to-br from-white to-gray-400 flex items-center justify-center mx-auto mb-6 animate-float shadow-[0_0_40px_rgba(255,255,255,0.15)]">
              <svg class="w-10 h-10 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" /></svg>
            </div>
            <h1 class="text-4xl font-bold text-gradient mb-2">Wixity Cloud S3</h1>
            <p class="text-[hsl(var(--muted-foreground))] mt-2">Prémium Cloud Tárhely</p>
          </div>
          <form id="loginForm" class="space-y-4">
            <div>
              <label class="block text-sm text-[hsl(var(--muted-foreground))] mb-2">Email</label>
              <input type="email" name="email" required class="input">
            </div>
            <div>
              <label class="block text-sm text-[hsl(var(--muted-foreground))] mb-2">Jelszó</label>
              <input type="password" name="password" required class="input">
            </div>
            <div id="loginError" class="text-[hsl(var(--destructive))] text-sm hidden bg-[hsl(var(--destructive)/0.1)] p-3 rounded-lg border border-[hsl(var(--destructive)/0.2)]"></div>
            <button type="submit" class="w-full btn-primary py-3">Bejelentkezés</button>
          </form>
          <p class="text-center text-[hsl(var(--muted-foreground))] mt-6">Nincs még fiókod? <button onclick="App.goTo('register')" class="text-white hover:underline">Regisztráció</button></p>
        </div>
      </div>`;
  },

  renderRegister() {
    return `
      <div class="min-h-screen flex items-center justify-center p-4">
        <div class="glass-card p-8 max-w-md w-full animate-slide-up">
          <div class="text-center mb-8">
            <div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-white to-gray-400 flex items-center justify-center mx-auto mb-4">
              <svg class="w-8 h-8 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" /></svg>
            </div>
            <h1 class="text-3xl font-bold text-gradient">Regisztráció</h1>
            <p class="text-[hsl(var(--muted-foreground))] mt-2">Hozd létre a fiókodat</p>
          </div>
          <form id="registerForm" class="space-y-4">
            <div>
              <label class="block text-sm text-[hsl(var(--muted-foreground))] mb-2">Email</label>
              <input type="email" name="email" required class="input">
            </div>
            <div>
              <label class="block text-sm text-[hsl(var(--muted-foreground))] mb-2">Jelszó</label>
              <input type="password" name="password" required minlength="4" class="input">
            </div>
            <div id="registerError" class="text-[hsl(var(--destructive))] text-sm hidden bg-[hsl(var(--destructive)/0.1)] p-3 rounded-lg border border-[hsl(var(--destructive)/0.2)]"></div>
            <button type="submit" class="w-full btn-primary py-3">Regisztráció</button>
          </form>
          <p class="text-center text-[hsl(var(--muted-foreground))] mt-6">Van már fiókod? <button onclick="App.goTo('login')" class="text-white hover:underline">Bejelentkezés</button></p>
        </div>
      </div>`;
  },

  renderDashboard() {
    return `
      ${this.renderNav()}
      <main class="pt-24 pb-12 px-4">
        <div class="max-w-6xl mx-auto animate-slide-up">
          <h1 class="text-3xl font-bold mb-2 text-gradient">Dashboard</h1>
          <p class="text-[hsl(var(--muted-foreground))] mb-8">Fiókod áttekintése</p>
          
          <div class="grid md:grid-cols-2 gap-6 mb-8">
            <div class="glass-card-elevated p-6 shine-effect">
              <div class="flex items-center justify-between mb-6">
                <h2 class="text-lg font-semibold">Tárhely Használat</h2>
                <div class="flex items-center gap-3">
                  <button onclick="App.toggleStorageView()" class="btn-ghost p-2" title="Nézet váltása">
                    <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" /></svg>
                  </button>
                  <div class="w-10 h-10 rounded-lg bg-[hsl(var(--secondary))] flex items-center justify-center">
                    <svg class="w-5 h-5 text-[hsl(var(--foreground)/0.7)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" /></svg>
                  </div>
                </div>
              </div>
              <div id="storageWidget">
                <div class="text-center py-8">
                  <div class="animate-spin w-8 h-8 border-2 border-white border-t-transparent rounded-full mx-auto"></div>
                </div>
              </div>
            </div>
            
            <div class="glass-card-elevated p-6 shine-effect">
              <div class="flex items-center justify-between mb-6">
                <h2 class="text-lg font-semibold">API Hozzáférés</h2>
                <div class="w-10 h-10 rounded-lg bg-[hsl(var(--secondary))] flex items-center justify-center">
                  <svg class="w-5 h-5 text-[hsl(var(--foreground)/0.7)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
                </div>
              </div>
              <div class="space-y-3 text-sm font-mono" id="apiCredentials">
                <div class="space-y-2 opacity-50">
                  <div class="h-10 bg-[hsl(var(--secondary))] rounded animate-pulse"></div>
                  <div class="h-10 bg-[hsl(var(--secondary))] rounded animate-pulse"></div>
                  <div class="h-10 bg-[hsl(var(--secondary))] rounded animate-pulse"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="glass-card-elevated p-6">
            <h2 class="text-lg font-semibold mb-6 flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-[hsl(var(--warning)/0.2)] flex items-center justify-center">
                <svg class="w-4 h-4 text-[hsl(var(--warning))]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>
              </div>
              Tárhely Vásárlás
            </h2>
            <div class="mb-6">
              <div class="flex justify-between items-end mb-4">
                <label class="text-sm text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Mennyiség kiválasztása</label>
                <div class="flex bg-[hsl(var(--secondary))] p-1 rounded-lg">
                  <button id="curr-btn-HUF" onclick="App.changeCurrency('HUF')" class="px-3 py-1 rounded text-sm font-medium transition bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]">HUF</button>
                  <button id="curr-btn-EUR" onclick="App.changeCurrency('EUR')" class="px-3 py-1 rounded text-sm font-medium transition text-[hsl(var(--muted-foreground))] hover:text-white">EUR</button>
                  <button id="curr-btn-USD" onclick="App.changeCurrency('USD')" class="px-3 py-1 rounded text-sm font-medium transition text-[hsl(var(--muted-foreground))] hover:text-white">USD</button>
                </div>
              </div>
              <input type="range" id="storageSlider" min="1" max="1000" value="10" class="w-full mb-6">
              <div class="flex justify-between items-center bg-[hsl(var(--secondary))] p-6 rounded-xl">
                <div>
                  <span class="text-[hsl(var(--muted-foreground))] text-sm block mb-1">Kiválasztott Tárhely</span>
                  <span id="storageAmount" class="text-3xl font-bold">10 GB</span>
                </div>
                <div class="text-right">
                  <span class="text-[hsl(var(--muted-foreground))] text-sm block mb-1">Fizetendő összeg</span>
                  <span id="storagePrice" class="text-3xl font-bold">50 Ft</span>
                </div>
              </div>
            </div>
            <button id="paypalPayBtn" class="w-full bg-[#FFC439] hover:bg-[#FFD166] text-black font-bold py-4 rounded-xl flex items-center justify-center gap-3 transition transform hover:-translate-y-0.5">
              <svg class="w-6 h-6" viewBox="0 0 24 24" fill="currentColor"><path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944 3.72a.77.77 0 0 1 .757-.629h6.724c2.332 0 4.058.625 5.13 1.86.976 1.124 1.34 2.657 1.082 4.558l-.065.404c-.46 2.5-2.312 4.756-5.648 4.756H8.467l-.696 4.234c-.08.484-.496.847-.988.847h-2.17l-.633 3.587h3.096z"/></svg>
              Fizetés PayPal-lal
            </button>
            <div class="mt-4 flex items-center justify-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
              <span class="w-2 h-2 rounded-full bg-[hsl(var(--success))]"></span>
              SSL Védett Biztonságos Fizetés
            </div>
          </div>
        </div>
      </main>
      ${this.renderFooter()}`;
  },

  renderFiles() {
    return `
      ${this.renderNav()}
      <main class="pt-24 pb-12 px-4">
        <div class="max-w-7xl mx-auto animate-slide-up">
          <div class="flex items-center justify-between mb-8">
            <div>
              <h1 class="text-3xl font-bold text-gradient">Fájlkezelő</h1>
              <p class="text-[hsl(var(--muted-foreground))] mt-1 font-mono text-sm bg-[hsl(var(--secondary))] inline-block px-2 py-1 rounded">/${this.currentPrefix}</p>
            </div>
            <div class="flex gap-3">
              <button onclick="App.createFolder()" class="btn-secondary flex items-center gap-2">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>
                Új mappa
              </button>
              <label class="btn-primary flex items-center gap-2 cursor-pointer">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                Feltöltés
                <input type="file" id="fileUpload" class="hidden" multiple>
              </label>
            </div>
          </div>

          ${this.currentPrefix ? `
            <button onclick="App.navigateUp()" class="mb-4 btn-ghost flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
              Vissza
            </button>
          ` : ''}

          <div class="glass-card-elevated overflow-hidden">
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead class="bg-[hsl(var(--secondary)/0.3)] border-b border-[hsl(var(--border)/0.3)]">
                  <tr>
                    <th class="text-left px-6 py-4 font-medium text-[hsl(var(--muted-foreground))]">Név</th>
                    <th class="text-left px-6 py-4 font-medium text-[hsl(var(--muted-foreground))]">Méret</th>
                    <th class="text-left px-6 py-4 font-medium text-[hsl(var(--muted-foreground))]">Módosítva</th>
                    <th class="text-right px-6 py-4 font-medium text-[hsl(var(--muted-foreground))]">Műveletek</th>
                  </tr>
                </thead>
                <tbody id="fileList" class="divide-y divide-[hsl(var(--border)/0.2)]">
                  <tr><td colspan="4" class="px-6 py-12 text-center text-[hsl(var(--muted-foreground))] italic">Betöltés...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
      ${this.renderFooter()}`;
  },

  renderSettings() {
    return `
      ${this.renderNav()}
      <main class="pt-24 pb-12 px-4">
        <div class="max-w-2xl mx-auto animate-slide-up">
          <h1 class="text-3xl font-bold text-gradient mb-2">Beállítások</h1>
          <p class="text-[hsl(var(--muted-foreground))] mb-8">Fiókbeállítások kezelése</p>
          
          <div class="glass-card-elevated p-6 mb-6">
            <h2 class="text-lg font-semibold mb-4">Fiók Adatok</h2>
            <div class="space-y-3">
              <div class="flex items-center gap-3">
                <span class="text-[hsl(var(--muted-foreground))]">Email:</span>
                <span class="font-medium">${this.user?.email}</span>
              </div>
            </div>
          </div>

          <div class="glass-card-elevated p-6">
            <h2 class="text-lg font-semibold mb-4">Jelszó Módosítás</h2>
            <form id="passwordForm" class="space-y-4">
              <div>
                <label class="block text-sm text-[hsl(var(--muted-foreground))] mb-2">Jelenlegi jelszó</label>
                <input type="password" name="currentPassword" required class="input">
              </div>
              <div>
                <label class="block text-sm text-[hsl(var(--muted-foreground))] mb-2">Új jelszó</label>
                <input type="password" name="newPassword" required minlength="4" class="input">
              </div>
              <div id="passwordError" class="text-[hsl(var(--destructive))] text-sm hidden"></div>
              <div id="passwordSuccess" class="text-[hsl(var(--success))] text-sm hidden"></div>
              <button type="submit" class="btn-primary">Mentés</button>
            </form>
          </div>
        </div>
      </main>
      ${this.renderFooter()}`;
  },

  renderAdmin() {
    return `
      ${this.renderNav()}
      <main class="pt-24 pb-12 px-4">
        <div class="max-w-7xl mx-auto animate-slide-up">
          <div class="flex items-center justify-between mb-8">
            <div>
              <h1 class="text-3xl font-bold text-gradient">Admin Panel</h1>
              <p class="text-[hsl(var(--muted-foreground))]">Rendszer áttekintés</p>
            </div>
            <div class="flex gap-3">
              <button onclick="App.toggleMaintenance()" class="btn-secondary flex items-center gap-2 ${this.maintenanceMode ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' : ''}" title="Karbantartás Mód">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                ${this.maintenanceMode ? 'Karbantartás: BE' : 'Karbantartás: KI'}
              </button>
              <button onclick="App.loadAdminData()" class="btn-secondary flex items-center gap-2" title="Frissítés">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                Frissítés
              </button>
            </div>
          </div>

          <div class="grid md:grid-cols-4 gap-4 mb-8" id="adminStats">
            ${[1, 2, 3, 4].map(() => `<div class="glass-card p-6 h-32 animate-pulse shine-effect"></div>`).join('')}
          </div>

          <div class="glass-card-elevated overflow-hidden mb-8">
            <div class="px-6 py-4 border-b border-[hsl(var(--border)/0.3)] flex items-center justify-between bg-[hsl(var(--secondary)/0.3)]">
              <h2 class="text-lg font-semibold">Függőben lévő fizetések</h2>
              <span class="badge-warning text-xs px-2.5 py-1 rounded-full font-medium">PENDING</span>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead class="bg-[hsl(var(--secondary)/0.3)] border-b border-[hsl(var(--border)/0.3)]">
                  <tr>
                    <th class="text-left px-6 py-3 font-medium text-[hsl(var(--muted-foreground))]">Felhasználó</th>
                    <th class="text-left px-6 py-3 font-medium text-[hsl(var(--muted-foreground))]">Összeg</th>
                    <th class="text-left px-6 py-3 font-medium text-[hsl(var(--muted-foreground))]">Tárhely</th>
                    <th class="text-left px-6 py-3 font-medium text-[hsl(var(--muted-foreground))]">Státusz</th>
                    <th class="text-left px-6 py-3 font-medium text-[hsl(var(--muted-foreground))]">Dátum</th>
                    <th class="text-right px-6 py-3 font-medium text-[hsl(var(--muted-foreground))]">Műveletek</th>
                  </tr>
                </thead>
                <tbody id="paymentList" class="divide-y divide-[hsl(var(--border)/0.2)]">
                  <tr><td colspan="6" class="px-6 py-8 text-center text-[hsl(var(--muted-foreground))]">Betöltés...</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="glass-card-elevated overflow-hidden">
            <div class="px-6 py-4 border-b border-[hsl(var(--border)/0.3)] bg-[hsl(var(--secondary)/0.3)]">
              <h2 class="text-lg font-semibold">Felhasználók</h2>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead class="bg-[hsl(var(--secondary)/0.3)] border-b border-[hsl(var(--border)/0.3)]">
                  <tr>
                    <th class="text-left px-6 py-3 font-medium text-[hsl(var(--muted-foreground))]">Email</th>
                    <th class="text-left px-6 py-3 font-medium text-[hsl(var(--muted-foreground))]">Tárhely</th>
                    <th class="text-left px-6 py-3 font-medium text-[hsl(var(--muted-foreground))]">Státusz</th>
                    <th class="text-left px-6 py-3 font-medium text-[hsl(var(--muted-foreground))]">Regisztráció</th>
                    <th class="text-right px-6 py-3 font-medium text-[hsl(var(--muted-foreground))]">Műveletek</th>
                  </tr>
                </thead>
                <tbody id="userList" class="divide-y divide-[hsl(var(--border)/0.2)]">
                  <tr><td colspan="5" class="px-6 py-8 text-center text-[hsl(var(--muted-foreground))]">Betöltés...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
      ${this.renderFooter()}`;
  },

  renderAdminUserFiles() {
    return `
      ${this.renderNav()}
      <main class="pt-24 pb-12 px-4">
        <div class="max-w-6xl mx-auto animate-slide-up">
          <div class="flex items-center justify-between mb-8">
            <div>
              <h1 class="text-3xl font-bold text-gradient">Felhasználó Fájljai</h1>
              <p class="text-[hsl(var(--muted-foreground))] mt-1 font-mono text-sm bg-[hsl(var(--secondary))] inline-block px-2 py-1 rounded">/${this.currentPrefix}</p>
            </div>
            <button onclick="App.closeUserFiles()" class="btn-secondary flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
              Bezárás
            </button>
          </div>

          <div class="glass-card-elevated overflow-hidden">
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead class="bg-[hsl(var(--secondary)/0.3)] border-b border-[hsl(var(--border)/0.3)]">
                  <tr>
                    <th class="text-left px-6 py-4 font-medium text-[hsl(var(--muted-foreground))]">Név</th>
                    <th class="text-left px-6 py-4 font-medium text-[hsl(var(--muted-foreground))]">Méret</th>
                    <th class="text-left px-6 py-4 font-medium text-[hsl(var(--muted-foreground))]">Módosítva</th>
                    <th class="text-right px-6 py-4 font-medium text-[hsl(var(--muted-foreground))]">Műveletek</th>
                  </tr>
                </thead>
                <tbody id="adminUserFileList" class="divide-y divide-[hsl(var(--border)/0.2)]">
                  <tr><td colspan="4" class="px-6 py-8 text-center text-[hsl(var(--muted-foreground))]">Betöltés...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
      ${this.renderFooter()}`;
  },

  renderFooter() {
    return `
      <footer class="border-t border-[hsl(var(--border)/0.3)] py-8 px-4 mt-auto">
        <div class="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div class="flex items-center gap-3">
            <div class="w-7 h-7 rounded bg-gradient-to-br from-white to-gray-400 flex items-center justify-center">
              <svg class="w-4 h-4 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" /></svg>
            </div>
            <span class="font-semibold">Wixity Cloud S3</span>
          </div>
          <p class="text-sm text-[hsl(var(--muted-foreground))]">
            © 2024 Wixity Cloud. Minden jog fenntartva.
          </p>
        </div>
      </footer>
    `;
  },

  bindEvents() {
    document.getElementById('loginForm')?.addEventListener('submit', (e) => this.handleLogin(e));
    document.getElementById('registerForm')?.addEventListener('submit', (e) => this.handleRegister(e));
    document.getElementById('passwordForm')?.addEventListener('submit', (e) => this.handlePasswordChange(e));
    document.getElementById('fileUpload')?.addEventListener('change', (e) => this.handleFileUpload(e));

    const slider = document.getElementById('storageSlider');
    if (slider) {
      slider.addEventListener('input', (e) => {
        const gb = e.target.value;
        document.getElementById('storageAmount').textContent = `${gb} GB`;
        document.getElementById('storagePrice').textContent = `${gb * 5} Ft`;
      });
      this.initPayPal();
    }
  },

  async handleLogin(e) {
    e.preventDefault();
    const form = e.target;
    const email = form.email.value;
    const password = form.password.value;

    try {
      const data = await this.api('/api/auth/login', { method: 'POST', body: { email, password } });
      this.user = data.user;
      this.currentPage = data.user.is_admin ? 'admin' : 'dashboard';
      await this.checkAuth();
      this.render();
    } catch (err) {
      document.getElementById('loginError').textContent = err.message;
      document.getElementById('loginError').classList.remove('hidden');
    }
  },

  async handleRegister(e) {
    e.preventDefault();
    const form = e.target;
    const email = form.email.value;
    const password = form.password.value;

    try {
      await this.api('/api/auth/register', { method: 'POST', body: { email, password } });
      await this.checkAuth();
      this.currentPage = 'dashboard';
      this.render();
    } catch (err) {
      document.getElementById('registerError').textContent = err.message;
      document.getElementById('registerError').classList.remove('hidden');
    }
  },

  async handlePasswordChange(e) {
    e.preventDefault();
    const form = e.target;

    try {
      await this.api('/api/auth/change-password', {
        method: 'POST',
        body: {
          currentPassword: form.currentPassword.value,
          newPassword: form.newPassword.value
        }
      });
      document.getElementById('passwordSuccess').textContent = 'Jelszó sikeresen módosítva!';
      document.getElementById('passwordSuccess').classList.remove('hidden');
      document.getElementById('passwordError').classList.add('hidden');
      form.reset();
    } catch (err) {
      document.getElementById('passwordError').textContent = err.message;
      document.getElementById('passwordError').classList.remove('hidden');
      document.getElementById('passwordSuccess').classList.add('hidden');
    }
  },

  async logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    this.user = null;
    this.currentPage = 'login';
    this.render();
  },

  goTo(page) {
    this.currentPage = page;
    this.render();
  },

  async loadDashboardData() {
    try {
      // Force refresh credentials and storage
      await Promise.all([
        this.api('/api/user/credentials').then(creds => {
          this.user.access_key = creds.access_key;
          this.user.secret_key = creds.secret_key;
        }),
        this.loadStorageData()
      ]);

      const credsHtml = `
  < div >
          <span class="text-[hsl(var(--muted-foreground))] text-xs uppercase tracking-wider block mb-1">S3 Endpoint</span>
          <code class="block w-full bg-[hsl(var(--background))] border border-[hsl(var(--border))] px-3 py-2 rounded-lg text-white font-mono text-sm">${window.location.origin}/s3</code>
        </div >
        <div>
          <span class="text-[hsl(var(--muted-foreground))] text-xs uppercase tracking-wider block mb-1">Bucket</span>
          <code class="block w-full bg-[hsl(var(--background))] border border-[hsl(var(--border))] px-3 py-2 rounded-lg text-white font-mono text-sm">files</code>
        </div>
        <div>
          <span class="text-[hsl(var(--muted-foreground))] text-xs uppercase tracking-wider block mb-1">Access Key</span>
          <div class="flex gap-2">
            <code class="flex-1 bg-[hsl(var(--background))] border border-[hsl(var(--border))] px-3 py-2 rounded-lg text-white font-mono text-sm">${this.user.access_key}</code>
            <button onclick="App.copyToClipboard('${this.user.access_key}')" class="copy-btn" title="Másolás">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            </button>
          </div>
        </div>
        <div>
          <span class="text-[hsl(var(--muted-foreground))] text-xs uppercase tracking-wider block mb-1">Secret Key</span>
          <div class="flex gap-2">
            <code id="secretKeyDisplay" class="flex-1 bg-[hsl(var(--background))] border border-[hsl(var(--border))] px-3 py-2 rounded-lg text-[hsl(var(--muted-foreground))] font-mono text-sm filter blur-sm transition duration-300 hover:blur-none select-all">${this.user.secret_key}</code>
            <button onclick="App.copyToClipboard('${this.user.secret_key}')" class="copy-btn" title="Másolás">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            </button>
          </div>
        </div>
`;
      document.getElementById('apiCredentials').innerHTML = credsHtml;

      // Init range slider
      const slider = document.getElementById('storageSlider');
      if (slider) {
        // Set limits from loaded exchange rates if available
        if (this.exchangeRates?.limits) {
          slider.min = this.exchangeRates.limits.min_gb;
          slider.max = this.exchangeRates.limits.max_gb;
        }

        slider.addEventListener('input', (e) => {
          this.updatePrice(e.target.value);
        });
        this.updatePrice(slider.value);
      }

      this.bindPaypalButton();
    } catch (e) {
      console.error('Failed to load dashboard data:', e);
    }
  },

  async loadStorageData() {
    try {
      const data = await this.api('/api/user/storage');
      this.storageData = data;
      this.renderStorageWidget();
    } catch (e) {
      console.error('Failed to load storage:', e);
    }
  },

  renderStorageWidget() {
    const container = document.getElementById('storageWidget');
    if (!container) return;

    const used = this.storageData?.storage_used_mb || 0;
    const limit = this.storageData?.storage_limit_mb || 0;
    const percent = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
    const exceeded = used >= limit && limit > 0;

    // Check view mode (Graph vs Bar)
    if (this.storageViewMode === 'pie') {
      container.innerHTML = `
  < div class="flex items-center gap-8 justify-center h-full animate-fade-in" >
          <div class="pie-chart ${exceeded ? 'pie-chart-warning' : ''}" style="--percent: ${percent}%">
            <div class="pie-chart-hole">
              <span class="text-xl font-bold">${percent.toFixed(0)}%</span>
            </div>
          </div>
          <div>
            <div class="mb-2">
              <p class="text-sm text-[hsl(var(--muted-foreground))]">Foglalt</p>
              <p class="font-semibold text-[hsl(var(--foreground))] text-lg">${(used / 1024).toFixed(2)} GB</p>
            </div>
            <div>
              <p class="text-sm text-[hsl(var(--muted-foreground))]">Összesen</p>
              <p class="font-semibold text-[hsl(var(--foreground))] text-lg">${(limit / 1024).toFixed(2)} GB</p>
            </div>
          </div>
        </div >
  `;
    } else {
      container.innerHTML = `
  < div class="mb-4 animate-fade-in" >
          <div class="flex justify-between text-sm mb-2">
            <span class="text-[hsl(var(--foreground))]">${(used / 1024).toFixed(2)} GB használva</span>
            <span class="text-[hsl(var(--muted-foreground))]">${(limit / 1024).toFixed(2)} GB limit</span>
          </div>
          <div class="storage-bar">
            <div class="storage-bar-fill ${exceeded ? 'storage-bar-warning' : ''}" style="width: ${percent}%"></div>
          </div>
        </div >
  <p class="text-[hsl(var(--muted-foreground))] text-sm text-center bg-[hsl(var(--secondary))] py-2 rounded-lg">${percent.toFixed(1)}% felhasználva</p>
`;
    }
  },

  toggleStorageView() {
    this.storageViewMode = this.storageViewMode === 'bar' ? 'pie' : 'bar';
    this.renderStorageWidget();
  },

  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast('Másolva a vágólapra!', 'success');
    } catch (err) {
      this.showToast('Sikertelen másolás', 'error');
    }
  },

  updatePrice(gb) {
    document.getElementById('storageAmount').textContent = `${gb} GB`;
    const currency = this.selectedCurrency || 'HUF';

    let price = 0;
    if (this.exchangeRates?.prices) {
      price = (this.exchangeRates.prices[`PRICE_PER_GB_${currency} `] || 0) * gb;
      // Fallback if key missing but exchange rate exists
      if (price === 0 && currency !== 'HUF') {
        const baseHuf = (this.exchangeRates.prices.PRICE_PER_GB_HUF || 5) * gb;
        const rate = this.exchangeRates.rates[currency];
        if (rate) price = baseHuf * rate;
      }
    } else {
      price = 5 * gb; // Ultimate fallback
    }

    // Configured prices in server.js are exact for each currency, so we use them directly
    if (this.exchangeRates?.prices) {
      if (currency === 'HUF') price = (this.exchangeRates.prices.PRICE_PER_GB_HUF || 5) * gb;
      else if (currency === 'EUR') price = (this.exchangeRates.prices.PRICE_PER_GB_EUR || 0.013) * gb;
      else if (currency === 'USD') price = (this.exchangeRates.prices.PRICE_PER_GB_USD || 0.014) * gb;
    }

    // Format price
    let formattedPrice = '';
    if (currency === 'HUF') formattedPrice = `${Math.ceil(price)} Ft`;
    else if (currency === 'EUR') formattedPrice = `€${price.toFixed(2)} `;
    else if (currency === 'USD') formattedPrice = `$${price.toFixed(2)} `;

    const priceEl = document.getElementById('storagePrice');
    if (priceEl) priceEl.textContent = formattedPrice;
  },

  changeCurrency(currency) {
    this.selectedCurrency = currency;
    const slider = document.getElementById('storageSlider');
    if (slider) this.updatePrice(slider.value);

    // Update active state of buttons
    ['HUF', 'EUR', 'USD'].forEach(c => {
      const btn = document.getElementById(`curr - btn - ${c} `);
      if (btn) {
        if (c === currency) {
          btn.classList.add('bg-[hsl(var(--primary))]', 'text-[hsl(var(--primary-foreground))]');
          btn.classList.remove('bg-[hsl(var(--background))]', 'text-[hsl(var(--muted-foreground))]');
        } else {
          btn.classList.remove('bg-[hsl(var(--primary))]', 'text-[hsl(var(--primary-foreground))]');
          btn.classList.add('bg-[hsl(var(--background))]', 'text-[hsl(var(--muted-foreground))]');
        }
      }
    });
  },

  bindPaypalButton() {
    const btn = document.getElementById('paypalPayBtn');
    if (!btn) return;

    // Remove old listeners by cloning
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('click', async () => {
      const slider = document.getElementById('storageSlider');
      if (!slider) return;

      const gb = parseInt(slider.value);
      try {
        const res = await this.api('/api/payment/create', { method: 'POST', body: { storage_gb: gb } });
        window.location.href = res.paypal_url;
      } catch (err) {
        this.showToast('Hiba történt: ' + err.message, 'error');
      }
    });
  },

  async loadFiles() {
    try {
      const data = await this.api(`/ api / files / list ? prefix = ${encodeURIComponent(this.currentPrefix)} `);
      this.files = [...data.folders, ...data.files];
      this.renderFileList();
    } catch (err) {
      console.error(err);
    }
  },

  renderFileList() {
    const tbody = document.getElementById('fileList');
    if (!tbody) return;

    if (this.files.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="px-6 py-8 text-center text-gray-400">Üres mappa</td></tr>';
      return;
    }

    tbody.innerHTML = this.files.map(f => `
  < tr class="border-t border-gray-800 hover:bg-gray-800/30" >
        <td class="px-6 py-4">
          <div class="flex items-center gap-3">
            <span class="text-xl">${f.type === 'folder' ? '📁' : '📄'}</span>
            ${f.type === 'folder'
        ? `<button onclick="App.navigateTo('${f.key}')" class="hover:text-indigo-400">${f.name}</button>`
        : `<span>${f.name}</span>`
      }
          </div>
        </td>
        <td class="px-6 py-4 text-gray-400">${f.size ? this.formatBytes(f.size) : '-'}</td>
        <td class="px-6 py-4 text-gray-400">${f.last_modified ? new Date(f.last_modified).toLocaleString('hu') : '-'}</td>
        <td class="px-6 py-4 text-right">
          ${f.type === 'file' ? `
            <button onclick="App.downloadFile('${f.key}')" class="text-indigo-400 hover:text-indigo-300 mr-3">Letöltés</button>
          ` : ''}
          <button onclick="App.deleteFile('${f.key}', '${f.type}')" class="text-red-400 hover:text-red-300">Törlés</button>
        </td>
      </tr >
  `).join('');
  },

  navigateTo(prefix) {
    this.currentPrefix = prefix;
    this.loadFiles();
  },

  navigateUp() {
    const parts = this.currentPrefix.split('/').filter(Boolean);
    parts.pop();
    this.currentPrefix = parts.length ? parts.join('/') + '/' : '';
    this.loadFiles();
  },

  async handleFileUpload(e) {
    const files = e.target.files;
    if (!files.length) return;

    for (const file of files) {
      // Pre-check file size
      try {
        const checkRes = await fetch('/api/files/check-size', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_size_bytes: file.size, file_name: file.name })
        });
        const checkData = await checkRes.json();

        if (!checkData.allowed) {
          this.showToast(`Nincs elég tárhely: ${file.name} (${(checkData.file_size_mb).toFixed(2)} MB)`, 'error');
          continue;
        }
      } catch (err) {
        console.error('Size check failed:', err);
      }

      // Show progress
      this.showUploadProgress(file.name);

      const formData = new FormData();
      formData.append('file', file);
      formData.append('prefix', this.currentPrefix);

      try {
        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            this.updateUploadProgress(percent);
          }
        });

        await new Promise((resolve, reject) => {
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              this.updateUploadProgress(100);
              resolve();
            } else {
              const data = JSON.parse(xhr.responseText);
              if (data.malicious) {
                this.showToast('Kártékony fájl észlelve! Fiók felfüggesztve.', 'error');
                setTimeout(() => location.reload(), 2000);
              }
              reject(new Error(data.error || 'Upload failed'));
            }
          };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.open('POST', '/api/files/upload');
          xhr.send(formData);
        });

        this.showToast('Sikeres feltöltés', 'success');
      } catch (err) {
        this.updateUploadProgress(100, true);
        this.showToast(`Hiba: ${err.message} `, 'error');
      }

      this.hideUploadProgress();
    }
    this.loadFiles();
    e.target.value = '';
  },

  downloadFile(key) {
    window.open(`/ api / files / download ? path = ${encodeURIComponent(key)} `, '_blank');
  },

  async deleteFile(key, type) {
    const confirmed = await this.confirmModal('Törlés megerősítése', `Biztosan törlöd: ${key}?`);
    if (!confirmed) return;
    try {
      await this.api(`/ api / files / delete? path = ${encodeURIComponent(key)} `, { method: 'DELETE' });
      this.loadFiles();
      this.showToast('Sikeresen törölve', 'success');
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async createFolder() {
    const name = await this.promptModal('Új mappa', 'Mappa neve:');
    if (!name) return;
    try {
      await this.api('/api/files/create-folder', { method: 'POST', body: { prefix: this.currentPrefix, name } });
      this.loadFiles();
      this.showToast('Mappa létrehozva', 'success');
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async loadAdminData() {
    try {
      const [stats, users, payments] = await Promise.all([
        this.api('/api/admin/stats'),
        this.api('/api/admin/users'),
        this.api('/api/admin/payments')
      ]);

      const statsHtml = [
        { label: 'Felhasználók', value: stats.total_users, color: 'text-indigo-400' },
        { label: 'Felfüggesztett', value: stats.suspended_users, color: 'text-yellow-400' },
        { label: 'Bevétel (Ft)', value: stats.total_revenue_huf, color: 'text-green-400' },
        { label: 'Tárhely (GB)', value: `${stats.used_storage_gb}/${stats.total_storage_gb}`, color: 'text-purple-400' }
      ].map(stat => `
        <div class="glass rounded-xl p-6 flex flex-col items-center justify-center hover:bg-white/5 transition duration-300">
          <div class="text-3xl font-bold ${stat.color} mb-2">${stat.value}</div>
          <div class="text-gray-400 text-sm font-medium uppercase tracking-wide">${stat.label}</div>
        </div>
      `).join('');

      document.getElementById('adminStats').innerHTML = statsHtml;

      // Render payments
      document.getElementById('paymentList').innerHTML = payments.length > 0 ? payments.map(p => `
        <tr class="hover:bg-white/5 transition">
          <td class="px-6 py-4 text-sm font-medium text-white">${p.user_email}</td>
          <td class="px-6 py-4 text-sm text-gray-300">${p.amount_huf} Ft</td>
          <td class="px-6 py-4 text-sm text-gray-300">${(p.storage_mb / 1024).toFixed(1)} GB</td>
          <td class="px-6 py-4">
            ${p.status === 'completed'
          ? '<span class="bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-1 rounded text-xs font-mono">JÓVÁÍRVA</span>'
          : p.status === 'pending'
            ? '<span class="bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 px-2 py-1 rounded text-xs font-mono">FÜGGŐBEN</span>'
            : '<span class="bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-1 rounded text-xs font-mono">MEGSZAKÍTVA</span>'
        }
          </td>
          <td class="px-6 py-4 text-sm text-gray-400 text-xs font-mono">${new Date(p.created_at).toLocaleString('hu')}</td>
          <td class="px-6 py-4 text-right">
            ${p.status === 'pending'
          ? `<button onclick="App.approvePayment('${p.id}')" class="text-green-400 hover:text-green-300 transition text-sm font-medium">Jóváírás</button>`
          : '-'
        }
          </td>
        </tr>
      `).join('') : '<tr><td colspan="6" class="px-6 py-8 text-center text-gray-400">Nincs fizetés</td></tr>';

      document.getElementById('userList').innerHTML = users.filter(u => !u.is_admin).map(u => `
        <tr class="hover:bg-white/5 transition">
          <td class="px-6 py-4 text-sm font-medium text-white">${u.email}</td>
          <td class="px-6 py-4">
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2">
                <div class="w-24 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div class="h-full bg-indigo-500" style="width: ${Math.min((u.storage_used_mb / u.storage_limit_mb) * 100, 100)}%"></div>
                </div>
                <span class="text-xs text-gray-400">${(u.storage_used_mb / 1024).toFixed(2)}/${(u.storage_limit_mb / 1024).toFixed(2)} GB</span>
              </div>
              <button onclick="App.editUserStorage('${u.id}', ${u.storage_limit_mb})" class="text-xs text-indigo-400 hover:text-indigo-300 text-left">Módosítás ✏️</button>
            </div>
          </td>
          <td class="px-6 py-4">
            ${u.is_suspended
          ? '<span class="bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-1 rounded text-xs font-mono">FELFÜGGESZTVE</span>'
          : '<span class="bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-1 rounded text-xs font-mono">AKTÍV</span>'
        }
          </td>
          <td class="px-6 py-4 text-sm text-gray-400 text-xs font-mono">${new Date(u.created_at).toLocaleDateString('hu')}</td>
          <td class="px-6 py-4 text-right flex items-center justify-end gap-3">
             <button onclick="App.viewUserFiles('${u.id}')" class="p-2 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 rounded-lg transition" title="Fájlok">
              📁
            </button>
            ${u.is_suspended
          ? `<button onclick="App.unsuspendUser('${u.id}')" class="p-2 bg-green-500/10 hover:bg-green-500/20 text-green-400 rounded-lg transition" title="Feloldás">🔓</button>`
          : `<button onclick="App.suspendUser('${u.id}')" class="p-2 bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 rounded-lg transition" title="Felfüggesztés">⛔</button>`
        }
            <button onclick="App.deleteUser('${u.id}')" class="p-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg transition" title="Törlés">🗑️</button>
          </td>
        </tr>
      `).join('') || '<tr><td colspan="5" class="px-6 py-8 text-center text-gray-400">Nincs felhasználó</td></tr>';
    } catch (err) {
      console.error(err);
      this.showToast('Hiba az adatok betöltésekor', 'error');
    }
  },



  async viewUserFiles(userId) {
    this.adminCurrentUserId = userId;
    this.currentPrefix = '';
    this.currentPage = 'admin_files';
    this.render();
  },

  closeUserFiles() {
    this.currentPage = 'admin';
    this.adminCurrentUserId = null;
    this.currentPrefix = '';
    this.render();
  },

  async loadAdminUserFiles() {
    try {
      const data = await this.api(`/api/admin/user/${this.adminCurrentUserId}/files?prefix=${encodeURIComponent(this.currentPrefix)}`);

      const files = [...data.folders, ...data.files];
      const tbody = document.getElementById('adminUserFileList');
      if (!tbody) return;

      if (files.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="px-6 py-12 text-center text-[hsl(var(--muted-foreground))] italic">Ez a mappa üres</td></tr>';
        return;
      }

      tbody.innerHTML = files.map(f => `
        <tr class="hover:bg-white/5 transition group">
          <td class="px-6 py-4">
            <div class="flex items-center gap-3">
              <span class="text-2xl opacity-70 group-hover:opacity-100 transition">${f.type === 'folder' ? '📁' : '📄'}</span>
              ${f.type === 'folder'
          ? `<button onclick="App.navigateTo('${f.key}')" class="font-medium text-[hsl(var(--foreground))] hover:text-[hsl(var(--primary))] hover:underline transition">${f.name}</button>`
          : `<span class="text-[hsl(var(--foreground))] font-medium">${f.name}</span>`
        }
            </div>
          </td>
          <td class="px-6 py-4 text-sm text-[hsl(var(--muted-foreground))] font-mono text-xs">${f.size ? this.formatBytes(f.size) : '-'}</td>
          <td class="px-6 py-4 text-sm text-[hsl(var(--muted-foreground))] font-mono text-xs">${f.last_modified ? new Date(f.last_modified).toLocaleString('hu') : '-'}</td>
          <td class="px-6 py-4 text-right">
            ${f.type === 'file' ? `
              <button onclick="App.downloadAdminFile('${f.key}')" class="text-[hsl(var(--primary))] hover:text-[hsl(var(--primary-foreground))] transition text-xs font-medium bg-[hsl(var(--primary)/0.1)] px-3 py-1.5 rounded-lg border border-[hsl(var(--primary)/0.2)] hover:bg-[hsl(var(--primary))]">⬇️ Letöltés</button>
            ` : ''}
          </td>
        </tr>
      `).join('');
    } catch (err) {
      console.error(err);
      this.showToast('Hiba a fájlok listázásakor', 'error');
    }
  },

  downloadAdminFile(key) {
    window.open(`/api/admin/user/${this.adminCurrentUserId}/files/download?path=${encodeURIComponent(key)}`, '_blank');
  },

  async editUserStorage(id, currentMb) {
    const currentGb = (currentMb / 1024).toFixed(2);
    const newGb = await this.promptModal('Tárhely módosítása', `Új limit (GB):\n(Jelenlegi: ${currentGb} GB)`, currentGb);

    if (newGb === null) return;
    const newMb = parseFloat(newGb) * 1024;

    if (isNaN(newMb) || newMb < 0) {
      this.showToast('Érvénytelen szám!', 'error');
      return;
    }

    try {
      await this.api(`/api/admin/user/${id}/update-storage`, { method: 'POST', body: { storage_limit_mb: newMb } });
      this.showToast('Tárhely frissítve!', 'success');
      this.loadAdminData();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  suspendUser(id) {
    this.showModal({
      title: 'Felhasználó felfüggesztése',
      content: `
        <div class="space-y-4">
          <div>
            <label class="block text-sm text-[hsl(var(--muted-foreground))] mb-2">Indoklás</label>
            <input type="text" id="suspendReason" class="input" placeholder="pl. Kártékony tartalom">
          </div>
          <div>
            <label class="block text-sm text-[hsl(var(--muted-foreground))] mb-2">Időtartam (óra)</label>
            <input type="number" id="suspendDuration" class="input" placeholder="24 (vagy hagyd üresen ha végleges)">
          </div>
        </div>
      `,
      buttons: [
        { text: 'Mégse', action: 'cancel', class: 'btn-ghost' },
        {
          text: 'Felfüggesztés',
          action: 'confirm',
          class: 'btn-destructive',
          onClick: async () => {
            const reason = document.getElementById('suspendReason').value;
            const duration = document.getElementById('suspendDuration').value;

            try {
              await this.api(`/api/admin/user/${id}/suspend`, {
                method: 'POST',
                body: { reason, duration_hours: duration ? parseInt(duration) : null }
              });
              this.showToast('Felhasználó felfüggesztve', 'success');
              this.loadAdminData();
              return true; // Closes modal
            } catch (err) {
              this.showToast(err.message, 'error');
              return false; // Keeps modal open on error
            }
          }
        }
      ]
    });
  },

  async unsuspendUser(id) {
    try {
      await this.api(`/api/admin/user/${id}/unsuspend`, { method: 'POST' });
      this.showToast('Felfüggesztés feloldva', 'success');
      this.loadAdminData();
    } catch (err) { this.showToast(err.message, 'error'); }
  },

  async deleteUser(id) {
    const confirmed = await this.confirmModal('Felhasználó törlése', 'FIGYELEM! Ez törli a felhasználót és MINDEN fájlját! Ez a művelet nem visszavonható. Folytatod?');
    if (!confirmed) return;

    try {
      await this.api(`/api/admin/user/${id}`, { method: 'DELETE' });
      this.showToast('Felhasználó törölve', 'success');
      this.loadAdminData();
    } catch (err) { this.showToast(err.message, 'error'); }
  },

  async approvePayment(id) {
    const confirmed = await this.confirmModal('Fizetés jóváírása', 'Biztosan jóváírod ezt a fizetést? A tárhely azonnal hozzáadásra kerül.');
    if (!confirmed) return;

    try {
      await this.api(`/api/admin/payment/${id}/approve`, { method: 'POST' });
      this.showToast('Fizetés jóváírva!', 'success');
      this.loadAdminData();
    } catch (err) {
      this.showToast('Hiba: ' + err.message, 'error');
    }
  },

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    // Trigger reflow
    toast.offsetHeight;

    toast.classList.add('show');

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => container.removeChild(toast), 300);
    }, 3000);
  }
};

App.init();

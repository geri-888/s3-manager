import './style.css';

// ===== API Configuration =====
const API_BASE = 'http://localhost:3333/api';

// ===== State =====
let sessionId = null;
let currentBucket = null;
let currentPrefix = '';
let credentials = {
    endpoint: '',
    accessKeyId: '',
    secretAccessKey: ''
};

// ===== API Helper =====
async function apiCall(method, path, body = null, headers = {}) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...headers
        }
    };

    if (sessionId) {
        options.headers['x-session-id'] = sessionId;
    }

    if (body && !(body instanceof ArrayBuffer)) {
        options.body = JSON.stringify(body);
    } else if (body) {
        options.body = body;
        delete options.headers['Content-Type'];
    }

    const response = await fetch(`${API_BASE}${path}`, options);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'API error');
    }

    return data;
}

// ===== DOM Elements =====
const loginScreen = document.getElementById('login-screen');
const mainScreen = document.getElementById('main-screen');
const loginForm = document.getElementById('login-form');
const endpointInput = document.getElementById('endpoint');
const accessKeyInput = document.getElementById('access-key');
const secretKeyInput = document.getElementById('secret-key');
const rememberCheckbox = document.getElementById('remember-credentials');
const toggleSecretBtn = document.getElementById('toggle-secret');
const connectBtn = document.getElementById('connect-btn');
const loginError = document.getElementById('login-error');
const connectionInfo = document.getElementById('connection-info');
const bucketList = document.getElementById('bucket-list');
const fileList = document.getElementById('file-list');
const breadcrumb = document.getElementById('breadcrumb');
const emptyState = document.getElementById('empty-state');
const uploadBtn = document.getElementById('upload-btn');
const createFolderBtn = document.getElementById('create-folder-btn');
const createBucketBtn = document.getElementById('create-bucket-btn');
const refreshBtn = document.getElementById('refresh-btn');
const logoutBtn = document.getElementById('logout-btn');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const uploadProgress = document.getElementById('upload-progress');
const uploadProgressList = document.getElementById('upload-progress-list');
const closeProgressBtn = document.getElementById('close-progress');
const modalOverlay = document.getElementById('modal-overlay');
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');
const modalClose = document.getElementById('modal-close');
const toastContainer = document.getElementById('toast-container');

// ===== Initialization =====
function init() {
    loadSavedCredentials();
    setupEventListeners();
}

function loadSavedCredentials() {
    const saved = localStorage.getItem('s3-credentials');
    if (saved) {
        try {
            const creds = JSON.parse(saved);
            endpointInput.value = creds.endpoint || '';
            accessKeyInput.value = creds.accessKeyId || '';
            secretKeyInput.value = creds.secretAccessKey || '';
            rememberCheckbox.checked = true;
        } catch (e) {
            console.error('Failed to load saved credentials:', e);
        }
    }
}

function setupEventListeners() {
    // Login form
    loginForm.addEventListener('submit', handleLogin);
    toggleSecretBtn.addEventListener('click', () => {
        const type = secretKeyInput.type === 'password' ? 'text' : 'password';
        secretKeyInput.type = type;
        toggleSecretBtn.textContent = type === 'password' ? '👁️' : '🙈';
    });

    // Main screen actions
    refreshBtn.addEventListener('click', handleRefresh);
    logoutBtn.addEventListener('click', handleLogout);
    uploadBtn.addEventListener('click', () => fileInput.click());
    createFolderBtn.addEventListener('click', handleCreateFolder);
    createBucketBtn.addEventListener('click', handleCreateBucket);
    closeProgressBtn.addEventListener('click', () => {
        uploadProgress.style.display = 'none';
    });

    // File input
    fileInput.addEventListener('change', handleFileSelect);

    // Drag and drop
    const content = document.querySelector('.content');
    content.addEventListener('dragover', handleDragOver);
    content.addEventListener('dragleave', handleDragLeave);
    content.addEventListener('drop', handleDrop);

    // Modal
    modalCancel.addEventListener('click', hideModal);
    modalClose.addEventListener('click', hideModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) hideModal();
    });
}

// ===== Authentication =====
async function handleLogin(e) {
    e.preventDefault();

    const endpoint = endpointInput.value.trim();
    const accessKeyId = accessKeyInput.value.trim();
    const secretAccessKey = secretKeyInput.value.trim();

    if (!endpoint || !accessKeyId || !secretAccessKey) {
        showLoginError('Kérlek töltsd ki az összes mezőt!');
        return;
    }

    setLoading(true);
    hideLoginError();

    try {
        const response = await apiCall('POST', '/connect', {
            endpoint,
            accessKeyId,
            secretAccessKey
        });

        sessionId = response.sessionId;

        // Save credentials if requested
        credentials = { endpoint, accessKeyId, secretAccessKey };
        if (rememberCheckbox.checked) {
            localStorage.setItem('s3-credentials', JSON.stringify(credentials));
        } else {
            localStorage.removeItem('s3-credentials');
        }

        // Switch to main screen
        showMainScreen();
        await loadBuckets();

    } catch (error) {
        console.error('Connection failed:', error);
        showLoginError(`Sikertelen csatlakozás: ${error.message || 'Ismeretlen hiba'}`);
    } finally {
        setLoading(false);
    }
}

async function handleLogout() {
    try {
        await apiCall('POST', '/disconnect');
    } catch (e) {
        // Ignore errors
    }
    sessionId = null;
    currentBucket = null;
    currentPrefix = '';
    loginScreen.classList.add('active');
    mainScreen.classList.remove('active');
    showToast('Sikeresen kijelentkeztél', 'success');
}

function setLoading(loading) {
    connectBtn.disabled = loading;
    const btnText = connectBtn.querySelector('.btn-text');
    const btnLoader = connectBtn.querySelector('.btn-loader');
    btnText.style.display = loading ? 'none' : 'inline';
    btnLoader.style.display = loading ? 'inline-flex' : 'none';
}

function showLoginError(message) {
    loginError.textContent = message;
    loginError.style.display = 'block';
}

function hideLoginError() {
    loginError.style.display = 'none';
}

function showMainScreen() {
    loginScreen.classList.remove('active');
    mainScreen.classList.add('active');
    connectionInfo.textContent = credentials.endpoint;
}

// ===== Buckets =====
async function loadBuckets() {
    bucketList.innerHTML = `
    <div class="loading-buckets">
      <div class="loading-item"></div>
      <div class="loading-item"></div>
      <div class="loading-item"></div>
    </div>
  `;

    try {
        const response = await apiCall('GET', '/buckets');
        const buckets = response.buckets || [];

        if (buckets.length === 0) {
            bucketList.innerHTML = `
        <div class="empty-state" style="padding: 20px;">
          <p style="font-size: 13px; color: var(--text-muted);">Nincsenek bucket-ek</p>
        </div>
      `;
            return;
        }

        bucketList.innerHTML = buckets.map(bucket => `
      <div class="bucket-item" data-bucket="${bucket.Name}">
        <span class="bucket-icon">🪣</span>
        <span class="bucket-name">${bucket.Name}</span>
        <button class="btn-icon btn-small bucket-delete" title="Törlés" onclick="event.stopPropagation();">🗑️</button>
      </div>
    `).join('');

        // Add click handlers
        bucketList.querySelectorAll('.bucket-item').forEach(item => {
            item.addEventListener('click', () => selectBucket(item.dataset.bucket));
            item.querySelector('.bucket-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                handleDeleteBucket(item.dataset.bucket);
            });
        });

    } catch (error) {
        console.error('Failed to load buckets:', error);
        bucketList.innerHTML = `
      <div class="empty-state" style="padding: 20px;">
        <p style="font-size: 13px; color: var(--accent-danger);">Hiba: ${error.message}</p>
      </div>
    `;
    }
}

async function selectBucket(bucketName) {
    currentBucket = bucketName;
    currentPrefix = '';

    // Update UI
    bucketList.querySelectorAll('.bucket-item').forEach(item => {
        item.classList.toggle('active', item.dataset.bucket === bucketName);
    });

    uploadBtn.disabled = false;
    createFolderBtn.disabled = false;

    await loadFiles();
}

async function handleCreateBucket() {
    showModal('Új bucket létrehozása', `
    <div class="form-group">
      <label for="bucket-name">
        <span class="icon">🪣</span>
        Bucket neve
      </label>
      <input type="text" id="bucket-name" placeholder="my-bucket" required />
    </div>
  `, async () => {
        const name = document.getElementById('bucket-name').value.trim();
        if (!name) {
            showToast('Kérlek add meg a bucket nevét!', 'error');
            return;
        }

        try {
            await apiCall('POST', '/buckets', { name });
            hideModal();
            showToast(`Bucket "${name}" létrehozva!`, 'success');
            await loadBuckets();
        } catch (error) {
            showToast(`Hiba: ${error.message}`, 'error');
        }
    });
}

async function handleDeleteBucket(bucketName) {
    showModal('Bucket törlése', `
    <p>Biztosan törölni szeretnéd a <strong>"${bucketName}"</strong> bucket-et?</p>
    <p style="color: var(--accent-danger); margin-top: 10px; font-size: 13px;">
      ⚠️ Ez a művelet visszavonhatatlan!
    </p>
  `, async () => {
        try {
            await apiCall('DELETE', `/buckets/${encodeURIComponent(bucketName)}`);
            hideModal();
            showToast(`Bucket "${bucketName}" törölve!`, 'success');

            if (currentBucket === bucketName) {
                currentBucket = null;
                currentPrefix = '';
                fileList.innerHTML = `
          <div class="empty-state" id="empty-state">
            <div class="empty-icon">📂</div>
            <p>Válassz egy bucket-et a bal oldali listából</p>
          </div>
        `;
                uploadBtn.disabled = true;
                createFolderBtn.disabled = true;
                updateBreadcrumb();
            }

            await loadBuckets();
        } catch (error) {
            showToast(`Hiba: ${error.message}`, 'error');
        }
    }, 'btn-danger');
}

// ===== Files =====
async function loadFiles() {
    updateBreadcrumb();

    fileList.innerHTML = `
    <div class="loading-buckets" style="padding: 20px;">
      <div class="loading-item"></div>
      <div class="loading-item"></div>
      <div class="loading-item"></div>
    </div>
  `;

    try {
        const response = await apiCall('GET', `/buckets/${encodeURIComponent(currentBucket)}/objects?prefix=${encodeURIComponent(currentPrefix)}`);

        const folders = (response.folders || []).map(prefix => ({
            type: 'folder',
            name: prefix.Prefix.replace(currentPrefix, '').replace(/\/$/, ''),
            key: prefix.Prefix
        }));

        const files = (response.files || [])
            .filter(obj => obj.Key !== currentPrefix)
            .map(obj => ({
                type: 'file',
                name: obj.Key.replace(currentPrefix, ''),
                key: obj.Key,
                size: obj.Size,
                lastModified: obj.LastModified
            }));

        const items = [...folders, ...files];

        if (items.length === 0) {
            fileList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📂</div>
          <p>Ez a mappa üres</p>
          <p style="font-size: 13px; color: var(--text-muted); margin-top: 8px;">
            Húzz ide fájlokat a feltöltéshez
          </p>
        </div>
      `;
            return;
        }

        fileList.innerHTML = items.map(item => {
            if (item.type === 'folder') {
                return `
          <div class="file-item" data-type="folder" data-key="${item.key}">
            <div class="file-name">
              <span class="file-icon">📁</span>
              <span class="name">${item.name}</span>
            </div>
            <div class="file-size">—</div>
            <div class="file-date">—</div>
            <div class="file-actions">
              <button class="btn-icon" title="Törlés" data-action="delete">🗑️</button>
            </div>
          </div>
        `;
            } else {
                return `
          <div class="file-item" data-type="file" data-key="${item.key}">
            <div class="file-name">
              <span class="file-icon">${getFileIcon(item.name)}</span>
              <span class="name">${item.name}</span>
            </div>
            <div class="file-size">${formatSize(item.size)}</div>
            <div class="file-date">${formatDate(item.lastModified)}</div>
            <div class="file-actions">
              <button class="btn-icon" title="Letöltés" data-action="download">⬇️</button>
              <button class="btn-icon" title="Törlés" data-action="delete">🗑️</button>
            </div>
          </div>
        `;
            }
        }).join('');

        // Add event listeners
        fileList.querySelectorAll('.file-item').forEach(item => {
            const type = item.dataset.type;
            const key = item.dataset.key;

            if (type === 'folder') {
                item.addEventListener('dblclick', () => navigateToFolder(key));
            }

            item.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
                e.stopPropagation();
                handleDeleteFile(key, type === 'folder');
            });

            item.querySelector('[data-action="download"]')?.addEventListener('click', (e) => {
                e.stopPropagation();
                handleDownloadFile(key);
            });
        });

    } catch (error) {
        console.error('Failed to load files:', error);
        fileList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <p style="color: var(--accent-danger);">Hiba: ${error.message}</p>
      </div>
    `;
    }
}

function updateBreadcrumb() {
    const parts = currentPrefix ? currentPrefix.split('/').filter(Boolean) : [];

    let html = `<span class="breadcrumb-item ${!currentPrefix ? 'active' : ''}" data-prefix="">${currentBucket || 'Válassz bucket-et'}</span>`;

    let path = '';
    parts.forEach((part, index) => {
        path += part + '/';
        const isLast = index === parts.length - 1;
        html += `
      <span class="breadcrumb-separator">/</span>
      <span class="breadcrumb-item ${isLast ? 'active' : ''}" data-prefix="${path}">${part}</span>
    `;
    });

    breadcrumb.innerHTML = html;

    // Add click handlers
    breadcrumb.querySelectorAll('.breadcrumb-item').forEach(item => {
        item.addEventListener('click', () => {
            if (currentBucket) {
                currentPrefix = item.dataset.prefix;
                loadFiles();
            }
        });
    });
}

function navigateToFolder(prefix) {
    currentPrefix = prefix;
    loadFiles();
}

async function handleCreateFolder() {
    showModal('Új mappa létrehozása', `
    <div class="form-group">
      <label for="folder-name">
        <span class="icon">📁</span>
        Mappa neve
      </label>
      <input type="text" id="folder-name" placeholder="my-folder" required />
    </div>
  `, async () => {
        const name = document.getElementById('folder-name').value.trim();
        if (!name) {
            showToast('Kérlek add meg a mappa nevét!', 'error');
            return;
        }

        try {
            const key = currentPrefix + name + '/';
            await fetch(`${API_BASE}/buckets/${encodeURIComponent(currentBucket)}/objects`, {
                method: 'POST',
                headers: {
                    'x-session-id': sessionId,
                    'x-object-key': key,
                    'Content-Type': 'application/octet-stream'
                },
                body: new ArrayBuffer(0)
            });
            hideModal();
            showToast(`Mappa "${name}" létrehozva!`, 'success');
            await loadFiles();
        } catch (error) {
            showToast(`Hiba: ${error.message}`, 'error');
        }
    });
}

async function handleDeleteFile(key, isFolder) {
    const name = key.split('/').filter(Boolean).pop();
    const itemType = isFolder ? 'mappát' : 'fájlt';

    showModal(`${isFolder ? 'Mappa' : 'Fájl'} törlése`, `
    <p>Biztosan törölni szeretnéd a <strong>"${name}"</strong> ${itemType}?</p>
    ${isFolder ? '<p style="color: var(--accent-warning); margin-top: 10px; font-size: 13px;">⚠️ A mappa összes tartalma is törlődik!</p>' : ''}
  `, async () => {
        try {
            if (isFolder) {
                await apiCall('DELETE', `/buckets/${encodeURIComponent(currentBucket)}/folders/${encodeURIComponent(key)}`);
            } else {
                await apiCall('DELETE', `/buckets/${encodeURIComponent(currentBucket)}/objects/${encodeURIComponent(key)}`);
            }

            hideModal();
            showToast(`"${name}" törölve!`, 'success');
            await loadFiles();
        } catch (error) {
            showToast(`Hiba: ${error.message}`, 'error');
        }
    }, 'btn-danger');
}

async function handleDownloadFile(key) {
    try {
        const response = await fetch(`${API_BASE}/buckets/${encodeURIComponent(currentBucket)}/objects/${encodeURIComponent(key)}`, {
            headers: {
                'x-session-id': sessionId
            }
        });

        if (!response.ok) {
            throw new Error('Download failed');
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = key.split('/').pop();
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('Fájl letöltve!', 'success');
    } catch (error) {
        showToast(`Letöltési hiba: ${error.message}`, 'error');
    }
}

// ===== Upload =====
function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    uploadFiles(files);
    fileInput.value = '';
}

function handleDragOver(e) {
    e.preventDefault();
    if (currentBucket) {
        dropZone.classList.add('active');
    }
}

function handleDragLeave(e) {
    e.preventDefault();
    dropZone.classList.remove('active');
}

function handleDrop(e) {
    e.preventDefault();
    dropZone.classList.remove('active');

    if (!currentBucket) {
        showToast('Előbb válassz egy bucket-et!', 'error');
        return;
    }

    const files = Array.from(e.dataTransfer.files);
    uploadFiles(files);
}

async function uploadFiles(files) {
    if (files.length === 0) return;

    uploadProgress.style.display = 'block';
    uploadProgressList.innerHTML = '';

    for (const file of files) {
        const uploadItem = document.createElement('div');
        uploadItem.className = 'upload-item';
        uploadItem.innerHTML = `
      <span class="upload-status">⏳</span>
      <span class="upload-name">${file.name}</span>
      <div class="progress-bar">
        <div class="progress-bar-fill" style="width: 0%"></div>
      </div>
    `;
        uploadProgressList.appendChild(uploadItem);

        try {
            const key = currentPrefix + file.name;
            const arrayBuffer = await file.arrayBuffer();

            const response = await fetch(`${API_BASE}/buckets/${encodeURIComponent(currentBucket)}/objects`, {
                method: 'POST',
                headers: {
                    'x-session-id': sessionId,
                    'x-object-key': key,
                    'Content-Type': file.type || 'application/octet-stream'
                },
                body: arrayBuffer
            });

            if (!response.ok) {
                throw new Error('Upload failed');
            }

            uploadItem.querySelector('.upload-status').textContent = '✅';
            uploadItem.querySelector('.progress-bar-fill').style.width = '100%';
        } catch (error) {
            uploadItem.querySelector('.upload-status').textContent = '❌';
            console.error('Upload failed:', error);
        }
    }

    showToast(`${files.length} fájl feltöltve!`, 'success');
    await loadFiles();
}

// ===== Utilities =====
function handleRefresh() {
    if (currentBucket) {
        loadFiles();
    }
    loadBuckets();
    showToast('Frissítve!', 'success');
}

function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
        // Images
        jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
        // Documents
        pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
        // Code
        js: '📜', ts: '📜', py: '🐍', html: '🌐', css: '🎨', json: '📋',
        // Archives
        zip: '📦', rar: '📦', tar: '📦', gz: '📦',
        // Media
        mp3: '🎵', wav: '🎵', mp4: '🎬', avi: '🎬', mov: '🎬',
        // Other
        txt: '📝', md: '📝', csv: '📊'
    };
    return icons[ext] || '📄';
}

function formatSize(bytes) {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${bytes.toFixed(1)} ${units[i]}`;
}

function formatDate(date) {
    if (!date) return '—';
    return new Intl.DateTimeFormat('hu-HU', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }).format(new Date(date));
}

// ===== Modal =====
function showModal(title, content, onConfirm, confirmClass = 'btn-primary') {
    modalTitle.textContent = title;
    modalBody.innerHTML = content;
    modalConfirm.className = confirmClass.includes('btn-') ? confirmClass : `btn-primary ${confirmClass}`;

    modalConfirm.onclick = onConfirm;
    modalOverlay.style.display = 'flex';

    // Focus first input
    setTimeout(() => {
        const input = modalBody.querySelector('input');
        if (input) input.focus();
    }, 100);
}

function hideModal() {
    modalOverlay.style.display = 'none';
}

// ===== Toast =====
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: '✅',
        error: '❌',
        info: 'ℹ️',
        warning: '⚠️'
    };

    toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-message">${message}</span>
  `;

    toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'fadeIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ===== Initialize =====
init();

// --- DOM Elements ---
const DOMElements = {
    tmsUrl: document.getElementById('tms-url'),
    tmsUser: document.getElementById('tms-user'),
    tmsPassword: document.getElementById('tms-password'),
    tmsApiKey: document.getElementById('tms-apikey'),
    tmsTestBtn: document.getElementById('tms-test-btn'),
    toast: document.getElementById('toast'),
};

// --- Utility Functions ---
function showToast(message, type = 'info') {
    DOMElements.toast.textContent = message;
    DOMElements.toast.className = `toast ${type} show`;
    setTimeout(() => DOMElements.toast.classList.remove('show'), 4000);
}


// --- Mode Selection Logic ---
function getEnabledModes() {
    const savedModes = localStorage.getItem('enabledRecordingModes');
    return savedModes ? JSON.parse(savedModes) : { auto: true, nlp: true, playwright: true };
}

function saveEnabledModes(modes) {
    localStorage.setItem('enabledRecordingModes', JSON.stringify(modes));
    showToast('Recording modes saved!', 'success');
}

function loadModeToggles() {
    const enabledModes = getEnabledModes();
    Object.keys(enabledModes).forEach(mode => {
        const toggle = document.getElementById(`toggle-mode-${mode}`);
        if (toggle) {
            toggle.checked = enabledModes[mode];
            toggle.addEventListener('change', (e) => {
                const currentModes = getEnabledModes();
                currentModes[e.target.dataset.mode] = e.target.checked;
                saveEnabledModes(currentModes);
            });
        }
    });
}


// --- TMS Logic ---
async function handleTestTmsConnection() {
    const payload = {
        url: DOMElements.tmsUrl.value,
        user: DOMElements.tmsUser.value,
        password: DOMElements.tmsPassword.value,
        apikey: DOMElements.tmsApiKey.value,
    };

    if (!payload.url || !payload.user || !(payload.password || payload.apikey)) {
        showToast('URL, User, and a Password/API Key are required to test.', 'error');
        return;
    }
    
    DOMElements.tmsTestBtn.disabled = true;
    DOMElements.tmsTestBtn.textContent = 'Testing...';

    try {
        const response = await fetch('/api/tms/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (result.status === 'success') {
            showToast(result.message, 'success');
        } else {
            showToast(result.message, 'error');
        }
    } catch (error) {
        showToast(`An unexpected error occurred: ${error.message}`, 'error');
    } finally {
        DOMElements.tmsTestBtn.disabled = false;
        DOMElements.tmsTestBtn.textContent = 'Test Connection';
    }
}


// --- Initial Load ---
document.addEventListener('DOMContentLoaded', () => {
    loadModeToggles();
    DOMElements.tmsTestBtn.addEventListener('click', handleTestTmsConnection);
});
// --- DOM Elements ---
const DOMElements = {
    logContainer: document.getElementById('log-container'),
    backLink: document.getElementById('back-to-designer-link'),
    copyLogsBtn: document.getElementById('copy-logs-btn'),
    toast: document.getElementById('toast'),
};

// --- Global State ---
let playbackSocket = null;

// --- Utility Functions ---
function showToast(message, type = 'info') {
    DOMElements.toast.textContent = message;
    DOMElements.toast.className = `toast ${type} show`;
    setTimeout(() => DOMElements.toast.classList.remove('show'), 3000);
}

function appendLog(message, type = 'log') {
    const logEntry = document.createElement('div');
    if (type === 'status') {
        logEntry.className = 'text-yellow-400';
        logEntry.textContent = `[STATUS] ${message}`;
    } else if (type === 'error') {
        logEntry.className = 'text-red-500 font-bold';
        logEntry.textContent = message;
    } else {
         logEntry.className = 'text-gray-300';
         logEntry.textContent = message;
    }
    DOMElements.logContainer.appendChild(logEntry);
    DOMElements.logContainer.scrollTop = DOMElements.logContainer.scrollHeight;
}

function copyLogsToClipboard() {
    const logText = DOMElements.logContainer.innerText;
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(logText)
            .then(() => showToast('Logs copied to clipboard!', 'success'))
            .catch(err => showToast('Failed to copy logs.', 'error'));
    } else {
        // Fallback for non-secure contexts
        const textArea = document.createElement("textarea");
        textArea.value = logText;
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        try {
            document.execCommand('copy');
            showToast('Logs copied to clipboard!', 'success');
        } catch (err) {
            showToast('Failed to copy logs.', 'error');
        }
        document.body.removeChild(textArea);
    }
}


// --- Core Functions ---
function startPlayback() {
    // Extract info from URL
    const pathParts = window.location.pathname.split('/');
    const projectId = pathParts[2];
    const caseId = pathParts[3];
    const urlParams = new URLSearchParams(window.location.search);
    const mode = urlParams.get('mode') || 'auto';
    const headless = urlParams.get('headless') === 'true';

    // Set the back link
    if (projectId && caseId) {
        DOMElements.backLink.href = `/designer/${projectId}?mode=${mode}`;
    } else {
        appendLog('Error: Project ID or Case ID not found in URL.', 'error');
        return;
    }


    if (playbackSocket) {
        playbackSocket.close();
    }

    DOMElements.logContainer.innerHTML = '';
    appendLog('Connecting to runner...', 'status');

    const clientId = `playback_${Date.now()}`;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    playbackSocket = new WebSocket(`${wsProtocol}//${window.location.host}/ws/playback/${clientId}`);

    playbackSocket.onopen = () => {
        playbackSocket.send(JSON.stringify({
            type: 'start_playback',
            case_id: caseId,
            mode: mode,
            headless: headless
        }));
    };

    playbackSocket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'playback_log') {
            appendLog(msg.data, 'log');
        } else if (msg.type === 'status') {
            appendLog(msg.data, 'status');
        }
    };

    playbackSocket.onclose = () => {
        appendLog('Test run finished.', 'status');
    };

    playbackSocket.onerror = () => {
        appendLog('Connection error.', 'error');
    };
}

// --- Event Listener Setup ---
document.addEventListener('DOMContentLoaded', startPlayback);
DOMElements.copyLogsBtn.addEventListener('click', copyLogsToClipboard);
// --- DOM Elements ---
const DOMElements = {
    projectListCards: document.getElementById('project-list-cards'),
    testCaseList: document.getElementById('test-case-list'),
    runTestsBtn: document.getElementById('run-tests-btn'),
    generateReportBtn: document.getElementById('generate-report-btn'),
    clearSelectionBtn: document.getElementById('clear-selection-btn'),
    liveLogContainer: document.getElementById('live-log-container'),
    historicalLogContainer: document.getElementById('historical-log-container'),
    copyLiveLogsBtn: document.getElementById('copy-live-logs-btn'),
    toast: document.getElementById('toast'),
    selectAllCheckbox: document.getElementById('select-all-checkbox'),
    headlessModeCheckbox: document.getElementById('headless-mode-checkbox'),
    skipScreenshotsCheckbox: document.getElementById('skip-screenshots-checkbox'),
    reportModal: document.getElementById('report-modal'),
    saveHtmlBtn: document.getElementById('save-html-btn'),
    savePdfBtn: document.getElementById('save-pdf-btn'),
    reportCancelBtn: document.getElementById('report-cancel-btn'),
    modalBackdrop: document.getElementById('modal-backdrop'),
    step1Projects: document.getElementById('step-1-projects'),
    step2Modes: document.getElementById('step-2-modes'),
    step3Tests: document.getElementById('step-3-tests'),
    modeSelectionCards: document.getElementById('mode-selection-cards'),
    runSummary: document.getElementById('run-summary'),
};

// --- Global State ---
let runnerSocket = null;
let lastRunId = null;
let selectedProjectId = null;
let selectedProjectName = null;
let selectedMode = null;
let testCaseTitles = {}; // Map caseId to title for logging
const modeDisplayNames = {
    auto: "Selenium/XPath",
    nlp: "NLP-driven",
    playwright: "Playwright"
};

// --- Utility Functions ---
function showToast(message, type = 'info') {
    DOMElements.toast.textContent = message;
    DOMElements.toast.className = `toast ${type} show`;
    setTimeout(() => DOMElements.toast.classList.remove('show'), 3000);
}

function showModal(modal) {
    DOMElements.modalBackdrop.classList.remove('hidden');
    modal.classList.remove('hidden');
}

function hideModals() {
    DOMElements.modalBackdrop.classList.add('hidden');
    DOMElements.reportModal.classList.add('hidden');
}

function copyLogsToClipboard(container) {
    const logText = container.innerText;
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(logText)
            .then(() => showToast('Logs copied to clipboard!', 'success'))
            .catch(err => showToast('Failed to copy logs.', 'error'));
    } else {
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

// --- UI Navigation & Summary ---
function showStep(step) {
    DOMElements.step1Projects.classList.add('hidden');
    DOMElements.step2Modes.classList.add('hidden');
    DOMElements.step3Tests.classList.add('hidden');
    document.getElementById(step).classList.remove('hidden');
}

function updateRunSummary() {
    let summaryText = `<strong>Project:</strong> ${selectedProjectName || 'N/A'}`;
    summaryText += ` | <strong>Run Mode:</strong> ${modeDisplayNames[selectedMode] || 'N/A'}`;
    const selectedCases = DOMElements.testCaseList.querySelectorAll('.case-checkbox:checked').length;
    summaryText += ` | <strong>Cases Selected:</strong> ${selectedCases}`;
    DOMElements.runSummary.innerHTML = summaryText;
}


// --- Core Functions ---
async function loadProjects() {
    try {
        const response = await fetch('/api/projects');
        if (!response.ok) throw new Error('Failed to fetch projects');
        const projects = await response.json();
        
        DOMElements.projectListCards.innerHTML = '';
        if (projects.length > 0) {
            projects.forEach(p => {
                const card = document.createElement('div');
                card.className = 'project-card bg-gray-700 p-4 rounded-lg cursor-pointer hover:bg-blue-600 transition-colors duration-200';
                card.dataset.projectId = p.id;
                card.dataset.projectName = p.name;
                card.innerHTML = `<h3 class="font-bold text-lg">${p.name}</h3>`;
                card.addEventListener('click', () => selectProject(p.id, p.name));
                DOMElements.projectListCards.appendChild(card);
            });
        } else {
            DOMElements.projectListCards.innerHTML = '<p class="text-gray-500">No projects found. Please create one from the Project Hub.</p>';
        }
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

async function selectProject(projectId, projectName) {
    selectedProjectId = projectId;
    selectedProjectName = projectName;
    document.querySelectorAll('.project-card').forEach(card => {
        card.classList.remove('bg-blue-700');
        if(card.dataset.projectId === projectId) {
            card.classList.add('bg-blue-700');
        }
    });
    updateRunSummary();
    showStep('step-2-modes');
    populateModeSelection();
    await loadHistoricalLogs(projectId);
}

function getEnabledModes() {
    const savedModes = localStorage.getItem('enabledRecordingModes');
    return savedModes ? JSON.parse(savedModes) : { auto: true, nlp: true, playwright: true };
}

function populateModeSelection() {
    const enabledModes = getEnabledModes();
    DOMElements.modeSelectionCards.innerHTML = '';
    
    Object.keys(modeDisplayNames).forEach(modeId => {
        if (enabledModes[modeId]) {
            const card = document.createElement('div');
            card.className = 'mode-card bg-gray-700 p-4 rounded-lg cursor-pointer hover:bg-blue-600 transition-colors duration-200';
            card.dataset.modeId = modeId;
            card.innerHTML = `<h3 class="font-bold text-lg">${modeDisplayNames[modeId]}</h3>`;
            card.addEventListener('click', () => selectMode(modeId));
            DOMElements.modeSelectionCards.appendChild(card);
        }
    });
}

async function selectMode(modeId) {
    selectedMode = modeId;
    document.querySelectorAll('.mode-card').forEach(card => {
        card.classList.remove('bg-blue-700');
        if(card.dataset.modeId === modeId) {
           card.classList.add('bg-blue-700');
        }
    });
    updateRunSummary();
    showStep('step-3-tests');
    await loadTestsForProject(selectedProjectId);
}

async function loadTestsForProject(projectId) {
    try {
        const response = await fetch(`/api/project/${projectId}`);
        if (!response.ok) throw new Error('Failed to load project data');
        const projectData = await response.json();
        
        testCaseTitles = {};
        DOMElements.testCaseList.innerHTML = '';
        buildTestCaseCheckboxes(Object.values(projectData.hierarchy), DOMElements.testCaseList);
        DOMElements.runTestsBtn.disabled = true;
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

function buildTestCaseCheckboxes(itemsArray, parentElement, indent = 0) {
    for (const item of itemsArray) {
        const div = document.createElement('div');
        div.style.marginLeft = `${indent * 20}px`;

        if (item.type === 'suite') {
            const suiteContainer = document.createElement('div');
            suiteContainer.className = 'my-2';
            const suiteLabel = document.createElement('label');
            suiteLabel.className = 'flex items-center gap-2 p-1 rounded-md hover:bg-gray-600 cursor-pointer';
            suiteLabel.innerHTML = `
                <input type="checkbox" data-suite-id="${item.id}" class="suite-checkbox form-checkbox bg-gray-800 border-gray-500 text-purple-500 focus:ring-purple-600">
                <strong class="text-purple-400">${item.title}</strong>
            `;
            suiteContainer.appendChild(suiteLabel);
            parentElement.appendChild(suiteContainer);
            if (item.children && Object.keys(item.children).length > 0) {
                const childContainer = document.createElement('div');
                childContainer.className = 'suite-children';
                buildTestCaseCheckboxes(Object.values(item.children), childContainer, indent + 1);
                suiteContainer.appendChild(childContainer);
            }
        } else if (item.type === 'case') {
            testCaseTitles[item.id] = item.title;
            const label = document.createElement('label');
            label.className = 'flex items-center gap-2 p-1 rounded-md hover:bg-gray-600 cursor-pointer';
            label.innerHTML = `
                <input type="checkbox" value="${item.id}" class="case-checkbox form-checkbox bg-gray-800 border-gray-500 text-purple-500 focus:ring-purple-600">
                <span>${item.display_id || ''} - ${item.title}</span>
            `;
            div.appendChild(label);
            parentElement.appendChild(div);
        }
    }
}

function appendLiveLog(message, caseId) {
    const caseTitle = testCaseTitles[caseId] || caseId;
    const logEntry = document.createElement('div');
    
    let textColor = 'text-gray-300';
    if (message.includes('FAILED')) textColor = 'text-red-500';
    else if (message.includes('PASSED')) textColor = 'text-green-500';
    else if (message.includes('---')) textColor = 'text-yellow-400';

    logEntry.className = textColor;
    logEntry.textContent = `[${caseTitle}] ${message}`;
    DOMElements.liveLogContainer.appendChild(logEntry);
    DOMElements.liveLogContainer.scrollTop = DOMElements.liveLogContainer.scrollHeight;
}


async function loadHistoricalLogs(projectId) {
    DOMElements.historicalLogContainer.innerHTML = `<p class="text-gray-400">Loading logs...</p>`;
    try {
        const response = await fetch(`/api/project/${projectId}/runner_logs`);
        if (!response.ok) throw new Error('Failed to load historical logs');
        const runs = await response.json();

        DOMElements.historicalLogContainer.innerHTML = '';
        if (runs.length === 0) {
            DOMElements.historicalLogContainer.innerHTML = `<p class="text-gray-500">No historical logs found for this project.</p>`;
            return;
        }

        runs.forEach(run => {
            const runContainer = document.createElement('details');
            runContainer.className = 'mb-4 bg-gray-800 p-2 rounded';
            
            const summary = document.createElement('summary');
            summary.className = 'cursor-pointer text-white font-semibold flex justify-between items-center';
            summary.innerHTML = `<span>Run ID: ${run.run_id} (${run.timestamp})</span>`;

            if(run.report_generated) {
                const reportBadge = document.createElement('span');
                reportBadge.className = 'text-xs bg-green-600 text-white font-bold py-1 px-2 rounded-full';
                reportBadge.textContent = 'Report Generated';
                summary.appendChild(reportBadge);
            }
            
            const caseLogsContainer = document.createElement('div');
            caseLogsContainer.className = 'mt-2 pl-4 border-l-2 border-gray-700';

            run.cases.forEach(caseLog => {
                 const caseTitle = testCaseTitles[caseLog.case_id] || caseLog.case_id;
                 const statusColor = caseLog.status === 'PASSED' ? 'text-green-400' : (caseLog.status === 'FAILED' ? 'text-red-400' : 'text-yellow-400');
                 const caseContainer = document.createElement('details');
                 caseContainer.className = 'mb-2';
                 
                 const caseSummary = document.createElement('summary');
                 caseSummary.className = 'cursor-pointer';
                 caseSummary.innerHTML = `${caseTitle} - <span class="${statusColor}">${caseLog.status}</span>`;

                 const logData = document.createElement('div');
                 logData.className = 'text-xs p-2 mt-1 bg-gray-900 rounded';
                 logData.innerHTML = caseLog.log_data.join('<br>');
                 
                 caseContainer.appendChild(caseSummary);
                 caseContainer.appendChild(logData);
                 caseLogsContainer.appendChild(caseContainer);
            });
            
            runContainer.appendChild(summary);
            runContainer.appendChild(caseLogsContainer);
            DOMElements.historicalLogContainer.appendChild(runContainer);
        });

    } catch (error) {
        DOMElements.historicalLogContainer.innerHTML = `<p class="text-red-500">Error loading logs: ${error.message}</p>`;
    }
}

function clearAllSelections() {
    selectedProjectId = null;
    selectedProjectName = null;
    selectedMode = null;
    lastRunId = null;

    document.querySelectorAll('.project-card, .mode-card').forEach(card => card.classList.remove('bg-blue-700'));
    DOMElements.testCaseList.innerHTML = '';
    DOMElements.liveLogContainer.innerHTML = '<p class="text-gray-500">Waiting for test run to start...</p>';
    DOMElements.historicalLogContainer.innerHTML = '<p class="text-gray-500">Select a project to view historical logs.</p>';

    DOMElements.runTestsBtn.disabled = true;
    DOMElements.generateReportBtn.disabled = true;

    showStep('step-1-projects');
    updateRunSummary();
    showToast('Selections cleared.', 'info');
}


function runSelectedTests() {
    const selectedCaseIds = Array.from(DOMElements.testCaseList.querySelectorAll('.case-checkbox:checked')).map(cb => cb.value);

    if (selectedCaseIds.length === 0) {
        showToast('Please select at least one test case to run.', 'error');
        return;
    }

    if (runnerSocket) runnerSocket.close();
    lastRunId = null; 

    DOMElements.liveLogContainer.innerHTML = '';
    appendLiveLog('Connecting to runner...');
    DOMElements.runTestsBtn.disabled = true;
    DOMElements.runTestsBtn.querySelector('span').textContent = 'Running...';
    DOMElements.generateReportBtn.disabled = true;

    const clientId = `runner_${Date.now()}`;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    runnerSocket = new WebSocket(`${wsProtocol}//${window.location.host}/ws/runner/${clientId}`);

    runnerSocket.onopen = () => {
        const payload = {
            type: 'start_run',
            project_id: selectedProjectId,
            project_name: selectedProjectName,
            case_ids: selectedCaseIds,
            mode: selectedMode,
            headless: DOMElements.headlessModeCheckbox.checked,
            // The logic is inverted here: if "skip" is checked, we capture FALSE.
            capture_all_steps: !DOMElements.skipScreenshotsCheckbox.checked
        };
        runnerSocket.send(JSON.stringify(payload));
    };

    runnerSocket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if(msg.type === 'playback_log') {
            appendLiveLog(msg.data, msg.case_id);
        } else if (msg.status === 'info') {
            appendLiveLog(msg.message, 'Runner');
            if (msg.run_id) {
                lastRunId = msg.run_id;
            }
        }
    };

    runnerSocket.onclose = async () => {
        appendLiveLog('Test run finished.', 'Runner');
        DOMElements.runTestsBtn.disabled = false;
        DOMElements.runTestsBtn.querySelector('span').textContent = 'Run';
        if (lastRunId) {
            DOMElements.generateReportBtn.disabled = false;
        }
        await loadHistoricalLogs(selectedProjectId);
    };

    runnerSocket.onerror = () => {
        appendLiveLog('Connection error.', 'Runner');
        DOMElements.runTestsBtn.disabled = false;
        DOMElements.runTestsBtn.querySelector('span').textContent = 'Run';
    };
}

async function handleSaveReport(format) {
    if (!lastRunId) {
        showToast('No recent run found to generate a report.', 'error');
        return;
    }
    
    hideModals();
    showToast(`Generating report to save...`, 'info');

    try {
        const response = await fetch('/api/runner/report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project_id: selectedProjectId,
                run_id: lastRunId,
                format: 'html'
            })
        });

        if (!response.ok) throw new Error('Failed to generate report content');
        const reportHtml = await response.text();

        const saveResponse = await fetch('/api/runner/report/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project_name: selectedProjectName,
                report_content: reportHtml,
                format: format
            })
        });

        const result = await saveResponse.json();
        if (!saveResponse.ok) throw new Error(result.error || 'Failed to save report');
        
        showToast(result.message, 'success');
        await loadHistoricalLogs(selectedProjectId);
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}


// --- Event Listener Setup ---
document.addEventListener('DOMContentLoaded', () => {
    loadProjects();
    showStep('step-1-projects');
    updateRunSummary();

    DOMElements.runTestsBtn.addEventListener('click', runSelectedTests);
    DOMElements.generateReportBtn.addEventListener('click', () => showModal(DOMElements.reportModal));
    DOMElements.copyLiveLogsBtn.addEventListener('click', () => copyLogsToClipboard(DOMElements.liveLogContainer));
    DOMElements.clearSelectionBtn.addEventListener('click', clearAllSelections);
    
    DOMElements.headlessModeCheckbox.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        DOMElements.skipScreenshotsCheckbox.disabled = isChecked;
        if (isChecked) {
            // Force skipping screenshots in headless mode
            DOMElements.skipScreenshotsCheckbox.checked = true;
        }
    });

    DOMElements.testCaseList.addEventListener('change', (e) => {
        const selectedCount = DOMElements.testCaseList.querySelectorAll('.case-checkbox:checked').length;
        DOMElements.runTestsBtn.disabled = selectedCount === 0;
        updateRunSummary();

        if (e.target.classList.contains('suite-checkbox')) {
            const isChecked = e.target.checked;
            const suiteContainer = e.target.closest('.my-2');
            suiteContainer.querySelectorAll('.case-checkbox').forEach(checkbox => {
                checkbox.checked = isChecked;
            });
            const newSelectedCount = DOMElements.testCaseList.querySelectorAll('.case-checkbox:checked').length;
            DOMElements.runTestsBtn.disabled = newSelectedCount === 0;
            updateRunSummary();
        }
    });

    DOMElements.selectAllCheckbox.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        DOMElements.testCaseList.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
            checkbox.checked = isChecked;
        });
        const anyCheckboxes = DOMElements.testCaseList.querySelectorAll('.case-checkbox').length > 0;
        DOMElements.runTestsBtn.disabled = !anyCheckboxes || !isChecked;
        updateRunSummary();
    });
    
    DOMElements.saveHtmlBtn.addEventListener('click', () => handleSaveReport('html'));
    DOMElements.savePdfBtn.addEventListener('click', () => handleSaveReport('pdf'));
    DOMElements.reportCancelBtn.addEventListener('click', hideModals);
});
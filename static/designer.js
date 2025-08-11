// Global state variables
let activeItemId = null;
let testCasesData = {};
let websocket = null;
let importTargetSuiteId = null;
let hasUnsavedChanges = false;
let copiedStepsAvailable = false;
let draggedStepId = null;

// URL parameters
const urlParams = new URLSearchParams(window.location.search);
const activeStepsMode = urlParams.get('mode') || 'auto';
const activeProjectId = window.location.pathname.split('/')[2];

// Constants for display names and UI elements
const modeDisplayNames = {
    auto: "Selenium/XPath Recording",
    nlp: "NLP-driven Recording",
    playwright: "Playwright Recording"
};

// A map of all DOM elements for easy access
const DOMElements = {
    testList: document.getElementById('test-list'),
    placeholderView: document.getElementById('placeholder-view'),
    testCaseView: document.getElementById('test-case-view'),
    caseTitle: document.getElementById('case-title'),
    caseId: document.getElementById('case-id'),
    recordingModeTitle: document.getElementById('recording-mode-title'),
    urlInput: document.getElementById('url-input'),
    recordBtn: document.getElementById('record-btn'),
    recordIcon: document.getElementById('record-icon'),
    recordText: document.getElementById('record-text'),
    pauseBtn: document.getElementById('pause-btn'),
    pauseText: document.getElementById('pause-text'),
    stepsList: document.getElementById('steps-list'),
    preconditionsText: document.getElementById('preconditions-text'),
    separatedStepsText: document.getElementById('separated_steps-text'),
    expectedResultText: document.getElementById('expected_result-text'),
    saveProjectBtn: document.getElementById('save-project-btn'),
    saveStepsBtn: document.getElementById('save-steps-btn'),
    tabsContainer: document.getElementById('tabs-container'),
    contextMenu: document.getElementById('context-menu'),
    projectNameHeader: document.getElementById('project-name-header'),
    csvImporter: document.getElementById('csv-importer'),
    fileUploader: document.getElementById('file-uploader'),
    resizer: document.getElementById('resizer'),
    sidebar: document.getElementById('sidebar'),
    manualActionsToolbar: document.getElementById('manual-actions-toolbar'),
    recorderControls: document.getElementById('recorder-controls'),
    bulkStepActions: document.getElementById('bulk-step-actions'),
    selectAllSteps: document.getElementById('select-all-steps'),
    deleteAllStepsBtn: document.getElementById('delete-all-steps-btn'),
    bulkActionsFooter: document.getElementById('bulk-actions-footer'),
    deleteSelectedBtn: document.getElementById('delete-selected-btn'),
    playbackLink: document.getElementById('playback-link'),
    toast: document.getElementById('toast'),
    // Modals
    modalBackdrop: document.getElementById('modal-backdrop'),
    promptModal: document.getElementById('prompt-modal'),
    promptTitle: document.getElementById('prompt-title'),
    promptInputs: document.getElementById('prompt-inputs'),
    promptCancelBtn: document.getElementById('prompt-cancel-btn'),
    promptConfirmBtn: document.getElementById('prompt-confirm-btn'),
    confirmModal: document.getElementById('confirm-modal'),
    confirmTitle: document.getElementById('confirm-title'),
    confirmMessage: document.getElementById('confirm-message'),
    confirmCancelBtn: document.getElementById('confirm-cancel-btn'),
    confirmOkBtn: document.getElementById('confirm-ok-btn'),
};

const MANUAL_KEYWORDS = {
    'Browser': [
        { name: 'Switch To Window', params: ['window_handle_or_index'], type: 'ACTION', action: 'SWITCH_WINDOW', tooltip: 'Switch focus to a different window or tab.' },
        { name: 'Close Window', params: [], type: 'ACTION', action: 'CLOSE_WINDOW', tooltip: 'Closes the current window or tab.' },
        { name: 'Set Window Size', params: ['width', 'height'], type: 'ACTION', action: 'SET_WINDOW_SIZE', tooltip: 'Sets the size of the current browser window.' },
        { name: 'Maximize Window', params: [], type: 'ACTION', action: 'MAXIMIZE_WINDOW', tooltip: 'Maximizes the current browser window.' },
        { name: 'Get All Cookies', params: ['variable_name'], type: 'ACTION', action: 'GET_ALL_COOKIES', tooltip: 'Retrieves all cookies and stores them in a variable.' },
        { name: 'Get Cookie', params: ['cookie_name', 'variable_name'], type: 'ACTION', action: 'GET_COOKIE', tooltip: 'Retrieves a specific cookie and stores its value.' },
        { name: 'Add Cookie', params: ['name', 'value'], type: 'ACTION', action: 'ADD_COOKIE', tooltip: 'Adds a cookie to the current session.' },
        { name: 'Delete Cookie', params: ['name'], type: 'ACTION', action: 'DELETE_COOKIE', tooltip: 'Deletes a specific cookie.' },
        { name: 'Delete All Cookies', params: [], type: 'ACTION', action: 'DELETE_ALL_COOKIES', tooltip: 'Deletes all cookies for the current domain.' },
    ],
    'Page': [
        { name: 'Go To', params: ['url'], type: 'ACTION', action: 'NAVIGATE', tooltip: 'Navigates to the specified URL.' },
        { name: 'Reload Page', params: [], type: 'ACTION', action: 'RELOAD', tooltip: 'Reloads the current page.' },
        { name: 'Go Back', params: [], type: 'ACTION', action: 'BACK', tooltip: 'Navigates back in the browser history.' },
        { name: 'Go Forward', params: [], type: 'ACTION', action: 'FORWARD', tooltip: 'Navigates forward in the browser history.' },
        { name: 'Execute Javascript', params: ['script'], type: 'ACTION', action: 'EXECUTE_SCRIPT', tooltip: 'Executes JavaScript in the browser.' },
        { name: 'Take Screenshot', params: ['filename'], type: 'ACTION', action: 'TAKE_SCREENSHOT', tooltip: 'Takes a screenshot of the visible part of the page.' },
    ],
    'Interactions': [
        { name: 'Hover Element', params: ['selector'], type: 'ACTION', action: 'HOVER', tooltip: 'Simulates a mouse-over on an element.' },
        { name: 'Double Click Element', params: ['selector'], type: 'ACTION', action: 'DOUBLE_CLICK', tooltip: 'Performs a double-click on an element.' },
        { name: 'Right Click Element', params: ['selector'], type: 'ACTION', action: 'RIGHT_CLICK', tooltip: 'Performs a right-click on an element.' },
        { name: 'Drag And Drop', params: ['source_selector', 'target_selector'], type: 'ACTION', action: 'DRAG_AND_DROP', tooltip: 'Drags an element and drops it onto another.' },
        { name: 'Press Key', params: ['selector', 'key'], type: 'ACTION', action: 'PRESS_KEY', tooltip: 'Simulates pressing a keyboard key on an element (e.g., Enter, Tab).' },
        { name: 'Scroll To Element', params: ['selector'], type: 'ACTION', action: 'SCROLL_TO_ELEMENT', tooltip: 'Scrolls the page until the element is visible.' },
        { name: 'Scroll Page', params: ['x_offset', 'y_offset'], type: 'ACTION', action: 'SCROLL_PAGE', tooltip: 'Scrolls the page by a specified amount.' },
    ],
    'Element': [
        { name: 'Click Element', params: ['selector'], type: 'ACTION', action: 'CLICK', tooltip: 'Clicks the specified element.' },
        { name: 'Input Text', params: ['selector', 'text'], type: 'ACTION', action: 'TYPE', tooltip: 'Types text into an element. Use ${variable_name} to use a stored value.' },
        { name: 'Clear Element Text', params: ['selector'], type: 'ACTION', action: 'CLEAR', tooltip: 'Clears text from an element.' },
        { name: 'Upload File', params: ['selector'], type: 'ACTION', action: 'UPLOAD_FILE', tooltip: 'Uploads a file to a file input element.' },
        { name: 'Select By Value', params: ['selector', 'value'], type: 'ACTION', action: 'SELECT_BY_VALUE', tooltip: 'Selects a dropdown option by its value attribute.' },
        { name: 'Select By Label', params: ['selector', 'label'], type: 'ACTION', action: 'SELECT_BY_LABEL', tooltip: 'Selects a dropdown option by its visible text.' },
        { name: 'Get Element Attribute', params: ['selector', 'attribute_name', 'variable_name'], type: 'ACTION', action: 'GET_ATTRIBUTE', tooltip: 'Gets an attribute from an element and stores it.' },
        { name: 'Get Element Text', params: ['selector', 'variable_name'], type: 'ACTION', action: 'GET_TEXT', tooltip: 'Gets the text of an element and stores it.' },
    ],
    'Wait': [
        { name: 'Sleep', params: ['seconds'], type: 'ACTION', action: 'SLEEP', tooltip: 'Pauses execution for a fixed amount of time.' },
        { name: 'Wait Until Element Is Visible', params: ['selector', 'timeout_seconds'], type: 'ACTION', action: 'WAIT_VISIBLE', tooltip: 'Waits for an element to be visible.' },
        { name: 'Wait Until Element Is Not Visible', params: ['selector', 'timeout_seconds'], type: 'ACTION', action: 'WAIT_NOT_VISIBLE', tooltip: 'Waits for an element to become invisible.' },
        { name: 'Wait Until Element Is Clickable', params: ['selector', 'timeout_seconds'], type: 'ACTION', action: 'WAIT_CLICKABLE', tooltip: 'Waits for an element to be clickable.' },
        { name: 'Wait Until Page Contains', params: ['text', 'timeout_seconds'], type: 'ACTION', action: 'WAIT_PAGE_CONTAINS', tooltip: 'Waits for the page source to contain specific text.' },
        { name: 'Wait Until Element Contains', params: ['selector', 'text', 'timeout_seconds'], type: 'ACTION', action: 'WAIT_ELEMENT_CONTAINS', tooltip: 'Waits for an element to contain specific text.' },
        { name: 'Wait For Alert', params: ['timeout_seconds'], type: 'ACTION', action: 'WAIT_FOR_ALERT', tooltip: 'Waits for a browser alert to appear.' },
    ],
    'Assert': [
        { name: 'Page Should Contain', params: ['text'], type: 'VALIDATION', validation_type: 'PAGE_CONTAINS', tooltip: 'Asserts the page source contains the given text.' },
        { name: 'Page Should Not Contain', params: ['text'], type: 'VALIDATION', validation_type: 'PAGE_NOT_CONTAINS', tooltip: 'Asserts the page source does not contain the given text.' },
        { name: 'Title Should Be', params: ['title'], type: 'VALIDATION', validation_type: 'TITLE_IS', tooltip: 'Asserts the page title is exactly the given text.' },
        { name: 'URL Should Be', params: ['url'], type: 'VALIDATION', validation_type: 'URL_IS', tooltip: 'Asserts the current URL is exactly the given text.' },
        { name: 'URL Should Contain', params: ['text'], type: 'VALIDATION', validation_type: 'URL_CONTAINS', tooltip: 'Asserts the current URL contains the given text.' },
        { name: 'Element Should Be Visible', params: ['selector'], type: 'VALIDATION', validation_type: 'ELEMENT_VISIBLE', tooltip: 'Asserts an element is visible.' },
        { name: 'Element Should Not Be Visible', params: ['selector'], type: 'VALIDATION', validation_type: 'ELEMENT_NOT_VISIBLE', tooltip: 'Asserts an element is not visible.' },
        { name: 'Element Text Should Be', params: ['selector', 'text'], type: 'VALIDATION', validation_type: 'ELEMENT_TEXT_IS', tooltip: 'Asserts an element\'s text is exactly the given text.' },
        { name: 'Element Contains Text', params: ['selector', 'text'], type: 'VALIDATION', validation_type: 'ELEMENT_CONTAINS_TEXT', tooltip: 'Asserts an element contains the given text.' },
        { name: 'Element Attribute Should Be', params: ['selector', 'attribute', 'expected_value'], type: 'VALIDATION', validation_type: 'ATTRIBUTE_IS', tooltip: 'Asserts an element\'s attribute has a specific value.' },
        { name: 'Element CSS Property Should Be', params: ['selector', 'property', 'expected_value'], type: 'VALIDATION', validation_type: 'CSS_IS', tooltip: 'Asserts an element\'s CSS property has a specific value.' },
        { name: 'Cookie Should Exist', params: ['cookie_name'], type: 'VALIDATION', validation_type: 'COOKIE_EXISTS', tooltip: 'Asserts that a cookie with the given name exists.' },
        { name: 'Cookie Value Should Be', params: ['cookie_name', 'expected_value'], type: 'VALIDATION', validation_type: 'COOKIE_VALUE_IS', tooltip: 'Asserts a cookie has a specific value.' },
    ],
    'Data': [
         { name: 'Store Value', params: ['value', 'variable_name'], type: 'ACTION', action: 'STORE_VALUE', tooltip: 'Stores a static value in a variable for later use.' },
         { name: 'Log To Console', params: ['message'], type: 'ACTION', action: 'LOG_MESSAGE', tooltip: 'Prints a message to the playback log. Can include variables like ${variable_name}.' },
    ],
    'API': [
        { name: 'API GET Request', params: ['url', 'response_variable'], type: 'ACTION', action: 'API_GET', tooltip: 'Sends a GET request and stores the JSON response in a variable.' },
        { name: 'API POST Request', params: ['url', 'json_payload', 'response_variable'], type: 'ACTION', action: 'API_POST', tooltip: 'Sends a POST request with a JSON body.' },
    ]
};

// --- Utility Functions ---

function showToast(message, type = 'info') {
    DOMElements.toast.textContent = message;
    DOMElements.toast.className = `toast ${type} show`;
    setTimeout(() => DOMElements.toast.classList.remove('show'), 3000);
}

function findItemById(id, items = testCasesData) {
    if (!items) return null;
    for (const key in items) {
        if (items[key].id === id) return items[key];
        if (items[key].type === 'suite' && items[key].children) {
            const found = findItemById(id, items[key].children);
            if (found) return found;
        }
    }
    return null;
}

function findParent(childId, items = testCasesData, parent = null) {
    if (!items) return null;
    for (const key in items) {
        if (key === childId) return parent;
        if (items[key].type === 'suite' && items[key].children) {
            const found = findParent(childId, items[key].children, items[key]);
            if (found) return found;
        }
    }
    return null;
}

function getTcNumber(displayId) {
    if (!displayId) return 9999999;
    const match = displayId.match(/\d+/);
    return match ? parseInt(match[0], 10) : 9999999;
}

// --- Modal Management ---

function showModal(modal) {
    DOMElements.modalBackdrop.classList.remove('hidden');
    modal.classList.remove('hidden');
}

function hideModals() {
    DOMElements.modalBackdrop.classList.add('hidden');
    DOMElements.promptModal.classList.add('hidden');
    DOMElements.confirmModal.classList.add('hidden');
}

function showPrompt({ title, inputs, confirmText = 'Confirm' }) {
    return new Promise((resolve) => {
        DOMElements.promptTitle.textContent = title;
        DOMElements.promptInputs.innerHTML = ''; // Clear previous inputs

        inputs.forEach(input => {
            const inputElem = document.createElement('input');
            inputElem.type = 'text';
            inputElem.placeholder = input.placeholder;
            inputElem.value = input.value || '';
            inputElem.dataset.key = input.key;
            inputElem.className = 'w-full bg-gray-700 border border-gray-600 rounded-md p-2 focus:ring-purple-500 focus:border-purple-500 mb-2';
            DOMElements.promptInputs.appendChild(inputElem);
        });

        DOMElements.promptConfirmBtn.textContent = confirmText;
        showModal(DOMElements.promptModal);

        const onConfirm = () => {
            const result = {};
            DOMElements.promptInputs.querySelectorAll('input').forEach(input => {
                result[input.dataset.key] = input.value;
            });
            cleanup();
            resolve(result);
        };

        const onCancel = () => {
            cleanup();
            resolve(null);
        };

        const cleanup = () => {
            hideModals();
            DOMElements.promptConfirmBtn.removeEventListener('click', onConfirm);
            DOMElements.promptCancelBtn.removeEventListener('click', onCancel);
        };

        DOMElements.promptConfirmBtn.addEventListener('click', onConfirm);
        DOMElements.promptCancelBtn.addEventListener('click', onCancel);
    });
}

function showConfirm({ title, message, confirmText = 'Confirm' }) {
    return new Promise((resolve) => {
        DOMElements.confirmTitle.textContent = title;
        DOMElements.confirmMessage.textContent = message;
        DOMElements.confirmOkBtn.textContent = confirmText;
        showModal(DOMElements.confirmModal);

        const onConfirm = () => {
            cleanup();
            resolve(true);
        };
        const onCancel = () => {
            cleanup();
            resolve(false);
        };

        const cleanup = () => {
            hideModals();
            DOMElements.confirmOkBtn.removeEventListener('click', onConfirm);
            DOMElements.confirmCancelBtn.removeEventListener('click', onCancel);
        };

        DOMElements.confirmOkBtn.addEventListener('click', onConfirm);
        DOMElements.confirmCancelBtn.addEventListener('click', onCancel);
    });
}


// --- Core Application Logic ---

async function loadProjectData() {
    if (!activeProjectId) return;
    try {
        DOMElements.recordingModeTitle.textContent = `(${modeDisplayNames[activeStepsMode] || "Recording"})`;
        const response = await fetch(`/api/project/${activeProjectId}`);
        if (!response.ok) throw new Error('Failed to load project data');
        const projectData = await response.json();
        testCasesData = projectData.hierarchy || {};
        DOMElements.projectNameHeader.textContent = projectData.name;
        refreshTestExplorer();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function saveProjectData() {
    if (!activeProjectId) return;
    showToast('Saving project...', 'info');
    try {
        const activeCase = findItemById(activeItemId);
        if (activeCase && activeCase.type === 'case') {
            activeCase.preconditions = DOMElements.preconditionsText.value;
            activeCase.manual_steps = DOMElements.separatedStepsText.value;
            activeCase.expected_result = DOMElements.expectedResultText.value;
            activeCase.url = DOMElements.urlInput.value;
            if (activeStepsMode === 'playwright') {
                const textarea = DOMElements.stepsList.querySelector('textarea');
                if (textarea) {
                   activeCase.playwright_script = textarea.value || '';
                }
            }
        }

        const payload = { projectId: activeProjectId, data: testCasesData };
        const response = await fetch('/api/project/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Failed to save project');

        showToast(result.message, 'success');
        hasUnsavedChanges = false;
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// --- WebSocket Management ---

function connectWebSocket() {
    const clientId = `client_${Date.now()}`;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    websocket = new WebSocket(`${wsProtocol}//${window.location.host}/ws/recorder/${clientId}`);

    websocket.onopen = () => {
        showToast('Recorder connected', 'info');
        DOMElements.recordBtn.classList.replace('bg-red-600', 'bg-gray-600');
        DOMElements.recordIcon.classList.add('fa-spin');
        DOMElements.recordText.textContent = 'Recording...';
        if (activeStepsMode !== 'playwright') {
            DOMElements.pauseBtn.classList.remove('hidden');
            DOMElements.pauseText.textContent = 'Pause';
        }

        websocket.send(JSON.stringify({
            type: 'start_recording',
            url: DOMElements.urlInput.value,
            mode: activeStepsMode
        }));
    };

    websocket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'status') {
            showToast(message.data, 'info');
        } else if (message.type === 'step') {
            const activeCase = findItemById(activeItemId);
            if (activeCase && activeCase.type === 'case') {
                const mode = message.mode;
                if (!activeCase.steps[mode]) activeCase.steps[mode] = [];
                activeCase.steps[mode].push(message.data);
                if (mode === activeStepsMode) {
                   renderSteps(activeCase.steps[activeStepsMode]);
                   hasUnsavedChanges = true;
                }
            }
        }
    };

    websocket.onclose = () => {
        showToast('Recorder disconnected', 'error');
        stopRecordingUI();
    };

    websocket.onerror = () => {
        showToast('Recorder connection error', 'error');
        stopRecordingUI();
    };
}

function stopRecording() {
    if (websocket) {
        websocket.send(JSON.stringify({ type: 'stop_recording' }));
        websocket.close();
    }
}

function stopRecordingUI() {
    websocket = null;
    DOMElements.recordBtn.classList.replace('bg-gray-600', 'bg-red-600');
    DOMElements.recordIcon.classList.remove('fa-spin');
    DOMElements.recordText.textContent = activeStepsMode === 'playwright' ? 'Initiate Recording' : 'Record';
    DOMElements.pauseBtn.classList.add('hidden');
}


// --- UI Rendering ---

function refreshTestExplorer() {
    DOMElements.testList.innerHTML = '';
    if (!testCasesData) return;
    const sortedItems = Object.values(testCasesData).sort((a, b) => {
        const aIsSuite = a.type === 'suite';
        const bIsSuite = b.type === 'suite';
        if (aIsSuite && !bIsSuite) return -1;
        if (!aIsSuite && bIsSuite) return 1;
        if (aIsSuite && bIsSuite) return a.title.localeCompare(b.title);
        return getTcNumber(a.display_id) - getTcNumber(b.display_id);
    });
    buildTestTreeRecursive(sortedItems, DOMElements.testList);
}

function buildTestTreeRecursive(items, parentElement, indent = 0) {
    items.forEach(item => {
        const itemDiv = document.createElement('div');
        itemDiv.className = `rounded-md p-2 my-1 cursor-pointer flex items-center gap-3 text-sm ${item.id === activeItemId ? 'bg-blue-600 text-white' : 'hover:bg-gray-700'}`;
        itemDiv.style.marginLeft = `${indent * 20}px`;
        itemDiv.dataset.id = item.id;
        itemDiv.innerHTML = `<i class="fas ${item.type === 'suite' ? 'fa-folder' : 'fa-file-alt'} fa-fw"></i><span class="flex-grow">${item.display_id ? item.display_id + ' - ' : ''}${item.title}</span>`;
        parentElement.appendChild(itemDiv);

        if (item.type === 'suite' && item.children) {
            const sortedChildren = Object.values(item.children).sort((a, b) => {
                 if (a.type === 'suite' && b.type !== 'suite') return -1;
                 if (a.type !== 'suite' && b.type === 'suite') return 1;
                 if (a.type === 'suite' && b.type === 'suite') return a.title.localeCompare(b.title);
                 return getTcNumber(a.display_id) - getTcNumber(b.display_id);
            });
            buildTestTreeRecursive(sortedChildren, parentElement, indent + 1);
        }
    });
}

function renderTestCaseDetails(item) {
    const isCase = item && item.type === 'case';
    DOMElements.placeholderView.classList.toggle('hidden', isCase);
    DOMElements.testCaseView.classList.toggle('hidden', !isCase);

    DOMElements.recordText.textContent = activeStepsMode === 'playwright' ? 'Initiate Recording' : 'Record';

    if (isCase) {
        const isPlaywright = activeStepsMode === 'playwright';
        DOMElements.manualActionsToolbar.classList.toggle('hidden', isPlaywright);
        DOMElements.bulkStepActions.style.display = isPlaywright ? 'none' : 'flex';
        DOMElements.playbackLink.style.display = 'flex';
        DOMElements.playbackLink.href = `/playback/${activeProjectId}/${item.id}?mode=${activeStepsMode}`;
        DOMElements.caseTitle.textContent = item.title;
        DOMElements.caseId.textContent = item.display_id;
        DOMElements.urlInput.value = item.url || '';
        DOMElements.preconditionsText.value = item.preconditions || '';
        DOMElements.separatedStepsText.value = item.manual_steps || '';
        DOMElements.expectedResultText.value = item.expected_result || '';
        if (!item.steps) item.steps = { auto: [], nlp: [], playwright: [] };
        if (activeStepsMode === 'playwright') {
            renderPlaywrightEditor(item.playwright_script || '');
        } else {
            renderSteps(item.steps[activeStepsMode] || []);
        }
    }
}

function renderPlaywrightEditor(script) {
    DOMElements.stepsList.innerHTML = `<div class="relative h-full"><textarea class="w-full h-full bg-gray-900 text-sm p-2 rounded-md font-mono" placeholder="1. Click Initiate Recording...\n2. Use the Playwright Inspector to record your test.\n3. Close the inspector when done.\n4. Paste the generated code here.\n5. Click 'Save Steps'.">${script}</textarea></div>`;
}

function renderSteps(steps) {
    DOMElements.stepsList.innerHTML = '';
    if (!steps || steps.length === 0) {
        DOMElements.stepsList.innerHTML = `<div class="text-center text-gray-500 p-4">No automation steps defined. Click Record or use the toolbar above.</div>`;
    } else {
        steps.forEach((step, index) => {
            const stepCard = document.createElement('div');
            stepCard.className = `step-card bg-gray-700 p-3 rounded-md flex items-start gap-4 step-${step.type.toLowerCase()}`;
            stepCard.draggable = true;
            stepCard.dataset.stepId = step.id;
            const actionColor = step.type.toLowerCase() === 'action' ? 'text-blue-400' : 'text-green-400';
            const actionName = step.action || 'ASSERT';
            const subActionName = step.validation_type || '';
            stepCard.innerHTML = `
                <input type="checkbox" class="step-checkbox form-checkbox bg-gray-700 border-gray-600 text-purple-500 focus:ring-purple-600 mt-1" data-step-id="${step.id}">
                <span class="font-bold text-gray-400">${index + 1}.</span>
                <div class="flex-grow flex items-start gap-4">
                    <div class="w-28 text-right pr-2 border-r border-gray-600 flex-shrink-0">
                        <p class="font-bold ${actionColor}">${actionName}</p>
                        ${subActionName ? `<p class="text-xs text-gray-400">${subActionName}</p>` : ''}
                    </div>
                    <div class="flex-grow">
                        <p class="font-mono text-sm text-gray-300 break-all">${step.selector || ''}</p>
                        ${step.value ? `<p class="text-xs text-gray-400 mt-1">Value: <span class="font-semibold text-yellow-400">${step.value}</span></p>` : ''}
                        ${step.expected_value ? `<p class="text-xs text-gray-400 mt-1">Expected: <span class="font-semibold text-yellow-400">${step.expected_value}</span></p>` : ''}
                    </div>
                </div>
                <div class="flex gap-2 items-center">
                    <button class="edit-step-btn text-blue-400 hover:text-blue-300" title="Edit Step" data-step-id="${step.id}"><i class="fas fa-edit"></i></button>
                    <button class="duplicate-step-btn text-yellow-400 hover:text-yellow-300" title="Duplicate Step" data-step-id="${step.id}"><i class="fas fa-clone"></i></button>
                    <button class="delete-step-btn text-red-400 hover:text-red-300" title="Delete Step" data-step-id="${step.id}"><i class="fas fa-trash"></i></button>
                </div>`;
            DOMElements.stepsList.appendChild(stepCard);
        });
    }
    updateBulkActionsVisibility();
}

function showContextMenu(e, itemId) {
    e.preventDefault();
    const item = itemId ? findItemById(itemId) : null;
    const menu = DOMElements.contextMenu;
    menu.innerHTML = '';
    if (item) {
        if (item.type === 'suite') {
            menu.innerHTML += `<button data-action="add-suite" data-id="${itemId}">New Sub-Suite</button>`;
            menu.innerHTML += `<button data-action="add-case" data-id="${itemId}">New Test Case</button>`;
            menu.innerHTML += `<button data-action="import-csv" data-id="${itemId}">Import from CSV</button>`;
        } else if (item.type === 'case' && activeStepsMode !== 'playwright') {
             const stepsForMode = (item.steps && item.steps[activeStepsMode]) ? item.steps[activeStepsMode] : [];
             menu.innerHTML += `<button data-action="copy-steps" data-id="${itemId}" ${stepsForMode.length === 0 ? 'disabled' : ''}>Copy Steps</button>`;
             menu.innerHTML += `<button data-action="paste-steps" data-id="${itemId}" ${!copiedStepsAvailable ? 'disabled' : ''}>Paste Steps</button>`;
        }
        menu.innerHTML += '<div class="separator"></div>';
        menu.innerHTML += `<button data-action="rename" data-id="${itemId}">Rename</button>`;
        menu.innerHTML += `<button data-action="delete" data-id="${itemId}">Delete</button>`;
    } else {
        menu.innerHTML += `<button data-action="add-root-suite">New Root Suite</button>`;
    }
    menu.innerHTML += '<div class="separator"></div>';
    menu.innerHTML += `<button data-action="download-template">Download CSV Template</button>`;
    menu.style.top = `${e.pageY}px`;
    menu.style.left = `${e.pageX}px`;
    menu.classList.remove('hidden');
}

function hideContextMenu() {
    DOMElements.contextMenu.classList.add('hidden');
}

async function handleContextMenuAction(e) {
    const target = e.target.closest('button');
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    const id = target.dataset.id;
    hideContextMenu();

    if (action === 'add-suite' || action === 'add-root-suite') {
        const result = await showPrompt({ title: 'New Suite', inputs: [{ key: 'name', placeholder: 'Enter suite name' }] });
        if (result && result.name) {
            const newSuite = { id: `suite-${Date.now()}`, type: 'suite', title: result.name, children: {} };
            const parent = id ? findItemById(id) : null;
            if (parent && parent.type === 'suite') {
                if (!parent.children) parent.children = {};
                parent.children[newSuite.id] = newSuite;
            } else {
                testCasesData[newSuite.id] = newSuite;
            }
            refreshTestExplorer();
            await saveProjectData();
        }
    } else if (action === 'add-case') {
        const result = await showPrompt({ title: 'New Test Case', inputs: [{ key: 'name', placeholder: 'Enter test case name' }] });
        if (result && result.name) {
            const parentSuite = findItemById(id);
            if (parentSuite) {
                const response = await fetch(`/api/project/${activeProjectId}/next-display-id`);
                const { display_id } = await response.json();
                const newCase = { id: `case-${Date.now()}`, type: 'case', title: result.name, display_id, steps: { auto: [], nlp: [], playwright: [] } };
                if (!parentSuite.children) parentSuite.children = {};
                parentSuite.children[newCase.id] = newCase;
                refreshTestExplorer();
                await saveProjectData();
            }
        }
    } else if (action === 'rename') {
        const item = findItemById(id);
        const result = await showPrompt({ title: `Rename ${item.type}`, inputs: [{ key: 'name', value: item.title }] });
        if (result && result.name && result.name !== item.title) {
            item.title = result.name;
            refreshTestExplorer();
            await saveProjectData();
        }
    } else if (action === 'delete') {
        const item = findItemById(id);
        const confirmed = await showConfirm({ title: `Delete ${item.type}`, message: `Delete "${item.title}"?` });
        if (confirmed) {
            const parent = findParent(id);
            const collection = parent ? parent.children : testCasesData;
            delete collection[id];
            if (activeItemId === id) {
                activeItemId = null;
                renderTestCaseDetails(null);
            }
            refreshTestExplorer();
            await saveProjectData();
        }
    } else if (action === 'download-template') {
        window.location.href = '/api/template/download';
    } else if (action === 'import-csv') {
        importTargetSuiteId = id;
        DOMElements.csvImporter.click();
    } else if (action === 'copy-steps') {
        const response = await fetch(`/api/project/${activeProjectId}/case/${id}/copy_steps`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: activeStepsMode })
        });
        if (response.ok) {
            const result = await response.json();
            showToast(result.message, 'success');
            copiedStepsAvailable = true;
        } else {
            showToast('Failed to copy steps.', 'error');
        }
    } else if (action === 'paste-steps') {
         const response = await fetch(`/api/project/${activeProjectId}/case/${id}/paste_steps`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: activeStepsMode })
        });
         const result = await response.json();
         if (response.ok) {
            showToast(result.message, 'success');
            await loadProjectData();
            if(id === activeItemId){
                renderTestCaseDetails(findItemById(id));
            }
        } else {
            showToast(result.error || 'Failed to paste steps.', 'error');
        }
    }
}

async function uploadCsvFile(file) {
    if (!file || !importTargetSuiteId) return;
    const formData = new FormData();
    formData.append("file", file);
    showToast('Importing...', 'info');
    try {
        const response = await fetch(`/api/project/${activeProjectId}/suites/${importTargetSuiteId}/import`, { method: 'POST', body: formData });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        showToast(result.message, 'success');
        await loadProjectData();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function populateManualActionDropdowns() {
    for (const category in MANUAL_KEYWORDS) {
        const dropdownId = `${category.toLowerCase().replace(/\s+/g, '-')}-actions`;
        const dropdownElement = document.getElementById(dropdownId);
        if (dropdownElement) {
            dropdownElement.innerHTML = '';
            MANUAL_KEYWORDS[category].forEach(kw => {
                const button = document.createElement('button');
                button.textContent = kw.name;
                button.title = kw.tooltip;
                button.onclick = async () => {
                    const activeCase = findItemById(activeItemId);
                    if (!activeCase || activeCase.type !== 'case') {
                        showToast('Please select a test case first.', 'error');
                        return;
                    }
                    if (!activeCase.steps[activeStepsMode]) activeCase.steps[activeStepsMode] = [];
                    let newStep = {
                        id: `step-${Date.now()}`,
                        type: kw.type,
                        action: kw.action || '',
                        validation_type: kw.validation_type || '',
                        selector: '',
                        value: '',
                        expected_value: ''
                    };
                    if (kw.params.length > 0) {
                        const inputs = kw.params.map(p => ({ key: p, placeholder: `Enter value for "${p}"` }));
                        const result = await showPrompt({ title: `Parameters for ${kw.name}`, inputs });
                        if (!result) return;
                        for (const param of kw.params) {
                            const val = result[param];
                            if (['selector', 'source_selector', 'target_selector'].includes(param)) {
                                newStep.selector = (newStep.selector ? newStep.selector + '::' : '') + val;
                            } else if (kw.type === 'VALIDATION' || param === 'expected_value') {
                                newStep.expected_value = (newStep.expected_value ? newStep.expected_value + '::' : '') + val;
                            } else {
                                newStep.value = (newStep.value ? newStep.value + '::' : '') + val;
                            }
                        }
                    }
                    activeCase.steps[activeStepsMode].push(newStep);
                    renderSteps(activeCase.steps[activeStepsMode]);
                    hasUnsavedChanges = true;
                    dropdownElement.classList.remove('show');
                };
                dropdownElement.appendChild(button);
            });
        }
    }
}

function updateBulkActionsVisibility() {
    const selectedCount = DOMElements.stepsList.querySelectorAll('.step-checkbox:checked').length;
    DOMElements.bulkActionsFooter.classList.toggle('hidden', selectedCount === 0);
}

function setupEventListeners() {
    DOMElements.saveProjectBtn.addEventListener('click', saveProjectData);
    DOMElements.saveStepsBtn.addEventListener('click', saveProjectData);

    DOMElements.recordBtn.addEventListener('click', () => {
        if (websocket) stopRecording();
        else if (activeItemId) connectWebSocket();
        else showToast('Select a test case first.', 'error');
    });
    
    DOMElements.pauseBtn.addEventListener('click', () => {
        if (!websocket) return;
        const isPaused = DOMElements.pauseText.textContent === 'Resume';
        const type = isPaused ? 'resume_recording' : 'pause_recording';
        websocket.send(JSON.stringify({ type }));
        DOMElements.pauseText.textContent = isPaused ? 'Pause' : 'Resume';
        DOMElements.pauseBtn.classList.toggle('bg-yellow-500', isPaused);
        DOMElements.pauseBtn.classList.toggle('hover:bg-yellow-600', isPaused);
        DOMElements.pauseBtn.classList.toggle('bg-green-500', !isPaused);
        DOMElements.pauseBtn.classList.toggle('hover:bg-green-600', !isPaused);
    });

    DOMElements.testList.addEventListener('click', async (e) => {
        const itemDiv = e.target.closest('[data-id]');
        if (itemDiv) {
            if (hasUnsavedChanges) {
                const confirmed = await showConfirm({ title: "Unsaved Changes", message: "Switch without saving?" });
                if (!confirmed) return;
            }
            hasUnsavedChanges = false;
            activeItemId = itemDiv.dataset.id;
            refreshTestExplorer();
            renderTestCaseDetails(findItemById(activeItemId));
        }
    });
    
    DOMElements.testList.addEventListener('contextmenu', (e) => {
        const itemDiv = e.target.closest('[data-id]');
        const itemId = itemDiv ? itemDiv.dataset.id : null;
        showContextMenu(e, itemId);
    });

    DOMElements.stepsList.addEventListener('click', async (e) => {
        const editButton = e.target.closest('.edit-step-btn');
        if (editButton) {
            const stepId = editButton.dataset.stepId;
            const activeCase = findItemById(activeItemId);
            const step = activeCase.steps[activeStepsMode].find(s => s.id === stepId);
            if(step) {
                const result = await showPrompt({
                    title: 'Edit Step',
                    inputs: [
                        { key: 'selector', placeholder: 'Selector', value: step.selector },
                        { key: 'value', placeholder: 'Value', value: step.value || step.expected_value }
                    ]
                });
                if (result) {
                    step.selector = result.selector;
                    step.type === 'VALIDATION' ? step.expected_value = result.value : step.value = result.value;
                    renderSteps(activeCase.steps[activeStepsMode]);
                    hasUnsavedChanges = true;
                }
            }
        }
        
        const deleteButton = e.target.closest('.delete-step-btn');
        if (deleteButton) {
            const stepId = deleteButton.dataset.stepId;
             const confirmed = await showConfirm({title: 'Delete Step', message: 'Are you sure you want to delete this step?'});
            if (confirmed) {
                const activeCase = findItemById(activeItemId);
                activeCase.steps[activeStepsMode] = activeCase.steps[activeStepsMode].filter(s => s.id !== stepId);
                renderSteps(activeCase.steps[activeStepsMode]);
                hasUnsavedChanges = true;
            }
        }
        
        const duplicateButton = e.target.closest('.duplicate-step-btn');
        if(duplicateButton) {
             const stepId = duplicateButton.dataset.stepId;
            const activeCase = findItemById(activeItemId);
            const stepIndex = activeCase.steps[activeStepsMode].findIndex(s => s.id === stepId);
            if (stepIndex > -1) {
                const originalStep = activeCase.steps[activeStepsMode][stepIndex];
                const duplicatedStep = JSON.parse(JSON.stringify(originalStep)); // Deep copy
                duplicatedStep.id = `step-${Date.now()}`;
                activeCase.steps[activeStepsMode].splice(stepIndex + 1, 0, duplicatedStep);
                renderSteps(activeCase.steps[activeStepsMode]);
                hasUnsavedChanges = true;
            }
        }
    });

    DOMElements.contextMenu.addEventListener('click', handleContextMenuAction);
    document.addEventListener('click', (e) => {
        if (!DOMElements.contextMenu.contains(e.target)) hideContextMenu();
    });

    DOMElements.csvImporter.addEventListener('change', (e) => uploadCsvFile(e.target.files[0]));

    let isResizing = false;
    const handleMouseMove = (e) => {
        if (!isResizing) return;
        const newWidth = e.clientX;
        if (newWidth > 300 && newWidth < window.innerWidth * 0.75) {
            DOMElements.sidebar.style.width = `${newWidth}px`;
        }
    };
    const stopResizing = () => {
        isResizing = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', stopResizing);
    };
    DOMElements.resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isResizing = true;
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', stopResizing);
    });

    window.addEventListener('beforeunload', (event) => {
        if (hasUnsavedChanges) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
    
    // Bulk actions
    DOMElements.selectAllSteps.addEventListener('change', (e) => {
        DOMElements.stepsList.querySelectorAll('.step-checkbox').forEach(checkbox => {
            checkbox.checked = e.target.checked;
        });
        updateBulkActionsVisibility();
    });

    DOMElements.deleteAllStepsBtn.addEventListener('click', async () => {
        const activeCase = findItemById(activeItemId);
        if (activeCase) {
             const confirmed = await showConfirm({title: 'Delete All Steps', message: `Delete all steps for '${activeStepsMode}' mode?`});
             if(confirmed) {
                activeCase.steps[activeStepsMode] = [];
                renderSteps([]);
                hasUnsavedChanges = true;
             }
        }
    });
    
    DOMElements.deleteSelectedBtn.addEventListener('click', async () => {
        const selectedIds = Array.from(DOMElements.stepsList.querySelectorAll('.step-checkbox:checked')).map(cb => cb.dataset.stepId);
        if (selectedIds.length > 0) {
             const confirmed = await showConfirm({title: 'Delete Selected', message: `Delete ${selectedIds.length} selected steps?`});
            if (confirmed) {
                const activeCase = findItemById(activeItemId);
                activeCase.steps[activeStepsMode] = activeCase.steps[activeStepsMode].filter(step => !selectedIds.includes(step.id));
                renderSteps(activeCase.steps[activeStepsMode]);
                hasUnsavedChanges = true;
            }
        }
    });
    
    DOMElements.tabsContainer.addEventListener('click', (e) => {
        const tabButton = e.target.closest('.tab-btn');
        if (!tabButton) return;

        // Update button styles
        DOMElements.tabsContainer.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('border-blue-500', 'text-gray-300');
            btn.classList.add('border-transparent', 'text-gray-500');
        });
        tabButton.classList.remove('border-transparent', 'text-gray-500');
        tabButton.classList.add('border-blue-500', 'text-gray-300');

        // Show/hide tab content
        const tabName = tabButton.dataset.tab;
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('hidden', content.id !== `tab-content-${tabName}`);
        });
    });
    
    document.querySelectorAll('.toolbar-button').forEach(button => {
        button.addEventListener('click', (e) => {
            const menuId = button.dataset.menu;
            const dropdown = document.getElementById(menuId);
            
            // Close other open dropdowns
            document.querySelectorAll('.toolbar-dropdown.show').forEach(openDropdown => {
                if (openDropdown !== dropdown) {
                    openDropdown.classList.remove('show');
                }
            });

            // Toggle current dropdown
            dropdown.classList.toggle('show');
            e.stopPropagation();
        });
    });

    // Close dropdowns if clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.toolbar-menu')) {
            document.querySelectorAll('.toolbar-dropdown.show').forEach(openDropdown => {
                openDropdown.classList.remove('show');
            });
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    loadProjectData();
    populateManualActionDropdowns();
    setupEventListeners();
});
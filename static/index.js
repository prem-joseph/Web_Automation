// --- Global State ---
let importTargetProjectId = null;
let selectedProjectIdForModeSelection = null;

// --- DOM Elements ---
const DOMElements = {
    projectList: document.getElementById('project-list'),
    newProjectBtn: document.getElementById('new-project-btn'),
    // Modals
    modalBackdrop: document.getElementById('modal-backdrop'),
    modeModal: document.getElementById('mode-modal'),
    modeModalContent: document.getElementById('mode-modal-content'),
    modeCloseBtn: document.getElementById('mode-close-btn'),
    importModal: document.getElementById('import-modal'),
    importProjectName: document.getElementById('import-project-name'),
    importTrProjectSelect: document.getElementById('import-tr-project'),
    suiteSelectorDiv: document.getElementById('suite-selector-div'),
    importTrSuiteSelect: document.getElementById('import-tr-suite'),
    importCancelBtn: document.getElementById('import-cancel-btn'),
    importConfirmBtn: document.getElementById('import-confirm-btn'),
    // Generic Modals
    promptModal: document.getElementById('prompt-modal'),
    promptTitle: document.getElementById('prompt-title'),
    promptInput: document.getElementById('prompt-input'),
    promptCancelBtn: document.getElementById('prompt-cancel-btn'),
    promptConfirmBtn: document.getElementById('prompt-confirm-btn'),
    confirmModal: document.getElementById('confirm-modal'),
    confirmTitle: document.getElementById('confirm-title'),
    confirmMessage: document.getElementById('confirm-message'),
    confirmCancelBtn: document.getElementById('confirm-cancel-btn'),
    confirmOkBtn: document.getElementById('confirm-ok-btn'),
    // Toast
    toast: document.getElementById('toast'),
};

const modeSettings = {
    auto: { text: 'Automated recording using Selenium & Xpath', class: 'bg-blue-600 hover:bg-blue-700' },
    nlp: { text: 'NLP-driven Recording', class: 'bg-purple-600 hover:bg-purple-700' },
    playwright: { text: 'Playwright Recording', class: 'bg-teal-600 hover:bg-teal-700' }
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
    DOMElements.modeModal.classList.add('hidden');
    DOMElements.importModal.classList.add('hidden');
    DOMElements.promptModal.classList.add('hidden');
    DOMElements.confirmModal.classList.add('hidden');
}

function showPrompt(title, value = '') {
    return new Promise(resolve => {
        DOMElements.promptTitle.textContent = title;
        DOMElements.promptInput.value = value;
        showModal(DOMElements.promptModal);

        const onConfirm = () => {
            cleanup();
            resolve(DOMElements.promptInput.value);
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

function showConfirm(title, message) {
     return new Promise(resolve => {
        DOMElements.confirmTitle.textContent = title;
        DOMElements.confirmMessage.textContent = message;
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


// --- Core Functions ---

async function loadProjects() {
    try {
        const response = await fetch('/api/projects');
        if (!response.ok) throw new Error('Failed to fetch projects');
        const projects = await response.json();

        DOMElements.projectList.innerHTML = ''; // Clear existing projects
        if (projects.length === 0) {
            DOMElements.projectList.innerHTML = `<p class="text-gray-500 col-span-full text-center">No projects found. Click 'New Project' to get started.</p>`;
        } else {
            projects.forEach(p => {
                const card = document.createElement('div');
                card.className = 'bg-gray-800 p-6 rounded-lg shadow-lg flex flex-col';
                card.innerHTML = `
                    <div class="flex-grow">
                        <h2 class="text-xl font-bold text-white mb-2">${p.name}</h2>
                        <div class="flex items-center text-sm text-gray-400 mb-2">
                            <i class="fas fa-folder-tree fa-fw mr-2"></i>
                            <span>${p.suite_count} Test Suites</span>
                        </div>
                        <div class="flex items-center text-sm text-gray-400 mb-4">
                            <i class="fas fa-file-alt fa-fw mr-2"></i>
                            <span>${p.case_count} Test Cases</span>
                        </div>
                        <p class="text-xs text-gray-500">Created: ${new Date(p.created_at).toLocaleDateString()}</p>
                    </div>
                    <div class="mt-4 pt-4 border-t border-gray-700 flex justify-between items-center">
                        <button data-project-id="${p.id}" class="load-project-btn bg-gray-700 hover:bg-gray-600 text-white font-semibold py-2 px-4 rounded-md text-center">Load Project</button>
                        <div class="flex gap-2">
                            <button data-project-id="${p.id}" data-project-name="${p.name}" class="import-from-tms-btn text-purple-400 hover:text-purple-300 px-2 py-1 rounded-md" title="Import from TestRail"><i class="fas fa-cloud-download-alt"></i></button>
                            <button data-project-id="${p.id}" data-project-name="${p.name}" class="edit-project-btn text-blue-400 hover:text-blue-300 px-2 py-1 rounded-md" title="Rename Project"><i class="fas fa-edit"></i></button>
                            <button data-project-id="${p.id}" class="delete-project-btn text-red-400 hover:text-red-300 px-2 py-1 rounded-md" title="Delete Project"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>`;
                DOMElements.projectList.appendChild(card);
            });
        }
    } catch (error) {
        DOMElements.projectList.innerHTML = `<p class="text-red-500">Error loading projects: ${error.message}</p>`;
    }
}

function getEnabledModes() {
    const savedModes = localStorage.getItem('enabledRecordingModes');
    return savedModes ? JSON.parse(savedModes) : { auto: true, nlp: true, playwright: true };
}

function showModeSelectionModal(projectId) {
    selectedProjectIdForModeSelection = projectId;
    const enabledModes = getEnabledModes();
    DOMElements.modeModalContent.innerHTML = '';

    Object.keys(enabledModes).forEach(mode => {
        if (enabledModes[mode]) {
            const button = document.createElement('button');
            button.id = `mode-${mode}`;
            button.textContent = modeSettings[mode].text;
            button.className = `${modeSettings[mode].class} text-white font-bold py-3 px-6 rounded-md w-full`;
            button.onclick = () => {
                window.location.href = `/designer/${selectedProjectIdForModeSelection}?mode=${mode}`;
            };
            DOMElements.modeModalContent.appendChild(button);
        }
    });

    showModal(DOMElements.modeModal);
}

// --- Event Handlers ---

async function handleNewProjectClick() {
    const newName = await showPrompt('Enter new project name:');
    if (newName) {
        try {
            const response = await fetch('/api/projects/new', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName })
            });
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Failed to create project');
            }
            await loadProjects();
            showToast(`Project '${newName}' created successfully!`, 'success');
        } catch (error) {
            showToast(`Error: ${error.message}`, 'error');
        }
    }
}

async function handleProjectListClick(e) {
    const loadBtn = e.target.closest('.load-project-btn');
    const importBtn = e.target.closest('.import-from-tms-btn');
    const editBtn = e.target.closest('.edit-project-btn');
    const deleteBtn = e.target.closest('.delete-project-btn');

    if (loadBtn) {
        showModeSelectionModal(loadBtn.dataset.projectId);
    } else if (importBtn) {
        handleImportFromTMSClick(importBtn.dataset.projectId, importBtn.dataset.projectName);
    } else if (editBtn) {
        handleEditProjectClick(editBtn.dataset.projectId, editBtn.dataset.projectName);
    } else if (deleteBtn) {
        handleDeleteProjectClick(deleteBtn.dataset.projectId);
    }
}

async function handleEditProjectClick(projectId, currentName) {
    const newName = await showPrompt('Enter new project name:', currentName);
    if (newName && newName !== currentName) {
        try {
            const response = await fetch(`/api/projects/${projectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName })
            });
            if (!response.ok) throw new Error('Failed to rename project');
            await loadProjects();
            showToast('Project renamed!', 'success');
        } catch(error) {
            showToast(`Error: ${error.message}`, 'error');
        }
    }
}

async function handleDeleteProjectClick(projectId) {
    const confirmed = await showConfirm(
        'Delete Project',
        'Are you sure you want to delete this project and all its contents? This cannot be undone.'
    );
    if (confirmed) {
        try {
            const response = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
            if (!response.ok) throw new Error('Failed to delete project');
            await loadProjects();
            showToast('Project deleted successfully.', 'success');
        } catch (error) {
            showToast(`Error: ${error.message}`, 'error');
        }
    }
}


// --- TestRail Import Logic ---

async function handleImportFromTMSClick(projectId, projectName) {
    importTargetProjectId = projectId;
    DOMElements.importProjectName.textContent = projectName;
    showModal(DOMElements.importModal);

    const trProjectSelect = DOMElements.importTrProjectSelect;
    trProjectSelect.innerHTML = '<option>Loading...</option>';
    try {
        const response = await fetch('/api/tms/projects');
        if (response.ok) {
            const projects = await response.json();
            trProjectSelect.innerHTML = '<option value="">-- Select a Project --</option>';
            projects.forEach(p => trProjectSelect.add(new Option(p.name, p.id)));
        } else {
            const err = await response.json();
            showToast('Could not load TestRail projects: ' + (err.error || 'Configuration missing'), 'error');
            trProjectSelect.innerHTML = `<option>${err.error || 'Could not load projects'}</option>`;
        }
    } catch(e) {
         showToast('Could not load TestRail projects: ' + e.message, 'error');
         trProjectSelect.innerHTML = '<option>Error loading projects</option>';
    }
}

function populateSuiteOptions(suites, selectElement, indent = 0) {
    suites.forEach(suite => {
        const option = document.createElement('option');
        option.value = suite.id;
        option.innerHTML = '&nbsp;&nbsp;'.repeat(indent * 2) + (indent > 0 ? '&#9492;&nbsp;' : '') + suite.name;
        selectElement.appendChild(option);
        if (suite.children && suite.children.length > 0) {
            populateSuiteOptions(suite.children, selectElement, indent + 1);
        }
    });
}

async function handleTrProjectChange(e) {
    const projectId = e.target.value;
    const suiteDiv = DOMElements.suiteSelectorDiv;
    const suiteSelect = DOMElements.importTrSuiteSelect;
    const confirmBtn = DOMElements.importConfirmBtn;

    if (!projectId) {
        suiteDiv.classList.add('hidden');
        confirmBtn.disabled = true;
        return;
    }
    suiteDiv.classList.remove('hidden');
    suiteSelect.innerHTML = '<option>Loading...</option>';
    try {
        const response = await fetch(`/api/tms/projects/${projectId}/suites`);
        if (response.ok) {
            const suites = await response.json();
            suiteSelect.innerHTML = '<option value="">-- Select a Suite --</option>';
            populateSuiteOptions(suites, suiteSelect);
            confirmBtn.disabled = true;
        } else {
            const err = await response.json();
            throw new Error(err.error || 'Failed to load suites');
        }
    } catch (error) {
        suiteSelect.innerHTML = '<option>Could not load suites</option>';
        showToast(`Error: ${error.message}`, 'error');
    }
}

async function handleImportConfirmClick() {
    const suiteId = DOMElements.importTrSuiteSelect.value;
    const trProjectId = DOMElements.importTrProjectSelect.value;
    if (!suiteId || !importTargetProjectId || !trProjectId) return;
    
    DOMElements.importConfirmBtn.disabled = true;
    DOMElements.importConfirmBtn.textContent = 'Importing...';

    try {
        const response = await fetch(`/api/tms/import/project/${importTargetProjectId}/tr_project/${trProjectId}/suite/${suiteId}`, { method: 'POST' });
        if (response.ok) {
            const result = await response.json();
            showToast(result.message, 'success');
            hideModals();
            await loadProjects();
        } else {
            const err = await response.json();
            throw new Error(err.error || 'Failed to import cases');
        }
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    } finally {
        DOMElements.importConfirmBtn.disabled = false;
        DOMElements.importConfirmBtn.textContent = 'Import';
    }
}


// --- Event Listener Setup ---

document.addEventListener('DOMContentLoaded', () => {
    loadProjects();

    // Main page actions
    DOMElements.newProjectBtn.addEventListener('click', handleNewProjectClick);
    DOMElements.projectList.addEventListener('click', handleProjectListClick);

    // Modal close buttons
    DOMElements.modeCloseBtn.addEventListener('click', hideModals);
    DOMElements.importCancelBtn.addEventListener('click', hideModals);

    // Import modal logic
    DOMElements.importTrProjectSelect.addEventListener('change', handleTrProjectChange);
    DOMElements.importTrSuiteSelect.addEventListener('change', (e) => {
        DOMElements.importConfirmBtn.disabled = !e.target.value;
    });
    DOMElements.importConfirmBtn.addEventListener('click', handleImportConfirmClick);
});
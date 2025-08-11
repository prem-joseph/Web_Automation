import os
import uvicorn
import json
import uuid
import time
import sqlite3
import asyncio
import threading
import csv
import io
import requests
import re
import shutil
import tempfile
import traceback
from urllib.parse import urlparse, urlunparse, urljoin
import base64
from datetime import datetime

# CORRECTED: Import the async version of Playwright
from playwright.async_api import async_playwright, Error as PlaywrightError
import multiprocessing as mp
import subprocess
import sys
from jinja2 import Environment, FileSystemLoader

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError
from typing import List, Dict, Any, Optional
from dotenv import load_dotenv

from selenium import webdriver
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.common.by import By
from selenium.common.exceptions import WebDriverException, StaleElementReferenceException, TimeoutException, NoSuchElementException
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import Select

# Import for reporting
from xhtml2pdf import pisa

load_dotenv()

# =============================================================================
# 1. CORE LOGIC (Database & Recorder)
# =============================================================================

CONFIG = {
    "MASTER_DB_NAME": "master_test_recorder.db",
    "PROJECTS_BASE_FOLDER": "Test_Projects",
    "REPORTS_BASE_FOLDER": "reports"
}
# Create reports directory if it doesn't exist
os.makedirs(CONFIG["REPORTS_BASE_FOLDER"], exist_ok=True)


clipboard = {
    "steps": [],
    "mode": None
}

JS_RECORDER_SCRIPT = """
function getXPath(element) {
    if (element.id !== '') {
        const elems = document.querySelectorAll(`#${element.id}`);
        if (elems.length === 1) return `//*[@id='${element.id}']`;
    }
    if (element === document.body) return '/html/body';
    if (element.parentNode === null) return `/${element.tagName.toLowerCase()}`;
    let ix = 0;
    const siblings = element.parentNode.childNodes;
    for (let i = 0; i < siblings.length; i++) {
        const sibling = siblings[i];
        if (sibling === element) return getXPath(element.parentNode) + '/' + element.tagName.toLowerCase() + '[' + (ix + 1) + ']';
        if (sibling.nodeType === 1 && sibling.tagName === element.tagName) ix++;
    }
    return '';
}
function sleep(ms) { const start = Date.now(); while (Date.now() < start + ms); }
document.addEventListener('mousedown', function(e) {
    const xpath = getXPath(e.target);
    window.top.document.title = `RECORDER_ACTION::CLICK::${xpath}`;
    sleep(200);
}, true);
document.addEventListener('input', function(e) {
    if (e.target.tagName.toLowerCase() === 'input' || e.target.tagName.toLowerCase() === 'textarea') {
        const xpath = getXPath(e.target);
        window.top.document.title = `RECORDER_ACTION::TYPE::${xpath}::${e.target.value}`;
    }
}, true);
document.addEventListener('change', function(e) {
    if (e.target.tagName.toLowerCase() === 'select') {
        const xpath = getXPath(e.target);
        window.top.document.title = `RECORDER_ACTION::SELECT::${xpath}::${e.target.value}`;
    }
}, true);
document.addEventListener('keydown', function(e) {
    const specialKeys = ['Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'];
    if (specialKeys.includes(e.key)) {
        const xpath = getXPath(document.activeElement);
        window.top.document.title = `RECORDER_ACTION::KEYPRESS::${xpath}::${e.key}`;
    }
}, true);
"""

# --- CORRECTED: Async Playwright Recorder Process ---
async def async_playwright_recorder_process(url: str, message_queue: mp.Queue):
    """Async function to run Playwright for recording."""
    try:
        message_queue.put({"type": "status", "data": "Initializing Playwright..."})
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=False, args=["--start-maximized"])
            context = await browser.new_context(no_viewport=True)
            page = await context.new_page()

            if url:
                try:
                    await page.goto(url, timeout=30000)
                except PlaywrightError as e:
                    message_queue.put({"type": "status", "data": f"Could not navigate to URL: {e}"})

            message_queue.put({"type": "status", "data": "Playwright Inspector is active. Please record your steps."})
            await page.pause()
            print("Playwright recording session finished by user.")

    except Exception as e:
        error_msg = f"Playwright error: {e}"
        print(error_msg)
        message_queue.put({"type": "status", "data": error_msg})
    finally:
        message_queue.put({"type": "status", "data": "Playwright session ended."})
        message_queue.put({"type": "control", "data": "close"})

def playwright_recorder_wrapper(url: str, message_queue: mp.Queue):
    """Wrapper to run the async function in a new event loop for the subprocess."""
    asyncio.run(async_playwright_recorder_process(url, message_queue))


class PlaywrightRecorderThread(threading.Thread):
    """Handles Playwright interaction for recording steps."""
    def __init__(self, url: str, websocket: WebSocket, loop: asyncio.AbstractEventLoop):
        super().__init__()
        self.url = url
        self.websocket = websocket
        self.loop = loop
        self.stop_event = threading.Event()
        self.process = None
        self.message_queue = mp.Queue()

    def stop(self):
        self.stop_event.set()
        if self.process and self.process.is_alive():
            self.process.terminate()

    def send_message_to_ws(self, message: Dict):
        if not self.loop.is_closed():
            asyncio.run_coroutine_threadsafe(self.websocket.send_json(message), self.loop)

    def run(self):
        # Use the wrapper function for the multiprocessing target
        self.process = mp.Process(target=playwright_recorder_wrapper, args=(self.url, self.message_queue))
        self.process.start()

        while not self.stop_event.is_set():
            try:
                message = self.message_queue.get(timeout=1)
                if message.get("type") == "control" and message.get("data") == "close":
                    break
                self.send_message_to_ws(message)
            except (mp.queues.Empty, EOFError):
                continue

        if self.process:
            self.process.join()

        if self.websocket and not self.loop.is_closed():
            try:
                asyncio.run_coroutine_threadsafe(self.websocket.close(), self.loop)
            except Exception as e:
                print(f"Error closing websocket in recorder thread: {e}")

        print("Playwright recorder thread finished.")


class DatabaseManager:
    """Handles all SQLite database operations."""
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.conn = None
        self.connect()
        print(f"INFO: Database connected at {os.path.abspath(self.db_path)}")

    def connect(self):
        try:
            self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA foreign_keys = ON;")
            self.create_tables()
            self.migrate_tables()
        except sqlite3.Error as e:
            print(f"Database connection error: {e}")
            raise

    def migrate_tables(self):
        cursor = self.conn.cursor()
        cursor.execute("PRAGMA table_info(test_steps)")
        columns = [row['name'] for row in cursor.fetchall()]
        if 'mode' not in columns:
            print("Migrating test_steps table: Adding 'mode' column.")
            cursor.execute("ALTER TABLE test_steps ADD COLUMN mode TEXT")
            self.conn.commit()

        cursor.execute("PRAGMA table_info(test_items)")
        columns = [row['name'] for row in cursor.fetchall()]
        if 'playwright_script' not in columns:
            print("Migrating test_items table: Adding 'playwright_script' column.")
            cursor.execute("ALTER TABLE test_items ADD COLUMN playwright_script TEXT")
            self.conn.commit()
            
        cursor.execute("PRAGMA table_info(runner_logs)")
        columns = [row['name'] for row in cursor.fetchall()]
        if 'report_generated' not in columns:
            print("Migrating runner_logs table: Adding 'report_generated' column.")
            cursor.execute("ALTER TABLE runner_logs ADD COLUMN report_generated INTEGER DEFAULT 0")
            self.conn.commit()


    def create_tables(self):
        cursor = self.conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL, created_at TEXT NOT NULL
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS test_items (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, item_type TEXT NOT NULL,
                title TEXT NOT NULL, display_id TEXT, preconditions TEXT, manual_steps TEXT,
                expected_result TEXT, url TEXT, item_order INTEGER, playwright_script TEXT,
                FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS test_steps (
                id TEXT PRIMARY KEY, case_id TEXT NOT NULL, step_type TEXT NOT NULL,
                data TEXT NOT NULL, step_order INTEGER NOT NULL, mode TEXT,
                FOREIGN KEY (case_id) REFERENCES test_items (id) ON DELETE CASCADE
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS playback_staging_logs (
                id TEXT PRIMARY KEY,
                case_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                log_data TEXT NOT NULL,
                FOREIGN KEY (case_id) REFERENCES test_items (id) ON DELETE CASCADE
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS runner_logs (
                id TEXT PRIMARY KEY,
                case_id TEXT NOT NULL,
                run_id TEXT NOT NULL, 
                timestamp TEXT NOT NULL,
                log_data TEXT NOT NULL,
                status TEXT,
                report_generated INTEGER DEFAULT 0,
                FOREIGN KEY (case_id) REFERENCES test_items (id) ON DELETE CASCADE
            )
        ''')
        self.conn.commit()

    def add_playback_staging_log(self, case_id: str, log_data: List[str]):
        with self.conn:
            cursor = self.conn.cursor()
            log_id = f"log-{uuid.uuid4().hex[:8]}"
            timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
            log_json = json.dumps(log_data)
            cursor.execute("INSERT INTO playback_staging_logs (id, case_id, timestamp, log_data) VALUES (?, ?, ?, ?)",
                           (log_id, case_id, timestamp, log_json))
            cursor.execute('''DELETE FROM playback_staging_logs WHERE id IN (SELECT id FROM playback_staging_logs WHERE case_id = ? ORDER BY timestamp DESC LIMIT -1 OFFSET 2)''', (case_id,))

    def add_runner_log(self, case_id: str, run_id: str, log_data: List[str], status: str):
        with self.conn:
            cursor = self.conn.cursor()
            log_id = f"rlog-{uuid.uuid4().hex[:8]}"
            timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
            log_json = json.dumps(log_data)
            cursor.execute("INSERT INTO runner_logs (id, case_id, run_id, timestamp, log_data, status) VALUES (?, ?, ?, ?, ?, ?)",
                           (log_id, case_id, run_id, timestamp, log_json, status))
            cursor.execute('''DELETE FROM runner_logs WHERE run_id IN (SELECT DISTINCT run_id FROM runner_logs WHERE case_id = ? ORDER BY timestamp DESC LIMIT -1 OFFSET 3) AND case_id = ?''', (case_id, case_id))

    def mark_run_report_generated(self, run_id: str):
        with self.conn:
            cursor = self.conn.cursor()
            cursor.execute("UPDATE runner_logs SET report_generated = 1 WHERE run_id = ?", (run_id,))
            print(f"INFO: Marked run {run_id} as report_generated.")

    def get_playback_staging_logs(self, case_id: str):
        cursor = self.conn.cursor()
        cursor.execute("SELECT * FROM playback_staging_logs WHERE case_id = ? ORDER BY timestamp DESC", (case_id,))
        logs = []
        for row in cursor.fetchall():
            log_item = dict(row)
            try:
                log_item['log_data'] = json.loads(log_item['log_data'])
            except (json.JSONDecodeError, TypeError):
                log_item['log_data'] = [log_item['log_data']]
            logs.append(log_item)
        return logs

    def get_runner_logs(self, project_id: str):
        cursor = self.conn.cursor()
        cursor.execute('''
            SELECT rl.* FROM runner_logs rl
            JOIN test_items ti ON rl.case_id = ti.id
            WHERE ti.project_id = ?
            ORDER BY rl.timestamp DESC
        ''', (project_id,))
        
        runs = {}
        for row in cursor.fetchall():
            run_id = row['run_id']
            if run_id not in runs:
                runs[run_id] = {
                    "run_id": run_id,
                    "timestamp": row['timestamp'],
                    "report_generated": bool(row['report_generated']),
                    "cases": []
                }
            
            log_item = dict(row)
            try:
                log_item['log_data'] = json.loads(log_item['log_data'])
            except (json.JSONDecodeError, TypeError):
                log_item['log_data'] = [log_item['log_data']]
            
            runs[run_id]["cases"].append(log_item)

        sorted_runs = sorted(runs.values(), key=lambda x: x['timestamp'], reverse=True)
        return sorted_runs


    def get_all_projects_with_summary(self):
        """Gets all projects and includes a count of their suites and cases."""
        cursor = self.conn.cursor()
        cursor.execute("SELECT id, name, path, created_at FROM projects ORDER BY created_at DESC")
        projects = [dict(row) for row in cursor.fetchall()]

        if not projects:
            print("DEBUG (DB): No projects found in the database.")
            return []

        cursor.execute("SELECT project_id, item_type, COUNT(*) as count FROM test_items GROUP BY project_id, item_type")
        counts = cursor.fetchall()

        summary_map = {}
        for row in counts:
            pid = row['project_id']
            if pid not in summary_map:
                summary_map[pid] = {'suite_count': 0, 'case_count': 0}
            if row['item_type'] == 'suite':
                summary_map[pid]['suite_count'] = row['count']
            elif row['item_type'] == 'case':
                summary_map[pid]['case_count'] = row['count']

        for project in projects:
            project_summary = summary_map.get(project['id'], {'suite_count': 0, 'case_count': 0})
            project.update(project_summary)

        print(f"DEBUG (DB): Found {len(projects)} project(s).")
        return projects


    def create_project(self, name: str):
        project_id = f"proj-{uuid.uuid4().hex[:6]}"
        path = os.path.join(CONFIG["PROJECTS_BASE_FOLDER"], name.replace(" ", "_"))
        created_at = time.strftime("%Y-%m-%d %H:%M:%S")
        cursor = self.conn.cursor()
        try:
            cursor.execute("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)",
                           (project_id, name, path, created_at))
            self.conn.commit()
            os.makedirs(path, exist_ok=True)
            return {"id": project_id, "name": name, "path": path, "created_at": created_at}
        except sqlite3.IntegrityError:
            raise ValueError(f"A project with the name '{name}' already exists.")

    def rename_project(self, project_id: str, new_name: str):
        cursor = self.conn.cursor()
        cursor.execute("UPDATE projects SET name = ? WHERE id = ?", (new_name, project_id))
        self.conn.commit()

    def delete_project(self, project_id: str):
        cursor = self.conn.cursor()
        cursor.execute("SELECT path FROM projects WHERE id = ?", (project_id,))
        row = cursor.fetchone()
        if row and row['path'] and os.path.exists(row['path']):
            shutil.rmtree(row['path'])

        cursor.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        self.conn.commit()


    def get_tc_number(self, display_id_str: str) -> int:
        if not display_id_str:
            return 9999999
        nums = re.findall(r'\d+', display_id_str)
        return int(nums[0]) if nums else 9999999

    def get_project_hierarchy(self, project_id: str) -> Dict[str, Any]:
        cursor = self.conn.cursor()
        cursor.execute("SELECT name FROM projects WHERE id = ?", (project_id,))
        project_row = cursor.fetchone()
        project_name = project_row['name'] if project_row else "Unknown Project"

        cursor.execute("SELECT * FROM test_items WHERE project_id = ? ORDER BY item_order", (project_id,))
        items = {row['id']: dict(row) for row in cursor.fetchall()}
        cursor.execute("SELECT ts.* FROM test_steps ts JOIN test_items ti ON ts.case_id = ti.id WHERE ti.project_id = ? ORDER BY ts.step_order", (project_id,))

        steps_by_case = {}
        for row in cursor.fetchall():
            case_id = row['case_id']
            mode = row['mode'] or 'auto'
            if case_id not in steps_by_case:
                steps_by_case[case_id] = {'auto': [], 'nlp': [], 'playwright': []}

            step_data = json.loads(row['data'])
            step_data['id'] = row['id']
            steps_by_case[case_id][mode].append(step_data)

        tree = {}
        for item_id, item_data in items.items():
            item_data['type'] = item_data.pop('item_type')
            if item_data['type'] == 'case':
                item_data['steps'] = steps_by_case.get(item_id, {'auto': [], 'nlp': [], 'playwright': []})
            if item_data['type'] == 'suite':
                item_data['children'] = {}
            if item_data['parent_id']:
                parent = items.get(item_data['parent_id'])
                if parent:
                    if 'children' not in parent: parent['children'] = {}
                    parent['children'][item_id] = item_data
            else:
                tree[item_id] = item_data

        return {"name": project_name, "hierarchy": tree}

    def save_project_hierarchy(self, project_id: str, test_cases_data: Dict[str, Any]):
        cursor = self.conn.cursor()
        try:
            with self.conn:
                cursor.execute("DELETE FROM test_steps WHERE case_id IN (SELECT id FROM test_items WHERE project_id = ?)", (project_id,))
                cursor.execute("DELETE FROM test_items WHERE project_id = ?", (project_id,))

                def sort_key(item):
                    is_suite = 1 if item['type'] == 'suite' else 2
                    if is_suite == 1:
                        return (is_suite, item.get('title', '').lower())
                    else:
                        return (is_suite, self.get_tc_number(item.get('display_id', '')))

                def insert_items(items, parent_id=None):
                    sorted_items = sorted(items.values(), key=sort_key)
                    for order, item_data in enumerate(sorted_items):
                        item_id = item_data['id']
                        cursor.execute('''
                            INSERT INTO test_items (id, project_id, parent_id, item_type, title, display_id, preconditions, manual_steps, expected_result, url, item_order, playwright_script)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ''', (item_id, project_id, parent_id, item_data['type'], item_data['title'], item_data.get('display_id'),
                              item_data.get('preconditions'), item_data.get('manual_steps'), item_data.get('expected_result'),
                              item_data.get('url'), order, item_data.get('playwright_script')))
                        if item_data['type'] == 'case':
                            for mode, steps in item_data.get('steps', {}).items():
                                for step_order, step_data in enumerate(steps):
                                    step_id = step_data.get('id', str(uuid.uuid4()))
                                    cursor.execute('INSERT INTO test_steps (id, case_id, step_type, data, step_order, mode) VALUES (?, ?, ?, ?, ?, ?)',
                                                   (step_id, item_id, step_data['type'], json.dumps(step_data), step_order, mode))
                        if item_data.get('children'):
                            insert_items(item_data['children'], item_id)
                insert_items(test_cases_data)
        except sqlite3.Error as e:
            print(f"Database save failed: {e}")
            raise

    def get_next_display_id(self, project_id: str) -> str:
        """Generates the next sequential display ID for a new test case."""
        cursor = self.conn.cursor()
        cursor.execute("SELECT display_id FROM test_items WHERE project_id = ? AND item_type = 'case'", (project_id,))

        max_num = 0
        for row in cursor.fetchall():
            display_id = row['display_id']
            if display_id:
                nums = re.findall(r'\d+', display_id)
                if nums:
                    max_num = max(max_num, int(nums[0]))

        return f"TC-{max_num + 1}"


class RecorderThread(threading.Thread):
    """Handles Selenium interaction for recording steps in a separate thread."""
    def __init__(self, url: str, websocket: WebSocket, loop: asyncio.AbstractEventLoop, mode: str):
        super().__init__()
        self.url = url
        self.websocket = websocket
        self.loop = loop
        self.mode = mode
        self.driver = None
        self.stop_event = threading.Event()
        self.pause_event = threading.Event()
        self.pause_event.set()
        self.original_title = ""
        self.last_known_url = url

        self.last_typing_step = None
        self.typing_timer = None

    def stop(self):
        self.stop_event.set()
        self.pause_event.set()
        if self.typing_timer:
            self.typing_timer.cancel()

    def pause(self):
        self.pause_event.clear()
        self.send_message_to_ws({"type": "status", "data": "Recording paused."})

    def resume(self):
        self.pause_event.set()
        self.send_message_to_ws({"type": "status", "data": "Recording resumed."})

    def send_message_to_ws(self, message: Dict):
        if not self.loop.is_closed():
            asyncio.run_coroutine_threadsafe(self.websocket.send_json(message), self.loop)

    def _flush_typing_step(self):
        if self.typing_timer:
            self.typing_timer.cancel()
            self.typing_timer = None
        if self.last_typing_step:
            self.send_message_to_ws({"type": "step", "data": self.last_typing_step, "mode": self.mode})
            self.last_typing_step = None

    def run(self):
        service = None
        try:
            self.send_message_to_ws({"type": "status", "data": "Initializing browser..."})
            options = ChromeOptions()
            options.add_experimental_option("detach", True)

            try:
                service = ChromeService()
            except WebDriverException as e:
                error_message = ("Could not start ChromeDriver. "
                                 "Please ensure 'chromedriver' is in your system's PATH. "
                                 f"Error: {e}")
                self.send_message_to_ws({"type": "status", "data": error_message})
                return

            self.driver = webdriver.Chrome(service=service, options=options)
            self.driver.maximize_window()

            initial_step = {
                "id": f"step-{uuid.uuid4().hex[:6]}",
                "type": "ACTION",
                "action": "NAVIGATE",
                "selector": "",
                "value": self.url
            }
            self.send_message_to_ws({"type": "step", "data": initial_step, "mode": self.mode})

            self.driver.get(self.url)
            self.last_known_url = self.driver.current_url

            time.sleep(1)
            self.original_title = self.driver.title

            self.send_message_to_ws({"type": "status", "data": "Injecting recorder script..."})
            self.driver.execute_script(JS_RECORDER_SCRIPT)

            self.send_message_to_ws({"type": "status", "data": "Recording... Perform actions in the browser."})

            while not self.stop_event.is_set():
                self.pause_event.wait()
                try:
                    if not self.driver.window_handles: break

                    current_title = self.driver.title
                    if current_title.startswith("RECORDER_ACTION::"):
                        action_detail = current_title.replace("RECORDER_ACTION::", "")
                        parts = action_detail.split("::")
                        action_type, selector, value = parts[0], parts[1], "::".join(parts[2:])
                        self.driver.execute_script(f"window.top.document.title = '{self.original_title}';")

                        if action_type == "TYPE":
                            if self.typing_timer: self.typing_timer.cancel()
                            if self.last_typing_step and self.last_typing_step["selector"] == selector:
                                self.last_typing_step["value"] = value
                            else:
                                self._flush_typing_step()
                                self.last_typing_step = {"id": f"step-{uuid.uuid4().hex[:6]}", "type": "ACTION", "action": "TYPE", "selector": selector, "value": value}
                            self.typing_timer = threading.Timer(1.0, self._flush_typing_step)
                            self.typing_timer.start()
                        else:
                            self._flush_typing_step()
                            new_step = {"id": f"step-{uuid.uuid4().hex[:6]}", "type": "ACTION", "action": action_type, "selector": selector, "value": value}
                            self.send_message_to_ws({"type": "step", "data": new_step, "mode": self.mode})
                    
                    current_url = self.driver.current_url.rstrip('/')
                    if current_url != self.last_known_url:
                        self._flush_typing_step()
                        self.send_message_to_ws({
                            "type": "step",
                            "data": {"id": f"step-{uuid.uuid4().hex[:6]}", "type": "ACTION", "action": "NAVIGATE", "selector": "", "value": current_url},
                            "mode": self.mode
                        })
                        self.last_known_url = current_url

                except WebDriverException: break
                time.sleep(0.1)
        except Exception as e:
            print(f"RECORDER ERROR: {e}\n{traceback.format_exc()}")
            self.send_message_to_ws({"type": "status", "data": f"Recorder error: {e}"})
        finally:
            self._flush_typing_step()
            self.send_message_to_ws({"type": "status", "data": "Recording stopped."})

            if self.driver:
                self.driver.quit()

            if self.websocket and not self.loop.is_closed():
                asyncio.run_coroutine_threadsafe(self.websocket.close(), self.loop)

            print("Recorder thread finished.")


class PlaybackRunnerThread(threading.Thread):
    def __init__(self, case_id: str, mode: str, websocket: WebSocket, loop: asyncio.AbstractEventLoop, 
                 project_name: str, run_id: Optional[str] = None, headless: bool = False, 
                 capture_all_steps: bool = False, override_url: Optional[str] = None,
                 upload_to_tms: bool = False, tms_run_id: Optional[int] = None):
        super().__init__()
        self.case_id = case_id
        self.mode = mode
        self.websocket = websocket
        self.loop = loop
        self.project_name = project_name
        self.run_id = run_id
        self.headless = headless
        self.capture_all_steps = capture_all_steps
        self.override_url = override_url
        self.upload_to_tms = upload_to_tms
        self.tms_run_id = tms_run_id
        self.stop_event = threading.Event()
        self.process = None

    def stop(self):
        self.stop_event.set()
        if self.process:
            try:
                self.process.terminate()
            except OSError as e:
                print(f"Error terminating playback process: {e}")

    def send_message_to_ws(self, message: Dict):
        if not self.loop.is_closed():
            message['timestamp'] = time.strftime('%Y-%m-%d %H:%M:%S')
            message['case_id'] = self.case_id
            asyncio.run_coroutine_threadsafe(self.websocket.send_json(message), self.loop)

    def run(self):
        log_buffer = []
        status = "UNKNOWN"
        project_report_folder = os.path.join(CONFIG["REPORTS_BASE_FOLDER"], self.project_name.replace(" ", "_"))
        
        def _log_and_buffer(line: str):
            nonlocal status
            clean_line = line.strip()
            log_buffer.append(clean_line)
            if "FAILED" in clean_line:
                status = "FAILED"
            elif "PASSED" in clean_line and status != "FAILED":
                status = "PASSED"
            self.send_message_to_ws({"type": "playback_log", "data": clean_line})
        
        try:
            _log_and_buffer(f"Starting {self.mode} playback for case {self.case_id}...")
            
            script_path = os.path.join(os.path.dirname(__file__), "playback_runner.py")
            python_executable = sys.executable

            cmd = [python_executable, script_path, self.case_id, self.mode, self.project_name, self.run_id or "single_run"]
            if self.headless: cmd.append("--headless")
            if self.capture_all_steps: cmd.append("--capture-all-steps")
            if self.override_url: cmd.extend(["--override-url", self.override_url])

            self.process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

            for line in iter(self.process.stdout.readline, ''):
                if self.stop_event.is_set(): break
                _log_and_buffer(line)

            for line in iter(self.process.stderr.readline, ''):
                if self.stop_event.is_set(): break
                _log_and_buffer(f"ERROR: {line}")

            self.process.wait()

            if not self.stop_event.is_set(): _log_and_buffer("Playback finished.")
            else:
                _log_and_buffer("Playback stopped by user.")
                status = "STOPPED"

        except FileNotFoundError:
            _log_and_buffer("Error: 'playback_runner.py' not found.")
            status = "ERROR"
        except Exception as e:
            _log_and_buffer(f"An error occurred: {e}")
            print(f"PLAYBACK THREAD ERROR: {e}\n{traceback.format_exc()}")
            status = "ERROR"
        finally:
            if self.run_id:
                log_dir = os.path.join(project_report_folder, self.run_id, self.case_id)
                os.makedirs(log_dir, exist_ok=True)
                with open(os.path.join(log_dir, "run.log"), "w", encoding="utf-8") as f:
                    f.write("\n".join(log_buffer))
                db_manager.add_runner_log(self.case_id, self.run_id, log_buffer, status)

                if self.upload_to_tms and self.tms_run_id:
                    try:
                        tms_api = get_tms_api_client()
                        tms_api.add_result_for_case(self.tms_run_id, self.case_id, status)
                        _log_and_buffer(f"Successfully posted result to TestRail for case {self.case_id}.")
                    except Exception as e:
                        _log_and_buffer(f"Failed to post result to TestRail: {e}")
            else:
                db_manager.add_playback_staging_log(self.case_id, log_buffer)

            if self.websocket and not self.loop.is_closed():
                self.send_message_to_ws({"type": "case_finished", "status": status})
                if not self.run_id:
                    asyncio.run_coroutine_threadsafe(self.websocket.close(), self.loop)

# --- Real TestRail API Client using Requests library ---
class LiveTestRailAPI:
    """A client for TestRail that makes real API calls using the requests library."""
    def __init__(self, url, user, password, apikey):
        clean_url = url.strip().rstrip('/')
        if '/index.php' in clean_url:
            clean_url = clean_url.split('/index.php')[0]

        self.base_url = f"{clean_url}/index.php?/api/v2/"
        self.auth = (user, password or apikey)
        self.headers = {'Content-Type': 'application/json'}

    def _get(self, endpoint):
        response = requests.get(self.base_url + endpoint, auth=self.auth, headers=self.headers)
        response.raise_for_status()
        return response.json()

    def _post(self, endpoint, data):
        response = requests.post(self.base_url + endpoint, auth=self.auth, headers=self.headers, json=data)
        response.raise_for_status()
        return response.json()

    def test_connection(self):
        try:
            self._get('get_user_by_email&email=' + self.auth[0])
            return {"status": "success", "message": "Connection successful!"}
        except requests.exceptions.RequestException as e:
            error_message = f"Connection failed: {e}"
            if e.response is not None:
                error_message = f"Connection failed: {e.response.status_code} - {e.response.text}"
            return {"status": "error", "message": error_message}
        except Exception as e:
            return {"status": "error", "message": f"An unexpected error occurred: {e}"}

    def get_run(self, run_id):
        return self._get(f'get_run/{run_id}')

    def add_run(self, project_id: int, name: str, case_ids: list):
        return self._post(f'add_run/{project_id}', {"name": name, "include_all": False, "case_ids": case_ids})

    def add_result_for_case(self, run_id: int, case_id: int, status: str):
        status_map = {"PASSED": 1, "FAILED": 5} # 1=Passed, 5=Failed in TestRail
        status_id = status_map.get(status, 4) # 4=Retest
        return self._post(f'add_result_for_case/{run_id}/{case_id}', {"status_id": status_id})

    def get_projects(self):
        response = self._get('get_projects')
        projects = response.get('projects', [])
        return [{"id": p['id'], "name": p['name']} for p in projects]

    def get_suites(self, project_id):
        all_suites = self.get_all_suites_for_project(project_id)
        
        suites_by_id = {suite['id']: suite for suite in all_suites}
        for suite in all_suites:
            suite['children'] = []
    
        root_suites = []
        for suite in all_suites:
            if suite.get('suite_id') is None:
                root_suites.append(suite)
            else:
                parent_id = suite.get('suite_id')
                if parent_id in suites_by_id:
                    if 'children' not in suites_by_id[parent_id]:
                         suites_by_id[parent_id]['children'] = []
                    suites_by_id[parent_id]['children'].append(suite)
                else:
                    root_suites.append(suite)
        return root_suites
    
    def get_all_suites_for_project(self, project_id):
        return self._get(f'get_suites/{project_id}')

    def get_cases(self, project_id, suite_id):
        response = self._get(f'get_cases/{project_id}&suite_id={suite_id}')
        cases = response.get('cases', [])

        def format_steps(steps_data):
            if not steps_data: return ""
            if isinstance(steps_data, list):
                return "\n".join(step.get('content', '') for step in steps_data)
            return str(steps_data)

        return [
            {
                "id": c['id'], "title": c['title'],
                "custom_preconds": c.get('custom_preconds', ''),
                "custom_steps": format_steps(c.get('custom_steps_separated')),
                "custom_expected": c.get('custom_expected', '')
            } for c in cases
        ]

db_manager = DatabaseManager(CONFIG["MASTER_DB_NAME"])

# =============================================================================
# 2. PYDANTIC MODELS (Data Validation)
# =============================================================================
class SaveProjectPayload(BaseModel):
    projectId: str
    data: Dict[str, Any]

class NewProjectPayload(BaseModel):
    name: str

class EditProjectPayload(BaseModel):
    name: str

class TMSConfigPayload(BaseModel):
    url: str
    user: str
    password: Optional[str] = None
    apikey: Optional[str] = None

class NewTestRunPayload(BaseModel):
    project_id: int
    name: str
    case_ids: List[int]

class CopyPastePayload(BaseModel):
    mode: str

class PlaybackPayload(BaseModel):
    type: str
    mode: str
    case_id: str
    headless: bool = False

class RunnerPayload(BaseModel):
    type: str
    project_id: str
    project_name: str
    mode: str
    case_ids: List[str]
    headless: bool = False
    capture_all_steps: bool = False
    override_url: Optional[str] = None
    upload_to_tms: bool = False
    tms_run_id: Optional[int] = None

class ReportPayload(BaseModel):
    project_id: str
    run_id: str
    format: str

class SaveReportPayload(BaseModel):
    project_name: str
    report_content: str
    format: str

# =============================================================================
# 3. FASTAPI BACKEND (API Endpoints and WebSocket)
# =============================================================================

app = FastAPI()

env = Environment(loader=FileSystemLoader('static'))

active_recorders: Dict[str, threading.Thread] = {}
active_playbacks: Dict[str, threading.Thread] = {}

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/", response_class=HTMLResponse)
async def get_project_hub():
    return FileResponse('static/index.html')

@app.get("/designer/{project_id}", response_class=HTMLResponse)
async def get_designer_page(project_id: str):
    return FileResponse('static/designer.html')

@app.get("/runner", response_class=HTMLResponse)
async def get_test_runner_page():
    return FileResponse('static/runner.html')

@app.get("/settings", response_class=HTMLResponse)
async def get_settings_page():
    return FileResponse('static/settings.html')

@app.get("/playback/{project_id}/{case_id}", response_class=HTMLResponse)
async def get_playback_page(project_id: str, case_id: str):
    return FileResponse('static/playback.html')


@app.get("/api/projects")
async def get_all_projects():
    try:
        projects = db_manager.get_all_projects_with_summary()
        return projects
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.post("/api/projects/new")
async def create_new_project(payload: NewProjectPayload):
    try:
        new_project = db_manager.create_project(payload.name)
        return new_project
    except ValueError as e:
        return JSONResponse(content={"error": str(e)}, status_code=409)
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.put("/api/projects/{project_id}")
async def rename_project(project_id: str, payload: EditProjectPayload):
    try:
        db_manager.rename_project(project_id, payload.name)
        return {"message": "Project renamed successfully"}
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str):
    try:
        db_manager.delete_project(project_id)
        return {"message": "Project deleted successfully"}
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


@app.get("/api/project/{project_id}")
async def get_project(project_id: str):
    try:
        data = db_manager.get_project_hierarchy(project_id)
        return data
    except Exception as e:
        print(f"Error getting project hierarchy: {e}")
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.post("/api/project/{project_id}/case/{case_id}/copy_steps")
async def copy_steps(project_id: str, case_id: str, payload: CopyPastePayload):
    try:
        project_data = db_manager.get_project_hierarchy(project_id)
        def find_case(c_id, items):
            for item in items.values():
                if item['id'] == c_id and item['type'] == 'case': return item
                if item.get('children'):
                    found = find_case(c_id, item['children'])
                    if found: return found
            return None
        source_case = find_case(case_id, project_data.get("hierarchy", {}))
        if not source_case:
            return JSONResponse(status_code=404, content={"error": "Source test case not found."})
        steps_for_mode = source_case.get('steps', {}).get(payload.mode, [])
        clipboard['steps'] = steps_for_mode
        clipboard['mode'] = payload.mode
        return {"message": f"{len(clipboard['steps'])} steps copied from '{payload.mode}' mode."}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/project/{project_id}/case/{case_id}/paste_steps")
async def paste_steps(project_id: str, case_id: str, payload: CopyPastePayload):
    if not clipboard['steps']:
        return JSONResponse(status_code=400, content={"error": "Clipboard is empty."})
    if clipboard['mode'] != payload.mode:
        return JSONResponse(status_code=400, content={"error": f"Cannot paste steps. Copied from '{clipboard['mode']}' mode but pasting into '{payload.mode}' mode."})
    try:
        project_data = db_manager.get_project_hierarchy(project_id)
        hierarchy = project_data.get("hierarchy", {})
        def find_case(c_id, items):
            for item in items.values():
                if item['id'] == c_id and item['type'] == 'case': return item
                if item.get('children'):
                    found = find_case(c_id, item['children'])
                    if found: return found
            return None
        target_case = find_case(case_id, hierarchy)
        if not target_case:
            return JSONResponse(status_code=404, content={"error": "Target test case not found."})
        
        pasted_steps = []
        for step in clipboard['steps']:
            new_step = step.copy()
            new_step['id'] = f"step-{uuid.uuid4().hex[:6]}"
            pasted_steps.append(new_step)

        if 'steps' not in target_case:
            target_case['steps'] = {'auto': [], 'nlp': [], 'playwright': []}
        target_case['steps'][payload.mode].extend(pasted_steps)
        db_manager.save_project_hierarchy(project_id, hierarchy)
        return {"message": f"{len(pasted_steps)} steps pasted successfully into '{payload.mode}' mode."}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/api/case/{case_id}/playback_logs")
async def get_case_playback_logs(case_id: str):
    try:
        logs = db_manager.get_playback_staging_logs(case_id)
        return logs
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.get("/api/project/{project_id}/runner_logs")
async def get_project_runner_logs(project_id: str):
    try:
        logs = db_manager.get_runner_logs(project_id)
        return logs
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.post("/api/project/save")
async def save_project(payload: SaveProjectPayload):
    try:
        db_manager.save_project_hierarchy(payload.projectId, payload.data)
        return {"message": "Project saved successfully!"}
    except Exception as e: return JSONResponse(content={"error": str(e)}, status_code=500)

@app.get("/api/project/{project_id}/next-display-id")
async def get_next_display_id(project_id: str):
    try:
        display_id = db_manager.get_next_display_id(project_id)
        return {"display_id": display_id}
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.get("/api/template/download")
async def download_csv_template():
    csv_header = "TC#,TR Test Case ID,Step Number,Title,Preconditions,Steps,Expected Result\n"
    return StreamingResponse(iter([csv_header]), media_type="text/csv", headers={"Content-Disposition": "attachment;filename=sample_template.csv"})

@app.post("/api/project/{project_id}/suites/{suite_id}/import")
async def import_test_cases(project_id: str, suite_id: str, file: UploadFile = File(...)):
    if not file.filename.endswith('.csv'):
        return JSONResponse(status_code=400, content={"error": "Invalid file type. Please upload a CSV."})
    try:
        project_data = db_manager.get_project_hierarchy(project_id)
        hierarchy = project_data.get("hierarchy", {})
        def find_suite(s_id, items):
            for item in items.values():
                if item['id'] == s_id and item['type'] == 'suite': return item
                if item.get('children'):
                    found = find_suite(s_id, item['children'])
                    if found: return found
            return None
        target_suite = find_suite(suite_id, hierarchy)
        if not target_suite:
            return JSONResponse(status_code=404, content={"error": "Target suite not found."})

        content = await file.read()
        content_str = content.decode('utf-8')
        csv_reader = csv.DictReader(io.StringIO(content_str))
        cases_from_csv = {}
        for row in csv_reader:
            case_id = row.get('TR Test Case ID')
            if not case_id: continue
            if case_id not in cases_from_csv: cases_from_csv[case_id] = []
            cases_from_csv[case_id].append(row)

        for case_id, rows in cases_from_csv.items():
            sorted_rows = sorted(rows, key=lambda x: int(x.get('Step Number', 0)))
            base_row = sorted_rows[0]
            title = base_row.get('Title', '').strip()
            if not title: continue
            display_id = f"{base_row.get('TC#', '')} - [{base_row.get('TR Test Case ID', '')}]"
            manual_steps = "\n".join(f"{row.get('Step Number', '')}. {row.get('Steps', '')}" for row in sorted_rows if row.get('Steps'))
            expected_result = "\n".join(f"{row.get('Step Number', '')}. {row.get('Expected Result', '')}" for row in sorted_rows if row.get('Expected Result'))
            new_case = {"id": f"case-{uuid.uuid4().hex[:6]}", "type": "case", "title": title, "display_id": display_id, "preconditions": base_row.get('Preconditions', ''), "manual_steps": manual_steps, "expected_result": expected_result, "url": base_row.get('url', ''), "steps": {'auto': [], 'nlp': [], 'playwright': []}}
            if 'children' not in target_suite: target_suite['children'] = {}
            target_suite['children'][new_case['id']] = new_case
        
        db_manager.save_project_hierarchy(project_id, hierarchy)
        return {"message": f"Successfully imported {len(cases_from_csv)} test cases."}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"An error occurred: {e}"})

def get_base64_encoded_image(image_path):
    try:
        with open(image_path, "rb") as img_file:
            return base64.b64encode(img_file.read()).decode('utf-8')
    except FileNotFoundError:
        return None

def parse_time_from_log(log_line):
    match = re.search(r'\[(\d{2}:\d{2}:\d{2})\]', log_line)
    return match.group(1) if match else None

def format_timestamp(dt_str):
    if not dt_str: return "N/A"
    try:
        dt_obj = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S")
        return dt_obj.strftime("%d-%m-%Y %H:%M:%S")
    except ValueError:
        return dt_str

@app.post("/api/runner/report")
async def generate_report(payload: ReportPayload):
    try:
        project_data = db_manager.get_project_hierarchy(payload.project_id)
        project_name = project_data.get('name', 'UnknownProject')
        report_data = []
        total_passed = 0
        total_failed = 0
        
        run_logs = db_manager.get_runner_logs(payload.project_id)
        target_run = next((run for run in run_logs if run['run_id'] == payload.run_id), None)
        
        if not target_run:
            return JSONResponse(status_code=404, content={"error": f"Run ID {payload.run_id} not found."})
        
        db_manager.mark_run_report_generated(payload.run_id)

        for case_log in target_run['cases']:
            log_content = case_log.get('log_data', [])
            status = case_log.get('status', 'UNKNOWN')
            
            processed_logs = []
            start_time, end_time = None, None
            
            for line in log_content:
                timestamp = parse_time_from_log(line)
                if timestamp:
                    if not start_time: start_time = timestamp
                    end_time = timestamp

                log_entry = {"text": line, "screenshot": None}
                if "Screenshot saved:" in line:
                    path_part = line.split("Screenshot saved:")[1].strip()
                    if os.path.exists(path_part):
                        encoded_img = get_base64_encoded_image(path_part)
                        if encoded_img:
                            log_entry["screenshot"] = f"data:image/png;base64,{encoded_img}"
                processed_logs.append(log_entry)
            
            if status == "PASSED": total_passed += 1
            elif status == "FAILED": total_failed += 1
            
            case_title = "Unknown Case"
            def find_case_title(c_id, items):
                for item in items.values():
                    if item['id'] == c_id: return item['title']
                    if item.get('children'):
                        found = find_case_title(c_id, item['children'])
                        if found: return found
                return None
            case_title = find_case_title(case_log['case_id'], project_data.get("hierarchy", {}))

            report_data.append({
                "case_id": case_log['case_id'], "title": case_title,
                "status": status, "logs": processed_logs,
                "start_time": format_timestamp(f"{target_run['timestamp'].split(' ')[0]} {start_time}") if start_time else 'N/A',
                "end_time": format_timestamp(f"{target_run['timestamp'].split(' ')[0]} {end_time}") if end_time else 'N/A'
            })
        
        template = env.get_template('report_template.html')
        html_content = template.render(
            project_name=project_name,
            report_date=format_timestamp(target_run['timestamp']),
            test_results=report_data,
            total_run=len(target_run['cases']),
            total_passed=total_passed,
            total_failed=total_failed
        )

        if payload.format == "pdf":
            pdf_file = io.BytesIO()
            pisa_status = pisa.CreatePDF(io.StringIO(html_content), dest=pdf_file)
            if pisa_status.err:
                return JSONResponse(status_code=500, content={"error": "Failed to generate PDF"})
            pdf_file.seek(0)
            return StreamingResponse(pdf_file, media_type="application/pdf", headers={"Content-Disposition": "attachment;filename=test_report.pdf"})
        
        return HTMLResponse(content=html_content, headers={"Content-Disposition": "attachment;filename=test_report.html"})
    except Exception as e:
        print(traceback.format_exc())
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/runner/report/save")
async def save_report_to_server(payload: SaveReportPayload):
    try:
        project_name = payload.project_name.replace(" ", "_")
        project_report_folder = os.path.join(CONFIG["REPORTS_BASE_FOLDER"], project_name)
        os.makedirs(project_report_folder, exist_ok=True)

        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"test_report_{timestamp}.{payload.format}"
        filepath = os.path.join(project_report_folder, filename)

        if payload.format == 'pdf':
            with open(filepath, "wb") as pdf_file:
                pisa_status = pisa.CreatePDF(io.StringIO(payload.report_content), dest=pdf_file)
                if pisa_status.err:
                    raise Exception("PDF conversion failed.")
        else:
             with open(filepath, "w", encoding="utf-8") as f:
                f.write(payload.report_content)

        return {"message": f"Report successfully saved to {filepath}"}
    except Exception as e:
        print(traceback.format_exc())
        return JSONResponse(status_code=500, content={"error": str(e)})


# --- TMS Endpoints ---
def get_tms_api_client():
    url = os.getenv("TMS_URL")
    user = os.getenv("TMS_USER")
    password = os.getenv("TMS_PASSWORD")
    apikey = os.getenv("TMS_APIKEY")

    if not all([url, user, (password or apikey)]):
        raise ValueError("TMS credentials are not fully configured in environment variables.")

    return LiveTestRailAPI(url=url, user=user, password=password, apikey=apikey)

@app.post("/api/tms/test")
async def test_tms_connection(config: TMSConfigPayload):
    try:
        if not (config.password or config.apikey):
             return JSONResponse(status_code=400, content={"status": "error", "message": "Either a password or an API key is required."})
        api = LiveTestRailAPI(url=config.url, user=config.user, password=config.password, apikey=config.apikey)
        return api.test_connection()
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

@app.post("/api/tms/runs/new")
async def create_new_test_run(payload: NewTestRunPayload):
    try:
        api = get_tms_api_client()
        response = api.add_run(payload.project_id, payload.name, payload.case_ids)
        return response
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.get("/api/runner/testrail/check_run/{run_id}")
async def check_testrail_run(run_id: int):
    try:
        api = get_tms_api_client()
        run_details = api.get_run(run_id)
        return {"status": "success", "message": f"Valid Run: {run_details.get('name')}"}
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 404:
            return JSONResponse(status_code=404, content={"status": "error", "message": "Test Run not found."})
        return JSONResponse(status_code=e.response.status_code, content={"status": "error", "message": f"TestRail API error: {e}"})
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})

@app.get("/api/tms/projects")
async def get_tms_projects():
    try:
        api = get_tms_api_client()
        return api.get_projects()
    except ValueError as e:
        return JSONResponse(status_code=404, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.get("/api/tms/projects/{project_id}/suites")
async def get_tms_suites(project_id: int):
    try:
        api = get_tms_api_client()
        return api.get_suites(project_id)
    except ValueError as e:
        return JSONResponse(status_code=404, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/tms/import/project/{local_project_id}/tr_project/{tr_project_id}/suite/{tms_suite_id}")
async def import_from_tms(local_project_id: str, tr_project_id: int, tms_suite_id: int):
    try:
        api = get_tms_api_client()
        
        project_data = db_manager.get_project_hierarchy(local_project_id)
        hierarchy = project_data.get("hierarchy", {})
        tms_cases = api.get_cases(project_id=tr_project_id, suite_id=tms_suite_id)

        all_suites = api.get_all_suites_for_project(tr_project_id)
        suite_name = next((s['name'] for s in all_suites if s['id'] == tms_suite_id), f"Imported Suite {tms_suite_id}")

        new_suite_title = f"{suite_name} (Imported from TestRail)"
        new_suite_id = f"suite-{uuid.uuid4().hex[:6]}"
        new_suite = {"id": new_suite_id, "type": "suite", "title": new_suite_title, "children": {}}
        
        for case in tms_cases:
            display_id = db_manager.get_next_display_id(local_project_id)
            new_case_id = f"case-{uuid.uuid4().hex[:6]}"
            new_case = {
                "id": new_case_id, "type": "case", "title": case['title'],
                "display_id": display_id, "preconditions": case.get('custom_preconds', ''),
                "manual_steps": case.get('custom_steps', ''), "expected_result": case.get('custom_expected', ''),
                "url": "", "steps": {'auto': [], 'nlp': [], 'playwright': []}
            }
            new_suite["children"][new_case["id"]] = new_case
        
        hierarchy[new_suite_id] = new_suite
        db_manager.save_project_hierarchy(local_project_id, hierarchy)

        return {"message": f"Successfully imported {len(tms_cases)} test cases into new suite '{new_suite_title}'."}
    except ValueError as e:
        return JSONResponse(status_code=404, content={"error": str(e)})
    except Exception as e:
        print(f"TMS Import Error: {e}\n{traceback.format_exc()}")
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.websocket("/ws/recorder/{client_id}")
async def websocket_recorder_endpoint(websocket: WebSocket, client_id: str):
    await websocket.accept()
    loop = asyncio.get_running_loop()
    recorder_thread = None
    try:
        while True:
            data = await websocket.receive_json()
            recorder_mode = data.get('mode', 'auto')

            if data['type'] == 'start_recording':
                url = data.get("url", "http://example.com")

                if recorder_mode == 'playwright':
                    recorder_thread = PlaywrightRecorderThread(url=url, websocket=websocket, loop=loop)
                else:
                    recorder_thread = RecorderThread(url=url, websocket=websocket, loop=loop, mode=recorder_mode)

                active_recorders[client_id] = recorder_thread
                recorder_thread.start()

            elif data['type'] == 'stop_recording':
                if recorder_thread:
                    recorder_thread.stop()
                break
            elif data['type'] == 'pause_recording':
                if recorder_thread and hasattr(recorder_thread, 'pause'):
                    recorder_thread.pause()
            elif data['type'] == 'resume_recording':
                if recorder_thread and hasattr(recorder_thread, 'resume'):
                    recorder_thread.resume()

    except WebSocketDisconnect:
        print(f"Client {client_id} disconnected.")
    except Exception as e:
        print(f"An error occurred in WebSocket: {e}")
    finally:
        if client_id in active_recorders:
            active_recorders[client_id].stop()
            del active_recorders[client_id]
        print(f"Closing WebSocket connection for client {client_id}.")

@app.websocket("/ws/playback/{client_id}")
async def websocket_playback_endpoint(websocket: WebSocket, client_id: str):
    await websocket.accept()
    loop = asyncio.get_running_loop()
    playback_thread = None
    try:
        while True:
            data = await websocket.receive_json()

            if data.get('type') == 'start_playback':
                try:
                    playback_payload = PlaybackPayload(**data)
                    project_data = db_manager.get_project_hierarchy(playback_payload.case_id.split('-')[0])
                except (ValidationError, IndexError) as e:
                    await websocket.send_json({"type": "status", "data": f"Playback error: Invalid data received. {e}"})
                    continue

                playback_thread = PlaybackRunnerThread(
                    case_id=playback_payload.case_id,
                    mode=playback_payload.mode,
                    websocket=websocket,
                    loop=loop,
                    project_name=project_data.get('name', 'UnknownProject'),
                    run_id=None,
                    headless=playback_payload.headless,
                    capture_all_steps=True
                )

                active_playbacks[client_id] = playback_thread
                playback_thread.start()

            elif data['type'] == 'stop_playback':
                if playback_thread:
                    playback_thread.stop()
                break
    except WebSocketDisconnect:
        print(f"Playback client {client_id} disconnected.")
    except Exception as e:
        print(f"An error occurred in Playback WebSocket: {e}")
    finally:
        if client_id in active_playbacks and active_playbacks.get(client_id):
            active_playbacks[client_id].stop()
            del active_playbacks[client_id]
        print(f"Closing Playback WebSocket connection for client {client_id}.")

@app.websocket("/ws/runner/{client_id}")
async def websocket_runner_endpoint(websocket: WebSocket, client_id: str):
    await websocket.accept()
    loop = asyncio.get_running_loop()
    run_id = f"run-{uuid.uuid4().hex[:8]}"
    
    try:
        data = await websocket.receive_json()
        if data.get('type') == 'start_run':
            try:
                runner_payload = RunnerPayload(**data)
            except ValidationError as e:
                await websocket.send_json({"status": "failed", "message": f"Invalid data: {e}", "timestamp": time.strftime('%Y-%m-%d %H:%M:%S')})
                return

            await websocket.send_json({"timestamp": time.strftime('%Y-%m-%d %H:%M:%S'), "status": "info", "message": f"Starting test run '{run_id}' for {len(runner_payload.case_ids)} cases..."})

            for case_id in runner_payload.case_ids:
                playback_thread = PlaybackRunnerThread(
                    case_id=case_id,
                    mode=runner_payload.mode,
                    websocket=websocket,
                    loop=loop,
                    project_name=runner_payload.project_name,
                    run_id=run_id,
                    headless=runner_payload.headless,
                    capture_all_steps=runner_payload.capture_all_steps,
                    override_url=runner_payload.override_url,
                    upload_to_tms=runner_payload.upload_to_tms,
                    tms_run_id=runner_payload.tms_run_id
                )
                playback_thread.start()
                playback_thread.join()
            
            await websocket.send_json({"timestamp": time.strftime('%Y-%m-%d %H:%M:%S'), "status": "info", "message": f"Test run '{run_id}' finished.", "run_id": run_id})

    except WebSocketDisconnect:
        print(f"Runner client {client_id} disconnected.")
    except Exception as e:
        print(f"An error occurred in Runner WebSocket: {e}\n{traceback.format_exc()}")
    finally:
        await websocket.close()
        print(f"Closing Runner WebSocket connection for client {client_id}.")

# =============================================================================
# 5. RUNNING THE APPLICATION
# =============================================================================

if __name__ == "__main__":
    mp.freeze_support()
    print("This script contains a FastAPI application.")
    print("Please run it using the uvicorn command as described below:")
    print("\n  uvicorn app_server:app --reload --port 8080\n")
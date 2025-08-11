import sys
import json
import time
import sqlite3
import re
import asyncio
import uuid
import logging
import traceback
from functools import partial
import os
import pyautogui
from typing import Optional

# Import for Windows-specific focus control
if os.name == 'nt':
    import win32gui
    import win32process
    import win32con

from playwright.sync_api import sync_playwright, Error as PlaywrightError

from selenium import webdriver
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.common.by import By
from selenium.common.exceptions import WebDriverException, TimeoutException, NoSuchElementException
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import Select

# --- Setup Logging ---
logging.basicConfig(level=logging.INFO, format='%(message)s', stream=sys.stdout)

# --- Database Connection ---
def get_db_connection():
    db_path = os.path.join(os.path.dirname(__file__), "master_test_recorder.db")
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error as e:
        print(f"Database connection failed: {e}", file=sys.stderr)
        sys.exit(1)

def fetch_test_case_data(case_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT * FROM test_items WHERE id = ?", (case_id,))
        case_row = cursor.fetchone()
        if not case_row: return None
        case_data = dict(case_row)
        cursor.execute("SELECT * FROM test_steps WHERE case_id = ? ORDER BY step_order", (case_id,))
        steps_by_mode = {'auto': [], 'nlp': [], 'playwright': []}
        for row in cursor.fetchall():
            mode = row['mode'] or 'auto'
            if mode in steps_by_mode:
                step_data = json.loads(row['data'])
                step_data['id'] = row['id']
                steps_by_mode[mode].append(step_data)
        case_data['steps'] = steps_by_mode
        return case_data
    except sqlite3.Error as e:
        print(f"Failed to fetch test case data: {e}", file=sys.stderr)
        return None
    finally:
        conn.close()

# --- Playwright Playback Logic ---
def execute_sync_playwright_script(script_content: str, headless: bool):
    logging.info("--- Starting Playwright Execution ---")
    try:
        with sync_playwright() as p:
            from playwright.sync_api import expect
            browser = p.chromium.launch(headless=headless, args=["--start-maximized"])
            context = browser.new_context(no_viewport=True)
            page = context.new_page()
            page.set_default_timeout(60000)
            
            sync_script_content = script_content.replace("await ", "")
            
            script_globals = {
                "page": page,
                "context": context,
                "browser": browser,
                "expect": expect,
                "time": time
            }
            
            logging.info("--- Executing Recorded Script ---")
            exec(sync_script_content, script_globals)
            logging.info("--- Script Execution Finished ---")
            browser.close()
    except PlaywrightError as e:
        logging.error(f"Playwright Execution Error: {e}")
    except Exception as e:
        logging.error(f"An unexpected error occurred during script execution: {e}")
    finally:
        logging.info("--- Playwright execution thread finished ---")


# --- Selenium Playback Logic ---
def run_selenium_steps(case_id: str, steps: list, headless: bool, project_name: str, run_id: str, capture_all: bool, override_url: Optional[str]):
    logging.info("--- Starting Selenium Playback ---")
    driver = None
    screenshot_dir = os.path.join("reports", project_name.replace(" ", "_"), run_id, case_id)
    if capture_all:
        os.makedirs(screenshot_dir, exist_ok=True)

    def _log_step(message):
        logging.info(f"[{time.strftime('%H:%M:%S')}] {message}")

    def _wait_for_page_load(driver_instance, timeout=30):
        WebDriverWait(driver_instance, timeout).until(
            lambda d: d.execute_script('return document.readyState') == 'complete'
        )
        _log_step("Page load complete.")

    def _bring_window_to_front(pid):
        if headless or os.name != 'nt': return
        try:
            hwnds = []
            def callback(hwnd, hwnds):
                if win32gui.IsWindowVisible(hwnd) and win32gui.IsWindowEnabled(hwnd):
                    _, found_pid = win32process.GetWindowThreadProcessId(hwnd)
                    if found_pid == pid:
                        hwnds.append(hwnd)
                return True
            
            win32gui.EnumWindows(callback, hwnds)
            
            if hwnds:
                hwnd = hwnds[0]
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                win32gui.SetForegroundWindow(hwnd)
                rect = win32gui.GetWindowRect(hwnd)
                pyautogui.click(rect[0] + 10, rect[1] + 10)
                _log_step(f"Brought window with HWND {hwnd} to front.")
            else:
                _log_step(f"Could not find window for PID: {pid}")
        except Exception as e:
            _log_step(f"Could not bring window to front using pywin32: {e}")

    def _highlight_element(driver_instance, element):
        if headless: return
        try:
            original_style = driver_instance.execute_script("return arguments[0].getAttribute('style');", element)
            driver_instance.execute_script("arguments[0].setAttribute('style', arguments[1]);", element, "border: 3px solid red; box-shadow: 0 0 10px red;")
            time.sleep(0.5)
            driver_instance.execute_script("arguments[0].setAttribute('style', arguments[1]);", element, original_style)
        except Exception as e:
            _log_step(f"Could not highlight element: {e}")
            
    def _take_screenshot(step_index, action_name, status):
        if capture_all:
            filename = f"step_{step_index + 1}_{action_name}_{status}.png"
            filepath = os.path.join(screenshot_dir, filename)
            try:
                pyautogui.screenshot(filepath)
                _log_step(f"Screenshot saved: {filepath}")
            except Exception as e:
                _log_step(f"Could not save screenshot using pyautogui: {e}")

    try:
        if override_url:
            for i, step in enumerate(steps):
                if step.get('action') == 'NAVIGATE':
                    _log_step(f"Overriding original URL '{step['value']}' with '{override_url}'.")
                    steps[i]['value'] = override_url
                    break
        
        options = ChromeOptions()
        if headless:
            options.add_argument("--headless")
            options.add_argument("--window-size=1920,1080")
        
        options.add_experimental_option("w3c", "true")
        
        service = ChromeService()
        driver = webdriver.Chrome(service=service, options=options)
        browser_pid = service.process.pid
        
        if not headless:
            driver.maximize_window()
        
        for i, step in enumerate(steps):
            action = step.get('action', '')
            selector = step.get('selector', '')
            value = step.get('value', '')
            step_name = action or step.get('validation_type', 'Unknown Step')
            _log_step(f"Executing step {i+1}: {step_name}")

            try:
                _wait_for_page_load(driver)
                _bring_window_to_front(browser_pid)

                element = None
                if selector:
                    element = WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.XPATH, selector)))
                
                if element:
                    _highlight_element(driver, element)

                if action == 'NAVIGATE':
                    driver.get(value)
                    _bring_window_to_front(browser_pid)
                elif action == 'CLICK':
                    element.click()
                elif action == 'TYPE':
                    element.clear()
                    element.send_keys(value)
                
                _log_step(f"Step {i+1} PASSED")
                _take_screenshot(i, step_name, "PASSED")

            except Exception as e:
                error_str = str(e).split('\\n')[0]
                _log_step(f"Step {i+1} FAILED: {error_str}")
                _take_screenshot(i, step_name, "FAILED")
                break
        
        _log_step("--- Selenium playback finished ---")

    except Exception as e:
        _log_step(f"A critical error occurred: {e}")
    finally:
        if driver:
            driver.quit()

# --- Main Execution Block ---
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("case_id")
    parser.add_argument("mode")
    parser.add_argument("project_name")
    parser.add_argument("run_id")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--capture-all-steps", action="store_true")
    parser.add_argument("--override-url", type=str, default=None)
    args = parser.parse_args()

    test_case = fetch_test_case_data(args.case_id)
    if not test_case:
        print(f"Error: Test Case with ID '{args.case_id}' not found.", file=sys.stderr)
        sys.exit(1)

    if args.mode == 'playwright':
        script = test_case.get('playwright_script')
        if script:
            execute_sync_playwright_script(script, args.headless)
        else:
            logging.info("No Playwright script found for this test case.")

    elif args.mode in ['auto', 'nlp']:
        steps_to_run = test_case.get('steps', {}).get(args.mode, [])
        if steps_to_run:
            run_selenium_steps(args.case_id, steps_to_run, args.headless, args.project_name, args.run_id, args.capture_all_steps, args.override_url)
        else:
            logging.info(f"No steps found for '{args.mode}' mode.")
    else:
        print(f"Unknown playback mode: {args.mode}", file=sys.stderr)
import argparse
import logging
from playback_runner import fetch_test_case_data, run_selenium_steps, execute_sync_playwright_script

# --- Setup Logging ---
logging.basicConfig(level=logging.INFO, format='%(message)s', stream=sys.stdout)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run a single test case.")
    parser.add_argument("case_id", help="The ID of the test case to run.")
    parser.add_argument("mode", help="The execution mode (e.g., auto, nlp, playwright).")
    parser.add_argument("project_name", help="The name of the project.")
    parser.add_argument("run_id", help="The unique ID for this test run.")
    parser.add_argument("--headless", action="store_true", help="Run in headless mode.")
    parser.add_argument("--capture-all-steps", action="store_true", help="Capture a screenshot for every step.")
    parser.add_argument("--override-url", type=str, default=None, help="Override the starting URL.")
    args = parser.parse_args()

    test_case = fetch_test_case_data(args.case_id)
    if not test_case:
        print(f"Error: Test Case with ID '{args.case_id}' not found.")
        exit(1)

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
        print(f"Unknown playback mode: {args.mode}")
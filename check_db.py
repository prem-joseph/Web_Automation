import sqlite3
import os

DB_FILE = "master_test_recorder.db"

def check_projects():
    if not os.path.exists(DB_FILE):
        print(f"ERROR: Database file '{DB_FILE}' not found!")
        print("Please make sure you are running this script from the correct directory.")
        return

    print(f"--- Checking contents of '{DB_FILE}' ---")
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='projects';")
        if cursor.fetchone() is None:
            print("ERROR: The 'projects' table does not exist in the database.")
            conn.close()
            return

        cursor.execute("SELECT id, name, created_at FROM projects")
        projects = cursor.fetchall()
        
        if projects:
            print(f"SUCCESS: Found {len(projects)} project(s) in the database:")
            for project in projects:
                print(f"  - ID: {project[0]}, Name: {project[1]}, Created: {project[2]}")
        else:
            print("INFO: The 'projects' table is empty. No projects have been created yet.")
            print("You can create a project from the Project Hub page.")
            
        conn.close()
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

if __name__ == "__main__":
    check_projects()
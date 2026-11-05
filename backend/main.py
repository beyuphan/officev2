"""Entry point: `LOCALFLOW_DEV_TOKEN=dev uvicorn main:app --host 127.0.0.1 --port 8000`.

In production the Tauri shell starts the sidecar on a random port with LOCALFLOW_TOKEN.
"""
from localflow.app import create_app

app = create_app()

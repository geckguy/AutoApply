"""AutoApply Backend — FastAPI application entry point."""

import json
import logging
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from dotenv import load_dotenv

# Load environment variables
load_dotenv(Path(__file__).parent / ".env")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("autoapply")

DATA_DIR = Path(__file__).parent / "data"

# Empty JSON structures for initialization
INIT_FILES = {
    "applications.json": [],
    "corrections.json": [],
    "answer_bank.json": [],
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown events."""
    # Startup: create data directory and initialize empty JSON files
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for filename, default_content in INIT_FILES.items():
        filepath = DATA_DIR / filename
        if not filepath.exists():
            with open(filepath, "w") as f:
                json.dump(default_content, f)
            logger.info(f"Initialized {filename}")

    logger.info("AutoApply backend started")
    logger.info(f"Data directory: {DATA_DIR.resolve()}")

    yield  # App runs here

    logger.info("AutoApply backend shutting down")
    from backend.services.database import get_database
    get_database().close()


# Create the app
app = FastAPI(
    title="AutoApply API",
    description="AI-powered job application autofill backend",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow the Firefox extension to make requests from any origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import and include routers
from backend.routers import profile, autofill, applications

app.include_router(profile.router)
app.include_router(autofill.router)
app.include_router(applications.router)

# Mount dashboard static files
dashboard_dir = Path(__file__).parent / "dashboard"
if dashboard_dir.exists():
    app.mount("/dashboard/static", StaticFiles(directory=str(dashboard_dir)), name="dashboard-static")


@app.get("/dashboard")
async def serve_dashboard():
    """Serve the applications history dashboard Web UI."""
    return FileResponse(str(dashboard_dir / "index.html"))


@app.get("/api/health")
async def health_check():
    """Health check endpoint for the extension to verify backend connectivity."""
    profile_exists = (DATA_DIR / "profile.json").exists()
    resume_exists = (DATA_DIR / "resume.pdf").exists()
    knowledge_exists = (DATA_DIR / "knowledge.md").exists()

    # Count applications
    apps_path = DATA_DIR / "applications.json"
    app_count = 0
    try:
        with open(apps_path, "r") as f:
            app_count = len(json.load(f))
    except (json.JSONDecodeError, ValueError, FileNotFoundError):
        app_count = 0

    return {
        "status": "healthy",
        "profile_loaded": profile_exists,
        "resume_uploaded": resume_exists,
        "knowledge_loaded": knowledge_exists,
        "total_applications": app_count,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host="127.0.0.1",
        port=8000,
        reload=False,
        log_level="info",
    )

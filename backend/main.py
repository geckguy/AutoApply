"""AutoApply Backend — FastAPI application entry point."""

import logging
import os
import re
from pathlib import Path
from urllib.parse import urlsplit
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

from backend.services.llm_client import (
    LLMResponseError,
    ProviderBusy,
    ProviderNotConfigured,
    inspect_provider_configuration,
    provider_status_line,
)

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

# --------------------------------------------------------------------------
# Local trust boundary
#
# The API holds the user's profile, resume bytes, and application history and
# has no credential of its own, so it trusts only requests that are provably
# local:
#   * Host must be a loopback name, on any port. Requests to a public hostname
#     that DNS has been rebound to 127.0.0.1 carry that public name in Host,
#     which is exactly what this rejects.
#   * A browser Origin must be loopback *and* use the same port as the request's
#     own Host header, so the dashboard's same-origin calls are trusted (on any
#     port) while an unrelated page on another local port is not. Pinned
#     AutoApply extension ids stay allowed; without the allowlist every
#     installed extension could read the profile.
#   * Requests with no Origin are accepted (local CLI/processes) because the
#     Host check above is what closes DNS rebinding.
#
# AUTOAPPLY_ALLOWED_HOSTS / AUTOAPPLY_EXTENSION_IDS / AUTOAPPLY_ALLOWED_ORIGINS
# add comma-separated extra entries on top of the defaults (a reverse-proxied
# hostname, a rebranded extension id, or an explicit extra origin).
# --------------------------------------------------------------------------
_DEFAULT_EXTENSION_IDS = ("autoapply@local", "geiaehlmjhdjaglkijniajpkcicebahm")
_LOOPBACK_HOSTNAMES = frozenset({"localhost", "::1"})
_LOOPBACK_IPV4 = re.compile(r"^127(?:\.\d{1,3}){3}$")
_DEFAULT_PORT = "8000"


def _split_env_list(name: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in os.getenv(name, "").split(",") if item.strip())


def _configured_port() -> str:
    port = os.getenv("AUTOAPPLY_PORT", "").strip()
    return port if port.isdigit() and 1 <= int(port) <= 65535 else _DEFAULT_PORT


_EXTENSION_IDS = _DEFAULT_EXTENSION_IDS + tuple(
    extension_id for extension_id in _split_env_list("AUTOAPPLY_EXTENSION_IDS")
    if extension_id not in _DEFAULT_EXTENSION_IDS
)
_EXTRA_ORIGINS = frozenset(
    origin.strip().lower().rstrip("/") for origin in _split_env_list("AUTOAPPLY_ALLOWED_ORIGINS")
)
_EXTENSION_ORIGIN = re.compile(
    r"^(?:chrome|moz)-extension://(?:"
    + "|".join(re.escape(extension_id) for extension_id in _EXTENSION_IDS)
    + r")$"
)

# CORSMiddleware takes a static pattern, so it cannot compare the Origin port
# with the request's own Host port the way the boundary middleware below does.
# It therefore advertises the dashboard origins for the configured port (plus
# any explicit AUTOAPPLY_ALLOWED_ORIGINS) and the pinned extensions; a dashboard
# on a different port still works because its calls are same-origin, which
# needs no CORS headers.
_CORS_WEB_ORIGINS = (
    f"http://localhost:{_configured_port()}",
    f"http://127.0.0.1:{_configured_port()}",
    f"http://[::1]:{_configured_port()}",
) + tuple(sorted(_EXTRA_ORIGINS))
_ALLOWED_ORIGIN_PATTERN = (
    "^("
    + "|".join(re.escape(origin) for origin in _CORS_WEB_ORIGINS)
    + "|(?:chrome|moz)-extension://(?:"
    + "|".join(re.escape(extension_id) for extension_id in _EXTENSION_IDS)
    + "))$"
)


def _hostname(host: str) -> str:
    """Return the hostname part of a Host header value (no port, no brackets)."""
    host = host.strip().lower().rstrip(".")
    if host.startswith("["):                     # [::1]:8000
        return host[1:].split("]", 1)[0]
    if host.count(":") == 1:                     # localhost:8000
        return host.split(":", 1)[0]
    return host                                  # bare ::1 or plain hostname


def _port_of(authority: str, default: int = 80) -> int | None:
    """Return the port of a Host header value (or an origin's authority)."""
    authority = authority.strip()
    if not authority:
        return None
    if authority.startswith("["):                # [::1]:8000
        _, _, tail = authority.partition("]")
        if not tail:
            return default
        if not tail.startswith(":"):
            return None
        tail = tail[1:]
    elif authority.count(":") == 1:              # localhost:8000
        tail = authority.split(":", 1)[1]
    else:                                        # bare ::1 or plain hostname
        return default
    if not tail:                                 # "localhost:" means the default
        return default
    return int(tail) if tail.isdigit() else None


_EXTRA_HOSTS = frozenset(
    _hostname(host) for host in _split_env_list("AUTOAPPLY_ALLOWED_HOSTS")
)


def _is_allowed_host(host: str) -> bool:
    name = _hostname(host)
    return (
        name in _LOOPBACK_HOSTNAMES
        or name in _EXTRA_HOSTS
        or _LOOPBACK_IPV4.fullmatch(name) is not None
    )


def _is_loopback_name(name: str) -> bool:
    return name in _LOOPBACK_HOSTNAMES or _LOOPBACK_IPV4.fullmatch(name) is not None


def _is_trusted_origin(origin: str | None, host: str) -> bool:
    """Allow local CLI calls, the dashboard's own origin, and pinned extensions."""
    if origin is None:
        return True
    origin = origin.strip().lower().rstrip("/")
    if origin in _EXTRA_ORIGINS or _EXTENSION_ORIGIN.fullmatch(origin) is not None:
        return True

    try:
        parts = urlsplit(origin)
        if parts.scheme != "http" or not parts.hostname:
            return False
        origin_port = parts.port if parts.port is not None else 80
    except ValueError:                           # malformed port
        return False
    # The dashboard always calls its own origin: same loopback host family and,
    # crucially, the same port as the Host header this request arrived on.
    return _is_loopback_name(_hostname(parts.hostname)) and origin_port == _port_of(host)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown events."""
    # Startup: create the private data directory. SQLite initializes lazily.
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.chmod(0o700)

    logger.info("AutoApply backend started")
    logger.info(f"Data directory: {DATA_DIR.resolve()}")
    provider = inspect_provider_configuration()
    if provider["configured"]:
        logger.info(provider_status_line())
    else:
        logger.warning(provider_status_line())

    yield  # App runs here

    logger.info("AutoApply backend shutting down")
    from backend.services.database import close_database
    from backend.services.llm_client import close_llm_client

    close_database()
    close_llm_client()


# Create the app
app = FastAPI(
    title="AutoApply API",
    description="AI-powered job application autofill backend",
    version="1.0.0",
    lifespan=lifespan,
)


@app.exception_handler(ProviderNotConfigured)
async def provider_not_configured_handler(request: Request, exc: ProviderNotConfigured):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(ProviderBusy)
async def provider_busy_handler(request: Request, exc: ProviderBusy):
    return JSONResponse(
        status_code=503,
        content={"detail": "AutoApply is busy right now. Try again in a moment."},
    )


@app.exception_handler(LLMResponseError)
async def llm_response_error_handler(request: Request, exc: LLMResponseError):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.middleware("http")
async def enforce_local_boundary(request, call_next):
    """Enforce the localhost boundary server-side, including simple form requests."""
    path = request.url.path
    host = request.headers.get("host") or ""
    if path.startswith("/api/") and (
        not _is_allowed_host(host)
        or not _is_trusted_origin(request.headers.get("origin"), host)
    ):
        return JSONResponse(
            status_code=403,
            content={"detail": "This local API only accepts extension or local requests."},
        )

    response = await call_next(request)
    if not path.startswith("/api/"):
        # The dashboard origin is trusted by the API above, so it must not be
        # framable: a framed dashboard could be clickjacked into its own writes.
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Content-Security-Policy", "frame-ancestors 'none'")
        if not path.startswith("/dashboard/static/"):
            response.headers.setdefault("Cache-Control", "no-store")
    return response

# API requests are proxied by the extension background context. Only pinned
# extension origins (plus the dashboard's configured port) need cross-origin
# access; allowing every website here would expose the user's local profile
# and application data. The boundary middleware above is the authority on
# trust; this only decides which origins get CORS response headers.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=_ALLOWED_ORIGIN_PATTERN,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import and include routers
from backend.routers import profile, autofill, applications, workspace, setup

app.include_router(profile.router)
app.include_router(autofill.router)
app.include_router(applications.router)
app.include_router(workspace.router)
app.include_router(setup.router)

# Mount dashboard static files
dashboard_dir = Path(__file__).parent / "dashboard"
if dashboard_dir.exists():
    app.mount("/dashboard/static", StaticFiles(directory=str(dashboard_dir)), name="dashboard-static")


@app.get("/dashboard")
async def serve_dashboard():
    """Serve the applications history dashboard Web UI."""
    if not dashboard_dir.exists():
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Dashboard UI not found.")
    return FileResponse(str(dashboard_dir / "index.html"))


@app.get("/api/health")
def health_check():
    """Health check endpoint for the extension to verify backend connectivity."""
    profile_exists = (DATA_DIR / "profile.json").exists()
    resume_exists = (DATA_DIR / "resume.pdf").exists()
    knowledge_exists = (DATA_DIR / "knowledge.md").exists()

    from backend.services.database import get_database
    from backend.services.llm_client import inspect_provider_configuration

    app_count = get_database().count_applications()
    provider_config = inspect_provider_configuration()

    return {
        "status": "healthy",
        "profile_loaded": profile_exists,
        "resume_uploaded": resume_exists,
        "knowledge_loaded": knowledge_exists,
        "total_applications": app_count,
        "ai_provider": provider_config["provider"],
        "ai_model": provider_config["model"],
        "ai_ready": provider_config["configured"],
        "ai_error": provider_config["error"],
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host=os.getenv("AUTOAPPLY_HOST", "127.0.0.1"),
        port=int(os.getenv("AUTOAPPLY_PORT", "8000")),
        reload=False,
        log_level="info",
    )

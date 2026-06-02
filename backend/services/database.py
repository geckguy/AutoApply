"""SQLite database service for AutoApply — replaces JSON file storage."""

import json
import logging
import sqlite3
from pathlib import Path
import threading

logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).parent.parent / "data" / "autoapply.db"
DATA_DIR = Path(__file__).parent.parent / "data"


class Database:
    """Thin wrapper around an SQLite connection for AutoApply data."""

    def __init__(self) -> None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self._write_lock = threading.Lock()
        self._init_tables()

    @staticmethod
    def _escape_like(s: str) -> str:
        return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    # ------------------------------------------------------------------
    # Schema
    # ------------------------------------------------------------------

    def _init_tables(self) -> None:
        """Create tables if they don't exist and migrate legacy JSON data."""
        cur = self.conn.cursor()
        cur.executescript(
            """
            CREATE TABLE IF NOT EXISTS applications (
                id                    TEXT PRIMARY KEY,
                company               TEXT,
                role                  TEXT,
                url                   TEXT,
                platform              TEXT,
                applied_at            TEXT,
                fit_score             REAL,
                status                TEXT,
                notes                 TEXT,
                job_description_snippet TEXT
            );

            CREATE TABLE IF NOT EXISTS corrections (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp    TEXT,
                field_label  TEXT,
                agent_value  TEXT,
                user_value   TEXT,
                context      TEXT,
                url          TEXT
            );

            CREATE TABLE IF NOT EXISTS answer_bank (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                company       TEXT,
                role          TEXT,
                question_type TEXT,
                question      TEXT,
                answer        TEXT,
                date          TEXT
            );
            """
        )
        self.conn.commit()
        self._migrate_json_data()

    def _migrate_json_data(self) -> None:
        """One-time migration of existing JSON files into SQLite."""
        cur = self.conn.cursor()

        # --- applications.json ---
        apps_path = DATA_DIR / "applications.json"
        if apps_path.exists():
            count = cur.execute("SELECT COUNT(*) FROM applications").fetchone()[0]
            if count == 0:
                try:
                    with open(apps_path, "r") as f:
                        apps = json.load(f)
                    for a in apps:
                        cur.execute(
                            "INSERT OR IGNORE INTO applications "
                            "(id, company, role, url, platform, applied_at, "
                            "fit_score, status, notes, job_description_snippet) "
                            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            (
                                a.get("id"),
                                a.get("company"),
                                a.get("role"),
                                a.get("url"),
                                a.get("platform"),
                                a.get("applied_at"),
                                a.get("fit_score"),
                                a.get("status", "applied"),
                                a.get("notes"),
                                a.get("job_description_snippet"),
                            ),
                        )
                    self.conn.commit()
                    logger.info("Migrated %d applications from JSON to SQLite", len(apps))
                except Exception:
                    logger.exception("Failed to migrate applications.json")

        # --- corrections.json ---
        corrections_path = DATA_DIR / "corrections.json"
        if corrections_path.exists():
            count = cur.execute("SELECT COUNT(*) FROM corrections").fetchone()[0]
            if count == 0:
                try:
                    with open(corrections_path, "r") as f:
                        corrections = json.load(f)
                    for c in corrections:
                        cur.execute(
                            "INSERT INTO corrections "
                            "(timestamp, field_label, agent_value, user_value, context, url) "
                            "VALUES (?, ?, ?, ?, ?, ?)",
                            (
                                c.get("timestamp"),
                                c.get("field_label"),
                                c.get("agent_value"),
                                c.get("user_value"),
                                c.get("context"),
                                c.get("url"),
                            ),
                        )
                    self.conn.commit()
                    logger.info("Migrated %d corrections from JSON to SQLite", len(corrections))
                except Exception:
                    logger.exception("Failed to migrate corrections.json")

        # --- answer_bank.json ---
        ab_path = DATA_DIR / "answer_bank.json"
        if ab_path.exists():
            count = cur.execute("SELECT COUNT(*) FROM answer_bank").fetchone()[0]
            if count == 0:
                try:
                    with open(ab_path, "r") as f:
                        entries = json.load(f)
                    for e in entries:
                        cur.execute(
                            "INSERT INTO answer_bank "
                            "(company, role, question_type, question, answer, date) "
                            "VALUES (?, ?, ?, ?, ?, ?)",
                            (
                                e.get("company"),
                                e.get("role"),
                                e.get("question_type"),
                                e.get("question"),
                                e.get("answer"),
                                e.get("date"),
                            ),
                        )
                    self.conn.commit()
                    logger.info("Migrated %d answer bank entries from JSON to SQLite", len(entries))
                except Exception:
                    logger.exception("Failed to migrate answer_bank.json")

    # ------------------------------------------------------------------
    # Applications
    # ------------------------------------------------------------------

    def add_application(self, app_dict: dict) -> None:
        """Insert a new application row."""
        with self._write_lock:
            self.conn.execute(
                "INSERT INTO applications "
                "(id, company, role, url, platform, applied_at, "
                "fit_score, status, notes, job_description_snippet) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    app_dict.get("id"),
                    app_dict.get("company"),
                    app_dict.get("role"),
                    app_dict.get("url"),
                    app_dict.get("platform"),
                    app_dict.get("applied_at"),
                    app_dict.get("fit_score"),
                    app_dict.get("status", "applied"),
                    app_dict.get("notes"),
                    app_dict.get("job_description_snippet"),
                ),
            )
            self.conn.commit()

    def count_applications(self) -> int:
        """Return total count of applications."""
        return self.conn.execute("SELECT COUNT(*) FROM applications").fetchone()[0]

    def get_applications(
        self, limit: int = 50, status: str | None = None
    ) -> list[dict]:
        """Return applications ordered by applied_at descending."""
        if status:
            rows = self.conn.execute(
                "SELECT * FROM applications WHERE status = ? "
                "ORDER BY applied_at DESC LIMIT ?",
                (status, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM applications ORDER BY applied_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_application_by_id(self, app_id: str) -> dict | None:
        """Return a single application or None."""
        row = self.conn.execute(
            "SELECT * FROM applications WHERE id = ?", (app_id,)
        ).fetchone()
        return dict(row) if row else None

    def update_application_status(
        self, app_id: str, status: str, notes: str | None = None
    ) -> bool:
        """Update status (and optionally notes). Returns True if found."""
        with self._write_lock:
            if notes is not None:
                cur = self.conn.execute(
                    "UPDATE applications SET status = ?, notes = ? WHERE id = ?",
                    (status, notes, app_id),
                )
            else:
                cur = self.conn.execute(
                    "UPDATE applications SET status = ? WHERE id = ?",
                    (status, app_id),
                )
            self.conn.commit()
            return cur.rowcount > 0

    def check_duplicate_url(self, normalized_url: str) -> dict | None:
        """Check for an application with a matching URL (LIKE match)."""
        row = self.conn.execute(
            "SELECT * FROM applications WHERE url LIKE ? ESCAPE '\\'",
            (f"%{self._escape_like(normalized_url)}%",),
        ).fetchone()
        return dict(row) if row else None

    def check_duplicate_company_role(
        self, company: str, role: str
    ) -> dict | None:
        """Check for a company+role fuzzy match (case-insensitive LIKE)."""
        rows = self.conn.execute(
            "SELECT * FROM applications WHERE "
            "LOWER(company) LIKE ? ESCAPE '\\' AND LOWER(role) LIKE ? ESCAPE '\\'",
            (f"%{self._escape_like(company.lower().strip())}%", f"%{self._escape_like(role.lower().strip())}%"),
        ).fetchall()
        # Also check the reverse containment
        if not rows:
            all_apps = self.conn.execute("SELECT * FROM applications").fetchall()
            for app in all_apps:
                c = app["company"].lower()
                r = app["role"].lower()
                cl = company.lower().strip()
                rl = role.lower().strip()
                if (cl in c or c in cl) and (rl in r or r in rl):
                    return dict(app)
            return None
        return dict(rows[0])

    # ------------------------------------------------------------------
    # Corrections
    # ------------------------------------------------------------------

    def add_correction(self, correction_dict: dict) -> int:
        """Insert a correction and return the total count."""
        with self._write_lock:
            self.conn.execute(
                "INSERT INTO corrections "
                "(timestamp, field_label, agent_value, user_value, context, url) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    correction_dict.get("timestamp"),
                    correction_dict.get("field_label"),
                    correction_dict.get("agent_value"),
                    correction_dict.get("user_value"),
                    correction_dict.get("context"),
                    correction_dict.get("url"),
                ),
            )
            self.conn.commit()
            count = self.conn.execute("SELECT COUNT(*) FROM corrections").fetchone()[0]
            return count

    def get_recent_corrections(self, limit: int = 50) -> list[dict]:
        """Return the most recent corrections."""
        rows = self.conn.execute(
            "SELECT * FROM corrections ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(row) for row in rows]

    # ------------------------------------------------------------------
    # Answer Bank
    # ------------------------------------------------------------------

    def add_answer(self, answer_dict: dict) -> None:
        """Insert an answer bank entry."""
        with self._write_lock:
            self.conn.execute(
                "INSERT INTO answer_bank "
                "(company, role, question_type, question, answer, date) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    answer_dict.get("company"),
                    answer_dict.get("role"),
                    answer_dict.get("question_type"),
                    answer_dict.get("question"),
                    answer_dict.get("answer"),
                    answer_dict.get("date"),
                ),
            )
            self.conn.commit()

    def get_answers(self) -> list[dict]:
        """Return all answer bank entries."""
        rows = self.conn.execute("SELECT * FROM answer_bank").fetchall()
        return [dict(row) for row in rows]

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close the database connection."""
        self.conn.close()


# ---- Module-level singleton ----

_db: Database | None = None
_db_lock = threading.Lock()


def get_database() -> Database:
    """Return the module-level Database singleton, creating it on first call."""
    global _db
    if _db is None:
        with _db_lock:
            if _db is None:
                _db = Database()
    return _db

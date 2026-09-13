"""SQLite database service for AutoApply — replaces JSON file storage."""

import json
import logging
import sqlite3
import hashlib
from pathlib import Path
import threading
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).parent.parent / "data" / "autoapply.db"
DATA_DIR = Path(__file__).parent.parent / "data"


class Database:
    """Thin wrapper around an SQLite connection for AutoApply data."""

    def __init__(self, db_path: Path | str | None = None) -> None:
        self.db_path = Path(db_path) if db_path is not None else DB_PATH
        self.data_dir = self.db_path.parent
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.chmod(0o700)
        self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.db_path.chmod(0o600)
        self._write_lock = threading.Lock()
        self._init_tables()

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _decode_row(row: sqlite3.Row | None) -> dict | None:
        if row is None:
            return None
        result = dict(row)
        for key in list(result):
            if key.endswith("_json") and result[key]:
                try:
                    result[key.removesuffix("_json")] = json.loads(result[key])
                except json.JSONDecodeError:
                    result[key.removesuffix("_json")] = {}
        return result

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

            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );

            -- Canonical workspace record. Existing applications are copied here
            -- once and all legacy writes are mirrored below for compatibility.
            CREATE TABLE IF NOT EXISTS opportunities (
                id TEXT PRIMARY KEY, company TEXT NOT NULL, role TEXT NOT NULL,
                url TEXT, normalized_url TEXT, platform TEXT, status TEXT NOT NULL,
                source TEXT, fit_score REAL, job_description TEXT, notes TEXT,
                resume_version_id TEXT, target_date TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
                legacy_application_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                submitted_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_opportunities_url ON opportunities(normalized_url);

            CREATE TABLE IF NOT EXISTS resume_versions (
                id TEXT PRIMARY KEY, filename TEXT NOT NULL, label TEXT, sha256 TEXT UNIQUE NOT NULL,
                storage_path TEXT, artifacts_json TEXT NOT NULL DEFAULT '{}', profile_snapshot_json TEXT NOT NULL DEFAULT '{}',
                is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS answer_vault (
                id TEXT PRIMARY KEY, question_key TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
                question_type TEXT, company TEXT, role TEXT, platform TEXT, tags_json TEXT NOT NULL DEFAULT '[]',
                source TEXT, approved INTEGER NOT NULL DEFAULT 0, use_count INTEGER NOT NULL DEFAULT 0,
                legacy_answer_id INTEGER UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_answer_vault_question ON answer_vault(question_key);
            CREATE TABLE IF NOT EXISTS field_policies (
                id TEXT PRIMARY KEY, field_key TEXT UNIQUE NOT NULL, label TEXT, description TEXT,
                action TEXT NOT NULL, value_json TEXT, confidence TEXT, scope_json TEXT NOT NULL DEFAULT '{}',
                enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS learned_mappings (
                id TEXT PRIMARY KEY, field_fingerprint TEXT UNIQUE NOT NULL, field_label TEXT, input_type TEXT,
                source_path TEXT, domain TEXT, value_json TEXT, confidence TEXT, evidence_count INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS application_packets (
                id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, resume_version_id TEXT, stage TEXT,
                page_url TEXT, instructions_json TEXT NOT NULL DEFAULT '[]', field_failures_json TEXT NOT NULL DEFAULT '[]',
                cover_letter TEXT, tailored_resume TEXT, form_snapshot_json TEXT NOT NULL DEFAULT '{}', status TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_packets_opportunity ON application_packets(opportunity_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS application_answers (
                id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, field_key TEXT NOT NULL, question TEXT,
                value_json TEXT, source TEXT, confidence TEXT, approved INTEGER NOT NULL DEFAULT 0,
                answer_vault_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE(opportunity_id, field_key)
            );
            CREATE TABLE IF NOT EXISTS submission_receipts (
                id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, packet_id TEXT, submitted_at TEXT NOT NULL,
                confirmation_code TEXT, confirmation_url TEXT, screenshot_path TEXT, details_json TEXT NOT NULL DEFAULT '{}',
                user_confirmed INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT, phone TEXT,
                title TEXT, relationship TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS follow_ups (
                id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, contact_id TEXT, due_at TEXT NOT NULL, kind TEXT,
                notes TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS interviews (
                id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, scheduled_at TEXT NOT NULL, interview_type TEXT,
                timezone TEXT, location TEXT, interviewer_names_json TEXT NOT NULL DEFAULT '[]', notes TEXT,
                outcome TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            """
        )
        self.conn.commit()
        learned_columns = {row["name"] for row in self.conn.execute("PRAGMA table_info(learned_mappings)")}
        if "domain" not in learned_columns:
            # Databases created before corrections were scoped to a site.
            self.conn.execute("ALTER TABLE learned_mappings ADD COLUMN domain TEXT")
            self.conn.commit()
        self._migrate_json_data()
        self._migrate_workspace_data()

    def _migrate_workspace_data(self) -> None:
        """Copy legacy records into additive workspace tables exactly once."""
        with self._write_lock, self.conn:
            now = self._now()
            for app in self.conn.execute("SELECT * FROM applications").fetchall():
                item = dict(app)
                self.conn.execute(
                    "INSERT OR IGNORE INTO opportunities "
                    "(id,company,role,url,normalized_url,platform,status,source,fit_score,job_description,notes,"
                    "legacy_application_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (item["id"], item.get("company") or "Unknown", item.get("role") or "Unknown", item.get("url"),
                     self._normalize_url(item.get("url") or ""), item.get("platform"), item.get("status") or "applied",
                     "legacy", item.get("fit_score"), item.get("job_description_snippet"), item.get("notes"),
                     item["id"], item.get("applied_at") or now, now),
                )
            for answer in self.conn.execute("SELECT * FROM answer_bank").fetchall():
                item = dict(answer)
                question = item.get("question") or ""
                key = hashlib.sha256(question.casefold().strip().encode()).hexdigest()
                self.conn.execute(
                    "INSERT OR IGNORE INTO answer_vault "
                    "(id,question_key,question,answer,question_type,company,role,source,approved,legacy_answer_id,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (f"legacy-answer-{item['id']}", key, question, item.get("answer") or "", item.get("question_type"),
                     item.get("company"), item.get("role"), "legacy", 1, item["id"], item.get("date") or now, now),
                )
            self.conn.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)", (now,))
            self.conn.commit()

    @staticmethod
    def _normalize_url(url: str) -> str:
        return url.split("?", 1)[0].split("#", 1)[0].rstrip("/").lower()

    @staticmethod
    def _hostname(url: str) -> str:
        """Return the lower-case hostname of a URL or bare host ("" when absent)."""
        value = str(url or "").strip()
        if not value:
            return ""
        parsed = urlparse(value if "://" in value else f"//{value}")
        return (parsed.hostname or "").casefold()

    def _migrate_json_data(self) -> None:
        """One-time migration of existing JSON files into SQLite."""
        with self._write_lock, self.conn:
            cur = self.conn.cursor()

            # --- applications.json ---
            apps_path = self.data_dir / "applications.json"
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
                        self.conn.rollback()
                        logger.exception("Failed to migrate applications.json")

            # --- corrections.json ---
            corrections_path = self.data_dir / "corrections.json"
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
                        self.conn.rollback()
                        logger.exception("Failed to migrate corrections.json")

            # --- answer_bank.json ---
            ab_path = self.data_dir / "answer_bank.json"
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
                        self.conn.rollback()
                        logger.exception("Failed to migrate answer_bank.json")

    # ------------------------------------------------------------------
    # Applications
    # ------------------------------------------------------------------

    def add_application(self, app_dict: dict) -> None:
        """Insert a new application row."""
        with self._write_lock, self.conn:
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
            now = self._now()
            self.conn.execute(
                "INSERT OR IGNORE INTO opportunities "
                "(id,company,role,url,normalized_url,platform,status,source,fit_score,job_description,notes,legacy_application_id,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    app_dict.get("id"), app_dict.get("company") or "Unknown", app_dict.get("role") or "Unknown",
                    app_dict.get("url"), self._normalize_url(app_dict.get("url") or ""), app_dict.get("platform"),
                    app_dict.get("status", "applied"), "application", app_dict.get("fit_score"),
                    app_dict.get("job_description_snippet"), app_dict.get("notes"), app_dict.get("id"),
                    app_dict.get("applied_at") or now, now,
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
        with self._write_lock, self.conn:
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
            self.conn.execute(
                "UPDATE opportunities SET status=?, notes=COALESCE(?, notes), updated_at=? "
                "WHERE id=? OR legacy_application_id=?",
                (status, notes, self._now(), app_id, app_id),
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
        with self._write_lock, self.conn:
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
        with self._write_lock, self.conn:
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

    def get_answers(self, limit: int = 100) -> list[dict]:
        """Return the most recent answer bank entries."""
        rows = self.conn.execute(
            "SELECT * FROM answer_bank ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(row) for row in rows]

    def find_similar_answers(self, question: str, limit: int = 5) -> list[dict]:
        """Find past answers where the question shares keywords."""
        keywords = [w.lower().strip() for w in question.split() if len(w) > 3]
        if not keywords:
            return self.get_answers()[:limit]
        
        # Match any keyword
        conditions = " OR ".join(["LOWER(question) LIKE ? ESCAPE '\\'" for _ in keywords])
        params = [f"%{self._escape_like(kw)}%" for kw in keywords]
        params.append(limit)
        
        rows = self.conn.execute(
            f"SELECT * FROM answer_bank WHERE {conditions} "
            f"ORDER BY id DESC LIMIT ?",
            params
        ).fetchall()
        return [dict(row) for row in rows]

    # ------------------------------------------------------------------
    # Workspace (additive v1 schema)
    # ------------------------------------------------------------------

    def upsert_opportunity(self, item: dict) -> dict:
        now = self._now()
        url = item.get("url")
        opportunity = {
            "id": item["id"], "company": item["company"], "role": item["role"], "url": url,
            "normalized_url": self._normalize_url(url or ""), "platform": item.get("platform"),
            "status": item.get("status", "draft"), "source": item.get("source"),
            "fit_score": item.get("fit_score"),
            "job_description": item.get("job_description") or item.get("job_description_snippet"),
            "notes": item.get("notes"), "resume_version_id": item.get("resume_version_id"),
            "target_date": item.get("target_date"), "metadata_json": self._json({
                **item.get("metadata", {}), **({"page_title": item["page_title"]} if item.get("page_title") else {})
            }), "created_at": now, "updated_at": now,
        }
        columns = list(opportunity)
        assignments = ", ".join(f"{col}=excluded.{col}" for col in columns if col not in {"id", "created_at"})
        with self._write_lock, self.conn:
            self.conn.execute(
                f"INSERT INTO opportunities ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)}) "
                f"ON CONFLICT(id) DO UPDATE SET {assignments}",
                tuple(opportunity[col] for col in columns),
            )
            # Keep the legacy history/pipeline API useful for saved opportunities.
            legacy_status = {
                "draft": "ready_to_review", "saved": "ready_to_review",
                "preparing": "ready_to_review", "submitted": "applied",
            }.get(opportunity["status"], opportunity["status"])
            self.conn.execute(
                "INSERT INTO applications (id,company,role,url,platform,applied_at,fit_score,status,notes,job_description_snippet) "
                "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET company=excluded.company,role=excluded.role,"
                "url=excluded.url,platform=excluded.platform,fit_score=COALESCE(excluded.fit_score,applications.fit_score),"
                "status=excluded.status,notes=COALESCE(excluded.notes,applications.notes),"
                "job_description_snippet=COALESCE(excluded.job_description_snippet,applications.job_description_snippet)",
                (opportunity["id"], opportunity["company"], opportunity["role"], url or "", opportunity["platform"],
                 now, opportunity["fit_score"], legacy_status, opportunity["notes"], opportunity["job_description"]),
            )
            self.conn.commit()
        return self.get_opportunity(item["id"]) or {}

    def get_opportunity(self, opportunity_id: str) -> dict | None:
        return self._decode_row(self.conn.execute("SELECT * FROM opportunities WHERE id=?", (opportunity_id,)).fetchone())

    def list_opportunities(
        self,
        limit: int = 100,
        status: str | None = None,
        search: str | None = None,
        sort: str = "updated_desc",
    ) -> list[dict]:
        clauses: list[str] = []
        params: list[Any] = []
        if status:
            statuses = [value.strip() for value in status.split(",") if value.strip()]
            if statuses:
                clauses.append(f"status IN ({','.join('?' for _ in statuses)})")
                params.extend(statuses)
        if search and search.strip():
            needle = f"%{self._escape_like(search.strip().casefold())}%"
            clauses.append(
                "(LOWER(company) LIKE ? ESCAPE '\\' OR LOWER(role) LIKE ? ESCAPE '\\' "
                "OR LOWER(COALESCE(platform,'')) LIKE ? ESCAPE '\\')"
            )
            params.extend((needle, needle, needle))
        order_by = {
            "updated_desc": "updated_at DESC",
            "created_desc": "created_at DESC",
            "fit_desc": "fit_score IS NULL, fit_score DESC, updated_at DESC",
            "target_asc": "target_date IS NULL, target_date ASC, updated_at DESC",
        }.get(sort, "updated_at DESC")
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(limit)
        rows = self.conn.execute(
            f"SELECT * FROM opportunities{where} ORDER BY {order_by} LIMIT ?",
            tuple(params),
        ).fetchall()
        return [self._decode_row(row) for row in rows]

    def find_duplicate_opportunities(
        self, url: str = "", company: str = "", role: str = "", limit: int = 5
    ) -> list[dict]:
        """Return exact URL matches first, followed by conservative company/role matches."""
        normalized_url = self._normalize_url(url)
        matches: list[dict] = []
        seen: set[str] = set()
        if normalized_url:
            rows = self.conn.execute(
                "SELECT * FROM opportunities WHERE normalized_url=? ORDER BY updated_at DESC LIMIT ?",
                (normalized_url, limit),
            ).fetchall()
            for row in rows:
                item = self._decode_row(row) or {}
                item.update({"match_type": "exact_url", "match_reason": "Same application URL"})
                matches.append(item)
                seen.add(str(item.get("id")))

        company_key, role_key = company.casefold().strip(), role.casefold().strip()
        if company_key and role_key and len(matches) < limit:
            for item in self.list_opportunities(500):
                if str(item.get("id")) in seen:
                    continue
                existing_company = str(item.get("company") or "").casefold().strip()
                existing_role = str(item.get("role") or "").casefold().strip()
                company_matches = company_key in existing_company or existing_company in company_key
                role_matches = role_key in existing_role or existing_role in role_key
                if company_matches and role_matches:
                    item.update({"match_type": "company_role", "match_reason": "Same company and similar role"})
                    matches.append(item)
                    seen.add(str(item.get("id")))
                if len(matches) >= limit:
                    break
        return matches

    def patch_opportunity(self, opportunity_id: str, changes: dict) -> dict | None:
        allowed = {"company", "role", "url", "platform", "status", "source", "fit_score", "job_description", "notes", "resume_version_id", "target_date"}
        values = {key: value for key, value in changes.items() if key in allowed and value is not None}
        if "job_description_snippet" in changes and changes["job_description_snippet"] is not None:
            values["job_description"] = changes["job_description_snippet"]
        if "page_title" in changes and changes["page_title"] is not None:
            current = self.get_opportunity(opportunity_id)
            if current is None:
                return None
            values["metadata_json"] = self._json({**current.get("metadata", {}), "page_title": changes["page_title"]})
        if "metadata" in changes and changes["metadata"] is not None:
            values["metadata_json"] = self._json(changes["metadata"])
        if "url" in values:
            values["normalized_url"] = self._normalize_url(values["url"])
        if not values:
            return self.get_opportunity(opportunity_id)
        values["updated_at"] = self._now()
        with self._write_lock, self.conn:
            cur = self.conn.execute(
                f"UPDATE opportunities SET {', '.join(f'{key}=?' for key in values)} WHERE id=?",
                (*values.values(), opportunity_id),
            )
            if "status" in values:
                legacy_status = {
                    "draft": "ready_to_review", "saved": "ready_to_review",
                    "preparing": "ready_to_review", "submitted": "applied",
                }.get(str(values["status"]), str(values["status"]))
                self.conn.execute(
                    "UPDATE applications SET status=? WHERE id=?",
                    (legacy_status, opportunity_id),
                )
            legacy_columns = {"company", "role", "url", "platform", "fit_score", "notes"} & values.keys()
            if legacy_columns:
                self.conn.execute(
                    f"UPDATE applications SET {', '.join(f'{key}=?' for key in legacy_columns)} WHERE id=?",
                    (*(values[key] for key in legacy_columns), opportunity_id),
                )
            self.conn.commit()
        return self.get_opportunity(opportunity_id) if cur.rowcount else None

    def upsert_resume_version(self, item: dict) -> dict:
        now = self._now()
        item = dict(item)
        duplicate = self.conn.execute(
            "SELECT id FROM resume_versions WHERE sha256=? AND id<>?",
            (item["sha256"], item["id"]),
        ).fetchone()
        if duplicate:
            # Identical content is one version even if two tailoring requests
            # generated it; this also satisfies the schema's content hash guard.
            item["id"] = duplicate["id"]
        artifacts = item.get("artifacts", {})
        with self._write_lock, self.conn:
            if item.get("make_active") or item.get("is_default"):
                self.conn.execute("UPDATE resume_versions SET is_default=0")
            self.conn.execute(
                "INSERT INTO resume_versions (id,filename,label,sha256,storage_path,artifacts_json,profile_snapshot_json,is_default,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET filename=excluded.filename,label=excluded.label,"
                "storage_path=excluded.storage_path,artifacts_json=excluded.artifacts_json,profile_snapshot_json=excluded.profile_snapshot_json,"
                "is_default=excluded.is_default,updated_at=excluded.updated_at",
                (item["id"], item["filename"], item.get("label") or item["filename"], item["sha256"], item.get("storage_path"),
                 self._json(artifacts), self._json(item.get("profile_snapshot", {})), int(item.get("make_active") or item.get("is_default")), now, now),
            )
            self.conn.commit()
        return self.get_resume_version(item["id"]) or {}

    def get_resume_version(self, version_id: str) -> dict | None:
        return self._decode_row(self.conn.execute("SELECT * FROM resume_versions WHERE id=?", (version_id,)).fetchone())

    def list_resume_versions(self) -> list[dict]:
        rows = self.conn.execute("SELECT * FROM resume_versions ORDER BY is_default DESC, created_at DESC").fetchall()
        return [self._decode_row(row) for row in rows]

    def set_resume_default(self, version_id: str, is_default: bool) -> dict | None:
        with self._write_lock, self.conn:
            if is_default:
                self.conn.execute("UPDATE resume_versions SET is_default=0")
            cur = self.conn.execute("UPDATE resume_versions SET is_default=?, updated_at=? WHERE id=?", (int(is_default), self._now(), version_id))
            self.conn.commit()
        return self.get_resume_version(version_id) if cur.rowcount else None

    def upsert_answer_vault(self, item: dict) -> dict:
        now = self._now()
        key = hashlib.sha256(item["question"].casefold().strip().encode()).hexdigest()
        with self._write_lock, self.conn:
            self.conn.execute(
                "INSERT INTO answer_vault (id,question_key,question,answer,question_type,company,role,platform,tags_json,source,approved,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET question=excluded.question,answer=excluded.answer,"
                "question_type=excluded.question_type,company=excluded.company,role=excluded.role,platform=excluded.platform,tags_json=excluded.tags_json,"
                "source=excluded.source,approved=excluded.approved,updated_at=excluded.updated_at",
                (item["id"], key, item["question"], item["answer"], item.get("question_type"), item.get("company"), item.get("role"),
                 item.get("platform"), self._json(item.get("tags", [])), item.get("source"), int(item.get("approved", False)), now, now),
            )
            self.conn.commit()
        return self._decode_row(self.conn.execute("SELECT * FROM answer_vault WHERE id=?", (item["id"],)).fetchone()) or {}

    def list_answer_vault(self, limit: int = 100) -> list[dict]:
        return [self._decode_row(row) for row in self.conn.execute("SELECT * FROM answer_vault ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()]

    def patch_answer_vault(self, answer_id: str, changes: dict) -> dict | None:
        allowed = {"question", "answer", "question_type", "company", "role", "platform", "source"}
        values = {key: value for key, value in changes.items() if key in allowed and value is not None}
        if "approved" in changes:
            values["approved"] = int(bool(changes["approved"]))
        if "tags" in changes:
            values["tags_json"] = self._json(changes["tags"])
        if not values:
            row = self.conn.execute("SELECT * FROM answer_vault WHERE id=?", (answer_id,)).fetchone()
            return self._decode_row(row)
        values["updated_at"] = self._now()
        with self._write_lock, self.conn:
            cur = self.conn.execute(
                f"UPDATE answer_vault SET {', '.join(f'{key}=?' for key in values)} WHERE id=?",
                (*values.values(), answer_id),
            )
            self.conn.commit()
        row = self.conn.execute("SELECT * FROM answer_vault WHERE id=?", (answer_id,)).fetchone()
        return self._decode_row(row) if cur.rowcount else None

    def upsert_policy(self, item: dict) -> dict:
        now = self._now()
        policy_id = item.get("id") or item["field_key"]
        action = item.get("action", "ask")
        with self._write_lock, self.conn:
            self.conn.execute(
                "INSERT INTO field_policies (id,field_key,label,description,action,value_json,confidence,scope_json,enabled,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(field_key) DO UPDATE SET label=excluded.label,description=excluded.description,"
                "action=excluded.action,value_json=excluded.value_json,confidence=excluded.confidence,scope_json=excluded.scope_json,enabled=excluded.enabled,updated_at=excluded.updated_at",
                (policy_id, item["field_key"], item.get("label"), item.get("description"), action, self._json(item.get("value")), item.get("confidence"),
                 self._json(item.get("scope", {})), int(item.get("enabled", True)), now, now),
            )
            self.conn.commit()
        return self._decode_row(self.conn.execute("SELECT * FROM field_policies WHERE field_key=?", (item["field_key"],)).fetchone()) or {}

    def list_policies(self) -> list[dict]:
        return [self._decode_row(row) for row in self.conn.execute("SELECT * FROM field_policies ORDER BY updated_at DESC").fetchall()]

    def get_field_policies(self) -> list[dict]:
        """Compatibility name consumed by the hybrid autofill mapper."""
        return [item for item in self.list_policies() if item.get("enabled")]

    def set_policies_enabled(self, policies: list[dict]) -> list[dict]:
        with self._write_lock, self.conn:
            for policy in policies:
                self.conn.execute(
                    "UPDATE field_policies SET enabled=?, action=COALESCE(?, action), updated_at=? WHERE id=?",
                    (int(bool(policy.get("enabled"))), policy.get("action"), self._now(), policy["id"]),
                )
            self.conn.commit()
        return self.list_policies()

    def upsert_mapping(self, item: dict) -> dict:
        now = self._now()
        identifier = hashlib.sha256(item["field_fingerprint"].encode()).hexdigest()[:32]
        with self._write_lock, self.conn:
            self.conn.execute(
                "INSERT INTO learned_mappings (id,field_fingerprint,field_label,input_type,source_path,domain,value_json,confidence,evidence_count,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(field_fingerprint) DO UPDATE SET field_label=excluded.field_label,input_type=excluded.input_type,"
                "source_path=excluded.source_path,domain=COALESCE(excluded.domain,learned_mappings.domain),value_json=excluded.value_json,confidence=excluded.confidence,evidence_count=learned_mappings.evidence_count + excluded.evidence_count,updated_at=excluded.updated_at",
                (identifier, item["field_fingerprint"], item.get("field_label"), item.get("input_type"), item.get("source_path"),
                 item.get("domain"), self._json(item.get("value")),
                 item.get("confidence"), item.get("evidence_increment", 1), now, now),
            )
            self.conn.commit()
        return self._decode_row(self.conn.execute("SELECT * FROM learned_mappings WHERE field_fingerprint=?", (item["field_fingerprint"],)).fetchone()) or {}

    def get_learned_mappings(self) -> list[dict]:
        rows = self.conn.execute("SELECT * FROM learned_mappings ORDER BY evidence_count DESC, updated_at DESC").fetchall()
        return [self._decode_row(row) for row in rows]

    def upsert_learned_mapping(self, item: dict) -> dict:
        """Accept correction-shaped input and convert it to a stable mapping."""
        label = item.get("field_label") or item.get("field_key") or "unknown"
        url = item.get("url") or ""
        fingerprint = item.get("field_fingerprint") or f"{self._normalize_url(url)}|{label.casefold().strip()}"
        domain = item.get("domain") or self._hostname(url)
        return self.upsert_mapping(
            {
                "field_fingerprint": fingerprint,
                "field_label": label,
                "input_type": item.get("input_type"),
                "source_path": item.get("source_path"),
                "domain": domain,
                "value": item.get("value", item.get("user_value")),
                "confidence": item.get("confidence", "high"),
                "evidence_increment": item.get("evidence_increment", 1),
            }
        )

    def upsert_packet(self, item: dict) -> dict:
        now = self._now()
        packet_id = item["id"]
        with self._write_lock, self.conn:
            self.conn.execute(
                "INSERT INTO application_packets "
                "(id,opportunity_id,resume_version_id,stage,page_url,instructions_json,field_failures_json,cover_letter,tailored_resume,form_snapshot_json,status,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET resume_version_id=excluded.resume_version_id,"
                "stage=excluded.stage,page_url=excluded.page_url,instructions_json=excluded.instructions_json,"
                "field_failures_json=excluded.field_failures_json,cover_letter=COALESCE(excluded.cover_letter,application_packets.cover_letter),"
                "tailored_resume=COALESCE(excluded.tailored_resume,application_packets.tailored_resume),"
                "form_snapshot_json=excluded.form_snapshot_json,status=excluded.status,updated_at=excluded.updated_at",
                (packet_id, item["opportunity_id"], item.get("resume_version_id"), item.get("stage", "review"), item.get("page_url"),
                 self._json(item.get("instructions", [])), self._json(item.get("field_failures", [])), item.get("cover_letter"),
                 item.get("tailored_resume"), self._json(item.get("form_snapshot", {})), item.get("status", "draft"), now, now),
            )
            self.conn.execute(
                "UPDATE opportunities SET resume_version_id=COALESCE(?,resume_version_id), updated_at=? WHERE id=?",
                (item.get("resume_version_id"), now, item["opportunity_id"]),
            )
            for instruction in item.get("instructions", []):
                if not isinstance(instruction, dict) or instruction.get("value") in (None, ""):
                    continue
                field_key = str(instruction.get("field_id") or "unknown")
                answer_id = hashlib.sha256(f"{item['opportunity_id']}|{field_key}".encode()).hexdigest()[:32]
                self.conn.execute(
                    "INSERT INTO application_answers (id,opportunity_id,field_key,value_json,source,confidence,approved,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(opportunity_id,field_key) DO UPDATE SET value_json=excluded.value_json,"
                    "source=excluded.source,confidence=excluded.confidence,updated_at=excluded.updated_at",
                    (answer_id, item["opportunity_id"], field_key, self._json(instruction.get("value")),
                     instruction.get("source"), instruction.get("confidence"), 0, now, now),
                )
            self.conn.commit()
        return self.get_packet(packet_id) or {}

    def get_packet(self, packet_id: str) -> dict | None:
        row = self.conn.execute("SELECT * FROM application_packets WHERE id=?", (packet_id,)).fetchone()
        return self._decode_row(row)

    def get_latest_packet(self, opportunity_id: str) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM application_packets WHERE opportunity_id=? ORDER BY updated_at DESC LIMIT 1",
            (opportunity_id,),
        ).fetchone()
        return self._decode_row(row)

    def get_application_answers(self, opportunity_id: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM application_answers WHERE opportunity_id=? ORDER BY updated_at DESC",
            (opportunity_id,),
        ).fetchall()
        return [self._decode_row(row) for row in rows]

    def get_latest_receipt(self, opportunity_id: str) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM submission_receipts WHERE opportunity_id=? ORDER BY submitted_at DESC LIMIT 1",
            (opportunity_id,),
        ).fetchone()
        return self._decode_row(row)

    def add_receipt(self, item: dict) -> dict:
        now = self._now()
        with self._write_lock, self.conn:
            self.conn.execute(
                "INSERT INTO submission_receipts "
                "(id,opportunity_id,packet_id,submitted_at,confirmation_code,confirmation_url,screenshot_path,details_json,user_confirmed,created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (item["id"], item["opportunity_id"], item.get("packet_id"), item.get("submitted_at") or now,
                 item.get("confirmation_code"), item.get("confirmation_url"), item.get("screenshot_path"),
                 self._json(item.get("details", {})), int(item.get("user_confirmed", True)), now),
            )
            self.conn.execute(
                "UPDATE opportunities SET status='submitted', submitted_at=?, updated_at=? WHERE id=?",
                (item.get("submitted_at") or now, now, item["opportunity_id"]),
            )
            self.conn.execute(
                "UPDATE applications SET status='applied', applied_at=? WHERE id=?",
                (item.get("submitted_at") or now, item["opportunity_id"]),
            )
            self.conn.commit()
        return self._decode_row(self.conn.execute("SELECT * FROM submission_receipts WHERE id=?", (item["id"],)).fetchone()) or {}

    def list_receipts(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT r.*,o.company,o.role FROM submission_receipts r LEFT JOIN opportunities o ON o.id=r.opportunity_id ORDER BY r.submitted_at DESC"
        ).fetchall()
        return [self._decode_row(row) for row in rows]

    def add_contact(self, item: dict) -> dict:
        now = self._now()
        with self._write_lock, self.conn:
            self.conn.execute(
                "INSERT INTO contacts (id,opportunity_id,name,email,phone,title,relationship,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (item["id"], item["opportunity_id"], item["name"], item.get("email"), item.get("phone"), item.get("title"),
                 item.get("relationship"), item.get("notes"), now, now),
            )
            self.conn.commit()
        return self._decode_row(self.conn.execute("SELECT * FROM contacts WHERE id=?", (item["id"],)).fetchone()) or {}

    def add_follow_up(self, item: dict) -> dict:
        now = self._now()
        with self._write_lock, self.conn:
            self.conn.execute(
                "INSERT INTO follow_ups (id,opportunity_id,contact_id,due_at,kind,notes,completed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (item["id"], item["opportunity_id"], item.get("contact_id"), item["due_at"], item.get("kind", "follow_up"),
                 item.get("notes") or item.get("note"), item.get("completed_at"), now, now),
            )
            self.conn.commit()
        return self._decode_row(self.conn.execute("SELECT * FROM follow_ups WHERE id=?", (item["id"],)).fetchone()) or {}

    def update_follow_up(self, follow_up_id: str, changes: dict) -> dict | None:
        allowed = {"due_at", "kind", "notes", "completed_at"}
        values = {key: value for key, value in changes.items() if key in allowed}
        if not values:
            return self._decode_row(self.conn.execute("SELECT * FROM follow_ups WHERE id=?", (follow_up_id,)).fetchone())
        values["updated_at"] = self._now()
        with self._write_lock, self.conn:
            cur = self.conn.execute(
                f"UPDATE follow_ups SET {', '.join(f'{key}=?' for key in values)} WHERE id=?",
                (*values.values(), follow_up_id),
            )
            self.conn.commit()
        if not cur.rowcount:
            return None
        return self._decode_row(self.conn.execute("SELECT * FROM follow_ups WHERE id=?", (follow_up_id,)).fetchone())

    def add_interview(self, item: dict) -> dict:
        now = self._now()
        with self._write_lock, self.conn:
            self.conn.execute(
                "INSERT INTO interviews (id,opportunity_id,scheduled_at,interview_type,timezone,location,interviewer_names_json,notes,outcome,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (item["id"], item["opportunity_id"], item["scheduled_at"], item.get("interview_type", "interview"), item.get("timezone"),
                 item.get("location"), self._json(item.get("interviewer_names", [])), item.get("notes"), item.get("outcome"), now, now),
            )
            self.conn.commit()
        return self._decode_row(self.conn.execute("SELECT * FROM interviews WHERE id=?", (item["id"],)).fetchone()) or {}

    def related_records(self, opportunity_id: str) -> dict[str, list[dict]]:
        result = {}
        for key, table, order in (
            ("contacts", "contacts", "created_at"), ("follow_ups", "follow_ups", "due_at"),
            ("interviews", "interviews", "scheduled_at"),
        ):
            rows = self.conn.execute(
                f"SELECT * FROM {table} WHERE opportunity_id=? ORDER BY {order} DESC", (opportunity_id,)
            ).fetchall()
            result[key] = [self._decode_row(row) for row in rows]
        return result

    def workspace_overview(self) -> dict:
        opportunities = self.list_opportunities(500)
        now = datetime.now(timezone.utc)
        upcoming_cutoff = now + timedelta(days=30)
        reminders = [self._decode_row(row) for row in self.conn.execute(
            "SELECT f.*,o.company,o.role FROM follow_ups f LEFT JOIN opportunities o ON o.id=f.opportunity_id "
            "WHERE f.completed_at IS NULL ORDER BY f.due_at ASC"
        ).fetchall()]
        upcoming_interviews = [self._decode_row(row) for row in self.conn.execute(
            "SELECT i.*,o.company,o.role FROM interviews i LEFT JOIN opportunities o ON o.id=i.opportunity_id "
            "WHERE i.scheduled_at>=? AND i.scheduled_at<=? ORDER BY i.scheduled_at ASC",
            (now.isoformat(), upcoming_cutoff.isoformat()),
        ).fetchall()]
        contacts = [self._decode_row(row) for row in self.conn.execute(
            "SELECT c.*,o.company,o.role FROM contacts c LEFT JOIN opportunities o ON o.id=c.opportunity_id ORDER BY c.updated_at DESC"
        ).fetchall()]
        actions: list[dict] = []
        action_statuses = {
            "draft": (3, "Finish capturing this role", "Prepare"),
            "saved": (3, "Prepare this application", "Prepare"),
            "preparing": (2, "Finish preparation", "Continue"),
            "ready_to_review": (1, "Review before applying", "Review"),
            "interview": (1, "Prepare for the interview", "Open"),
            "negotiating": (0, "Review the negotiation", "Review"),
            "offer": (0, "Review the offer", "Review"),
        }
        for item in opportunities:
            if item.get("status") not in action_statuses:
                continue
            priority, reason, cta = action_statuses[item["status"]]
            actions.append({
                "id": f"opportunity:{item['id']}", "type": "opportunity", "opportunity_id": item["id"],
                "title": f"{item['role']} · {item['company']}", "reason": reason, "cta": cta,
                "due_at": item.get("target_date"), "priority": priority, "status": item.get("status"),
            })
        for follow_up in reminders:
            due_at = str(follow_up.get("due_at") or "")
            overdue = bool(due_at and due_at < now.isoformat())
            actions.append({
                "id": f"follow_up:{follow_up['id']}", "type": "follow_up",
                "opportunity_id": follow_up.get("opportunity_id"),
                "title": f"{follow_up.get('role') or 'Application'} · {follow_up.get('company') or 'Company'}",
                "reason": follow_up.get("notes") or "Follow up", "cta": "Complete",
                "due_at": follow_up.get("due_at"), "priority": 0 if overdue else 2, "overdue": overdue,
            })
        for interview in upcoming_interviews:
            actions.append({
                "id": f"interview:{interview['id']}", "type": "interview",
                "opportunity_id": interview.get("opportunity_id"),
                "title": f"{interview.get('role') or 'Interview'} · {interview.get('company') or 'Company'}",
                "reason": "Upcoming interview", "cta": "Prepare",
                "due_at": interview.get("scheduled_at"), "priority": 1,
            })
        actions.sort(key=lambda item: (item.get("priority", 9), item.get("due_at") or "9999", item.get("title") or ""))
        submitted_statuses = {"submitted", "applied", "no_response", "interview", "negotiating", "offer", "accepted", "rejected"}
        closed_statuses = {"accepted", "rejected", "withdrawn", "archived"}
        summary = {
            "total": len(opportunities),
            "ready": sum(item.get("status") == "ready_to_review" for item in opportunities),
            "applied": sum(item.get("status") in submitted_statuses for item in opportunities),
            "interviews": sum(item.get("status") == "interview" for item in opportunities),
            "offers": sum(item.get("status") in {"offer", "negotiating"} for item in opportunities),
            "closed": sum(item.get("status") in closed_statuses for item in opportunities),
        }
        return {
            "summary": summary,
            "actions": actions,
            "queue": [{**item, "application_id": item.get("opportunity_id")} for item in actions],
            "reminders": reminders,
            "upcoming_interviews": upcoming_interviews,
            "recent_activity": opportunities[:8],
            "policies": self.list_policies(),
            "resumes": self.list_resume_versions(),
            "answers": self.list_answer_vault(500),
            "receipts": self.list_receipts(),
            "relationships": contacts,
        }

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


def close_database() -> None:
    """Close the singleton if it was created, without creating it at shutdown."""
    global _db
    with _db_lock:
        if _db is not None:
            _db.close()
            _db = None

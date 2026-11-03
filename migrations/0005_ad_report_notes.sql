-- Account manager's note to the client for a month ("What we did / what's next"). Shown in the portal once that month is published.
CREATE TABLE ad_report_notes (
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  month      TEXT NOT NULL,                                      -- YYYY-MM
  body       TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, month)
);

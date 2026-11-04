-- Client ad results (Meta for now). Phase 1: staff enter or upload daily numbers and publish them to the client portal.
-- Spend is stored for internal use only; the portal reads results through CLIENT_VISIBLE_AD_METRICS and never sees it.

-- What each client's ads are meant to achieve. One client can have several goals; one is the headline.
CREATE TABLE client_ad_goals (
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  goal       TEXT NOT NULL CHECK (goal IN ('website_visits','followers','calls','leads')),
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (client_id, goal)
);
CREATE UNIQUE INDEX uq_client_ad_goals_primary ON client_ad_goals(client_id) WHERE is_primary = 1;

CREATE TABLE ad_accounts (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta')),
  external_id TEXT,                                   -- Meta ad account id (act_...), used by the Phase 2 sync
  name        TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_ad_accounts_client ON ad_accounts(client_id);
CREATE UNIQUE INDEX uq_ad_accounts_external ON ad_accounts(platform, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE ad_campaigns (
  id            TEXT PRIMARY KEY,
  ad_account_id TEXT NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  external_id   TEXT,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  archived_at   TEXT
);
CREATE INDEX idx_ad_campaigns_account ON ad_campaigns(ad_account_id);
CREATE UNIQUE INDEX uq_ad_campaigns_external ON ad_campaigns(ad_account_id, external_id) WHERE external_id IS NOT NULL;

-- One row per campaign, day and metric, so a new goal type never needs a schema change.
CREATE TABLE ad_results_daily (
  campaign_id  TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,  -- denormalised for fast per-client reads
  date         TEXT NOT NULL,                                           -- YYYY-MM-DD
  metric       TEXT NOT NULL CHECK (metric IN ('impressions','reach','link_clicks','landing_page_views','follows','profile_visits','call_taps','calls','leads','spend')),
  value        REAL NOT NULL CHECK (value >= 0),
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','csv','meta_api')),
  updated_by   TEXT REFERENCES users(id),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (campaign_id, date, metric)
);
CREATE INDEX idx_ad_results_client_date ON ad_results_daily(client_id, date);

-- Clients only see days up to the latest date staff have checked and published.
ALTER TABLE clients ADD COLUMN ad_results_published_through TEXT;

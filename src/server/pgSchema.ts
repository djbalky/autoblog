/**
 * Autonoblog — Postgres schema (mirror of src/server/schema.ts, 39 tables).
 *
 * Type decisions (deliberate, consistent with the SQLite schema and the DAL):
 *  - ids: BIGINT GENERATED ALWAYS AS IDENTITY (Postgres auto-increment).
 *  - booleans stay INTEGER 0/1 — the DAL writes integers and reads them as
 *    integers; Postgres BOOLEAN would reject the integer 0, so INTEGER keeps
 *    both backends bit-identical.
 *  - timestamps stay TEXT (ISO-8601 UTC via nowIso()) — the DAL reads them as
 *    strings; storing as TEXT avoids Postgres Date objects reaching the client.
 *
 * Statements are idempotent (IF NOT EXISTS). Tables are declared in dependency
 * order so the referenced table exists before a FK column is declared (this is
 * required by Postgres, unlike SQLite). Indexes mirror schema.ts.
 */
export const PG_SCHEMA_NAME = "autonoblog-v1";

/**
 * Foundation extension (Phase 1 follow-on): billing/usage + the ContentJob
 * pipeline tracking core. Single source of truth: these statements are spread
 * at the end of PG_SCHEMA_STATEMENTS (so a fresh database gets them) AND run
 * unconditionally by migrate() on every boot (so databases migrated before this
 * phase get them too). Every statement is idempotent.
 *
 * Nothing here is billed or charged: `plans`/`subscriptions`/`usage_records`/
 * `credit_transactions` only record what exists. Pricing is decided later.
 */
export const PG_EXTENSION_STATEMENTS: string[] = [
  // ---- Billing & usage ----------------------------------------------------
  `CREATE TABLE IF NOT EXISTS plans (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key                 TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    monthly_price_cents INTEGER NOT NULL DEFAULT 0,
    limits              TEXT NOT NULL DEFAULT '{}',
    active              INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plans_active ON plans(active)`,

  `CREATE TABLE IF NOT EXISTS subscriptions (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id              BIGINT NOT NULL REFERENCES plans(id),
    status               TEXT NOT NULL DEFAULT 'active',
    current_period_start TEXT NOT NULL,
    current_period_end   TEXT NOT NULL,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_plan ON subscriptions(plan_id)`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status)`,

  `CREATE TABLE IF NOT EXISTS usage_records (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    metric       TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end   TEXT NOT NULL,
    amount       BIGINT NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL,
    UNIQUE (user_id, metric, period_start, period_end)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_records_user ON usage_records(user_id, metric)`,

  `CREATE TABLE IF NOT EXISTS credit_transactions (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount     BIGINT NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    reference  TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON credit_transactions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_credit_transactions_reference ON credit_transactions(reference)`,

  // ---- ContentJob pipeline (ContentJob -> AgentRuns -> Post -> ...) -------
  `CREATE TABLE IF NOT EXISTS content_jobs (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id        BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    target_post_id BIGINT REFERENCES posts(id) ON DELETE SET NULL,
    status         TEXT NOT NULL DEFAULT 'research',
    current_agent  TEXT,
    started_at     TEXT NOT NULL,
    deadline       TEXT,
    result         TEXT NOT NULL DEFAULT '',
    error          TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_content_jobs_blog_status ON content_jobs(blog_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_content_jobs_status_deadline ON content_jobs(status, deadline)`,
  `CREATE INDEX IF NOT EXISTS idx_content_jobs_created ON content_jobs(created_at)`,

  `CREATE TABLE IF NOT EXISTS content_job_events (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id     BIGINT NOT NULL REFERENCES content_jobs(id) ON DELETE CASCADE,
    agent      TEXT,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_content_job_events_job ON content_job_events(job_id)`,

  // Every agent run can be attributed to the ContentJob that caused it.
  `ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS content_job_id BIGINT REFERENCES content_jobs(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_job ON agent_runs(content_job_id)`,
];

export const PG_SCHEMA_STATEMENTS: string[] = [
  // ---- Auth & roles -------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS roles (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS permissions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS role_permissions (
    role_id       BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_roles (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    user_agent TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,

  // ---- Blogs --------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS blogs (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    slug         TEXT NOT NULL UNIQUE,
    tagline      TEXT NOT NULL DEFAULT '',
    description  TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'draft',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blogs_owner ON blogs(owner_id)`,
  `CREATE INDEX IF NOT EXISTS idx_blogs_status ON blogs(status)`,

  `CREATE TABLE IF NOT EXISTS blog_settings (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id     BIGINT NOT NULL UNIQUE REFERENCES blogs(id) ON DELETE CASCADE,
    language    TEXT NOT NULL DEFAULT 'en',
    timezone    TEXT NOT NULL DEFAULT 'UTC',
    posts_per_day INTEGER NOT NULL DEFAULT 2,
    auto_publish INTEGER NOT NULL DEFAULT 0,
    allow_comments INTEGER NOT NULL DEFAULT 1,
    monetization_active INTEGER NOT NULL DEFAULT 0,
    seo_title_template TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS media (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id    BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    uploader_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    file_name  TEXT NOT NULL,
    file_path  TEXT NOT NULL,
    mime_type  TEXT NOT NULL DEFAULT '',
    size_bytes BIGINT NOT NULL DEFAULT 0,
    alt_text   TEXT NOT NULL DEFAULT '',
    width      BIGINT,
    height     BIGINT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_media_blog ON media(blog_id)`,
  `CREATE INDEX IF NOT EXISTS idx_media_uploader ON media(uploader_id)`,

  `CREATE TABLE IF NOT EXISTS authors (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id       BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    user_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    display_name  TEXT NOT NULL,
    bio           TEXT NOT NULL DEFAULT '',
    avatar_media_id BIGINT REFERENCES media(id) ON DELETE SET NULL,
    slug          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    UNIQUE (blog_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_authors_blog ON authors(blog_id)`,

  // ---- Membership (after blogs/users) -------------------------------------
  `CREATE TABLE IF NOT EXISTS blog_members (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id    BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'contributor',
    created_at TEXT NOT NULL,
    UNIQUE (blog_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_members_blog ON blog_members(blog_id)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_members_user ON blog_members(user_id)`,

  // ---- Taxonomy -----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS categories (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id    BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    parent_id  BIGINT REFERENCES categories(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (blog_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_categories_blog ON categories(blog_id)`,

  `CREATE TABLE IF NOT EXISTS tags (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id    BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (blog_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tags_blog ON tags(blog_id)`,

  // ---- Content ------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS posts (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id       BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    author_id     BIGINT REFERENCES authors(id) ON DELETE SET NULL,
    title         TEXT NOT NULL,
    slug          TEXT NOT NULL,
    content       TEXT NOT NULL DEFAULT '',
    excerpt       TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'draft',
    featured_media_id BIGINT REFERENCES media(id) ON DELETE SET NULL,
    published_at  TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (blog_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_posts_blog ON posts(blog_id)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_blog_status ON posts(blog_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id)`,

  `CREATE TABLE IF NOT EXISTS post_revisions (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    revision   INTEGER NOT NULL,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    excerpt    TEXT NOT NULL DEFAULT '',
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE (post_id, revision)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_post_revisions_post ON post_revisions(post_id)`,

  `CREATE TABLE IF NOT EXISTS post_categories (
    post_id     BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, category_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_post_categories_cat ON post_categories(category_id)`,

  `CREATE TABLE IF NOT EXISTS post_tags (
    post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    tag_id  BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag_id)`,

  `CREATE TABLE IF NOT EXISTS pages (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id    BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    slug       TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (blog_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pages_blog ON pages(blog_id)`,

  // ---- Media usage --------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS media_usage (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    media_id    BIGINT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id   BIGINT NOT NULL,
    used_at     TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_media_usage_media ON media_usage(media_id)`,
  `CREATE INDEX IF NOT EXISTS idx_media_usage_entity ON media_usage(entity_type, entity_id)`,

  // ---- Comments -----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS comments (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    post_id    BIGINT REFERENCES posts(id) ON DELETE CASCADE,
    parent_id  BIGINT REFERENCES comments(id) ON DELETE CASCADE,
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL DEFAULT '',
    author_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    content    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status)`,

  // ---- Monetization -------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS ads (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id    BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'custom',
    code       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ads_blog ON ads(blog_id)`,

  `CREATE TABLE IF NOT EXISTS ad_placements (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id    BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    ad_id      BIGINT NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
    location   TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'global',
    entity_id  BIGINT,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ad_placements_blog ON ad_placements(blog_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ad_placements_ad ON ad_placements(ad_id)`,

  // ---- Social -------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS social_accounts (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id     BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL,
    account_name TEXT NOT NULL,
    access_token TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'not_connected',
    error_message TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (blog_id, platform)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_social_accounts_blog ON social_accounts(blog_id)`,

  `CREATE TABLE IF NOT EXISTS social_posts (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id       BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    account_id    BIGINT REFERENCES social_accounts(id) ON DELETE SET NULL,
    post_id       BIGINT REFERENCES posts(id) ON DELETE SET NULL,
    platform      TEXT NOT NULL,
    external_id   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'pending',
    content       TEXT NOT NULL DEFAULT '',
    posted_at     TEXT,
    created_at    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_social_posts_blog ON social_posts(blog_id)`,

  // ---- Agent system -------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS agents (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id     BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    config      TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agents_blog ON agents(blog_id)`,

  `CREATE TABLE IF NOT EXISTS agent_jobs (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id    BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'queued',
    payload     TEXT NOT NULL DEFAULT '',
    result      TEXT NOT NULL DEFAULT '',
    error       TEXT NOT NULL DEFAULT '',
    queued_at   TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_jobs_agent ON agent_jobs(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs(status)`,

  `CREATE TABLE IF NOT EXISTS agent_runs (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id   BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    post_id    BIGINT REFERENCES posts(id) ON DELETE SET NULL,
    status     TEXT NOT NULL DEFAULT 'running',
    log        TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id)`,

  `CREATE TABLE IF NOT EXISTS automations (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id     BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    schedule    TEXT NOT NULL,
    posts_per_day INTEGER NOT NULL DEFAULT 2,
    is_enabled  INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT,
    created_at  TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_automations_blog ON automations(blog_id)`,

  `CREATE TABLE IF NOT EXISTS automation_runs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    automation_id BIGINT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'running',
    message       TEXT NOT NULL DEFAULT '',
    started_at    TEXT NOT NULL,
    finished_at   TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_automation_runs_auto ON automation_runs(automation_id)`,

  // ---- Plugins ------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS plugins (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id     BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 0,
    installed_at TEXT NOT NULL,
    UNIQUE (blog_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plugins_blog ON plugins(blog_id)`,

  `CREATE TABLE IF NOT EXISTS plugin_versions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plugin_id   BIGINT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    version     TEXT NOT NULL,
    changelog   TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    UNIQUE (plugin_id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plugin_versions_plugin ON plugin_versions(plugin_id)`,

  `CREATE TABLE IF NOT EXISTS plugin_settings (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plugin_id  BIGINT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (plugin_id, key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plugin_settings_plugin ON plugin_settings(plugin_id)`,

  // ---- Navigation ---------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS menus (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id    BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    location   TEXT NOT NULL DEFAULT 'primary',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_menus_blog ON menus(blog_id)`,

  `CREATE TABLE IF NOT EXISTS menu_items (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    menu_id    BIGINT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
    parent_id  BIGINT REFERENCES menu_items(id) ON DELETE CASCADE,
    label      TEXT NOT NULL,
    url        TEXT NOT NULL DEFAULT '',
    target     TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_menu_items_menu ON menu_items(menu_id)`,

  `CREATE TABLE IF NOT EXISTS widgets (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id    BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    area       TEXT NOT NULL,
    type       TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    config     TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_widgets_blog ON widgets(blog_id)`,

  // ---- SEO ----------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS seo_data (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id   BIGINT NOT NULL,
    meta_title  TEXT NOT NULL DEFAULT '',
    meta_description TEXT NOT NULL DEFAULT '',
    canonical_url TEXT NOT NULL DEFAULT '',
    robots      TEXT NOT NULL DEFAULT '',
    keywords    TEXT NOT NULL DEFAULT '',
    json_ld     TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL,
    UNIQUE (entity_type, entity_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_seo_data_entity ON seo_data(entity_type, entity_id)`,

  // ---- Integrations & activity -------------------------------------------
  `CREATE TABLE IF NOT EXISTS integrations (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    blog_id       BIGINT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    provider      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'not_connected',
    config        TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_integrations_blog ON integrations(blog_id)`,

  `CREATE TABLE IF NOT EXISTS activity_logs (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    blog_id    BIGINT REFERENCES blogs(id) ON DELETE CASCADE,
    action     TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT '',
    entity_id  BIGINT,
    detail     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_logs_blog ON activity_logs(blog_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at)`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL DEFAULT 'info',
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    is_read    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, is_read)`,

  // ---- Foundation extension (billing/usage + ContentJob pipeline) ---------
  // Spread last: `content_jobs` must exist before the `agent_runs` ALTER.
  ...PG_EXTENSION_STATEMENTS,
];

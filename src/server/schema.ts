/**
 * Autonoblog — normalized database schema (Phase 1 Foundation).
 *
 * Written in portable, standard SQL so it can be migrated to Postgres later:
 *  - column types stay in the common subset: TEXT, INTEGER, REAL;
 *  - timestamps are stored as TEXT (ISO-8601 UTC) produced by the DAL, not by
 *    database-specific functions;
 *  - booleans are INTEGER (0/1);
 *  - foreign keys are declared but enforcement is enabled per-connection.
 *
 * Run via `migrate()` in src/server/db.ts which executes every statement
 * idempotently (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
 */

export const SCHEMA_VERSION = 1;

// Each entry is a full, self-contained, idempotent DDL statement.
export const SCHEMA_STATEMENTS: string[] = [
  // ---- Auth & roles -------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,
  `
  CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,   -- owner | administrator | editor | author | contributor
    description TEXT NOT NULL DEFAULT ''
  )`,
  `
  CREATE TABLE IF NOT EXISTS permissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,   -- e.g. blog.create, post.publish
    description TEXT NOT NULL DEFAULT ''
  )`,
  `
  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
  )`,
  `
  CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
  )`,
  `
  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    user_agent TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,

  // ---- Blogs --------------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS blogs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    slug         TEXT NOT NULL UNIQUE,
    tagline      TEXT NOT NULL DEFAULT '',
    description  TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'draft',   -- draft | active | archived
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blogs_owner ON blogs(owner_id)`,
  `CREATE INDEX IF NOT EXISTS idx_blogs_status ON blogs(status)`,

  `
  CREATE TABLE IF NOT EXISTS blog_settings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id     INTEGER NOT NULL UNIQUE REFERENCES blogs(id) ON DELETE CASCADE,
    language    TEXT NOT NULL DEFAULT 'en',
    timezone    TEXT NOT NULL DEFAULT 'UTC',
    posts_per_day INTEGER NOT NULL DEFAULT 2,
    auto_publish INTEGER NOT NULL DEFAULT 0,
    allow_comments INTEGER NOT NULL DEFAULT 1,
    monetization_active INTEGER NOT NULL DEFAULT 0,
    seo_title_template TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL
  )`,

  `
  CREATE TABLE IF NOT EXISTS blog_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id    INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'contributor',
    created_at TEXT NOT NULL,
    UNIQUE (blog_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_members_blog ON blog_members(blog_id)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_members_user ON blog_members(user_id)`,

  `
  CREATE TABLE IF NOT EXISTS authors (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id       INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    display_name  TEXT NOT NULL,
    bio           TEXT NOT NULL DEFAULT '',
    avatar_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
    slug          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    UNIQUE (blog_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_authors_blog ON authors(blog_id)`,

  // ---- Taxonomy -----------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id    INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    parent_id  INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (blog_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_categories_blog ON categories(blog_id)`,

  `
  CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id    INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (blog_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tags_blog ON tags(blog_id)`,

  // ---- Content ------------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS posts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id       INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    author_id     INTEGER REFERENCES authors(id) ON DELETE SET NULL,
    title         TEXT NOT NULL,
    slug          TEXT NOT NULL,
    content       TEXT NOT NULL DEFAULT '',       -- rendered HTML
    excerpt       TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'draft',  -- draft | pending | published | scheduled | trashed
    featured_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
    published_at  TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (blog_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_posts_blog ON posts(blog_id)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_blog_status ON posts(blog_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id)`,

  `
  CREATE TABLE IF NOT EXISTS post_revisions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    revision   INTEGER NOT NULL,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    excerpt    TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE (post_id, revision)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_post_revisions_post ON post_revisions(post_id)`,

  `
  CREATE TABLE IF NOT EXISTS post_categories (
    post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, category_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_post_categories_cat ON post_categories(category_id)`,

  `
  CREATE TABLE IF NOT EXISTS post_tags (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag_id)`,

  `
  CREATE TABLE IF NOT EXISTS pages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id    INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    slug       TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (blog_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pages_blog ON pages(blog_id)`,

  // ---- Media --------------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS media (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id    INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    file_name  TEXT NOT NULL,
    file_path  TEXT NOT NULL,
    mime_type  TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    alt_text   TEXT NOT NULL DEFAULT '',
    width      INTEGER,
    height     INTEGER,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_media_blog ON media(blog_id)`,
  `CREATE INDEX IF NOT EXISTS idx_media_uploader ON media(uploader_id)`,

  `
  CREATE TABLE IF NOT EXISTS media_usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id    INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,   -- post | page | featured | ...
    entity_id   INTEGER NOT NULL,
    used_at     TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_media_usage_media ON media_usage(media_id)`,
  `CREATE INDEX IF NOT EXISTS idx_media_usage_entity ON media_usage(entity_type, entity_id)`,

  // ---- Comments -----------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    parent_id  INTEGER REFERENCES comments(id) ON DELETE CASCADE,
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL DEFAULT '',
    author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    content    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | spam | trashed
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status)`,

  // ---- Monetization -------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS ads (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id    INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'custom',   -- adsense | custom | affiliate | sponsored
    code       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ads_blog ON ads(blog_id)`,

  `
  CREATE TABLE IF NOT EXISTS ad_placements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id    INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    ad_id      INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
    location   TEXT NOT NULL,       -- header | sidebar | in_content | footer
    entity_type TEXT NOT NULL DEFAULT 'global',  -- global | post | page
    entity_id  INTEGER,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ad_placements_blog ON ad_placements(blog_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ad_placements_ad ON ad_placements(ad_id)`,

  // ---- Social -------------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS social_accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id     INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL,        -- twitter | facebook | linkedin | instagram ...
    account_name TEXT NOT NULL,
    access_token TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'not_connected',  -- not_connected | connected | error
    error_message TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (blog_id, platform)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_social_accounts_blog ON social_accounts(blog_id)`,

  `
  CREATE TABLE IF NOT EXISTS social_posts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id       INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    account_id    INTEGER REFERENCES social_accounts(id) ON DELETE SET NULL,
    post_id       INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    platform      TEXT NOT NULL,
    external_id   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending | posted | failed
    content       TEXT NOT NULL DEFAULT '',
    posted_at     TEXT,
    created_at    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_social_posts_blog ON social_posts(blog_id)`,

  // ---- Agent system -------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS agents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id     INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,           -- researcher | writer | optimizer | publisher
    config      TEXT NOT NULL DEFAULT '',  -- free-form settings (JSON, agent-owned)
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agents_blog ON agents(blog_id)`,

  `
  CREATE TABLE IF NOT EXISTS agent_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed | cancelled
    payload     TEXT NOT NULL DEFAULT '',
    result      TEXT NOT NULL DEFAULT '',
    error       TEXT NOT NULL DEFAULT '',
    queued_at   TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_jobs_agent ON agent_jobs(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs(status)`,

  `
  CREATE TABLE IF NOT EXISTS agent_runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    post_id    INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    status     TEXT NOT NULL DEFAULT 'running',  -- running | succeeded | failed
    log        TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id)`,

  `
  CREATE TABLE IF NOT EXISTS automations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id     INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    schedule    TEXT NOT NULL,          -- cron or interval descriptor
    posts_per_day INTEGER NOT NULL DEFAULT 2,
    is_enabled  INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT,
    created_at  TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_automations_blog ON automations(blog_id)`,

  `
  CREATE TABLE IF NOT EXISTS automation_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'running',  -- running | succeeded | failed
    message       TEXT NOT NULL DEFAULT '',
    started_at    TEXT NOT NULL,
    finished_at   TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_automation_runs_auto ON automation_runs(automation_id)`,

  // ---- Plugins ------------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS plugins (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id     INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 0,
    installed_at TEXT NOT NULL,
    UNIQUE (blog_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plugins_blog ON plugins(blog_id)`,

  `
  CREATE TABLE IF NOT EXISTS plugin_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id   INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    version     TEXT NOT NULL,
    changelog   TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    UNIQUE (plugin_id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plugin_versions_plugin ON plugin_versions(plugin_id)`,

  `
  CREATE TABLE IF NOT EXISTS plugin_settings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id  INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (plugin_id, key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plugin_settings_plugin ON plugin_settings(plugin_id)`,

  // ---- Navigation ---------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS menus (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id    INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    location   TEXT NOT NULL DEFAULT 'primary',  -- primary | footer | ...
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_menus_blog ON menus(blog_id)`,

  `
  CREATE TABLE IF NOT EXISTS menu_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_id    INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
    parent_id  INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
    label      TEXT NOT NULL,
    url        TEXT NOT NULL DEFAULT '',
    target     TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_menu_items_menu ON menu_items(menu_id)`,

  `
  CREATE TABLE IF NOT EXISTS widgets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id    INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    area       TEXT NOT NULL,           -- sidebar | header | footer
    type       TEXT NOT NULL,           -- text | category_list | recent_posts | search | ...
    title      TEXT NOT NULL DEFAULT '',
    config     TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_widgets_blog ON widgets(blog_id)`,

  // ---- SEO ----------------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS seo_data (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,        -- post | page | blog
    entity_id   INTEGER NOT NULL,
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
  `
  CREATE TABLE IF NOT EXISTS integrations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    blog_id       INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
    provider      TEXT NOT NULL,       -- adsense | analytics | social ...
    status        TEXT NOT NULL DEFAULT 'not_connected',  -- not_connected | connected | error
    config        TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_integrations_blog ON integrations(blog_id)`,

  `
  CREATE TABLE IF NOT EXISTS activity_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    blog_id    INTEGER REFERENCES blogs(id) ON DELETE CASCADE,
    action     TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT '',
    entity_id  INTEGER,
    detail     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_logs_blog ON activity_logs(blog_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at)`,

  `
  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL DEFAULT 'info',
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    is_read    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, is_read)`,
];

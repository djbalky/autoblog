/**
 * Autonoblog — shared ad-slot label map.
 *
 * Client-safe (no server imports) so both the wizard UI and the post-create
 * landing page can render slot keys with human labels.
 */
export const AD_SLOT_LABELS: Record<string, string> = {
  header: "Header",
  before_article: "Before article",
  after_intro: "After intro",
  mid: "Mid article",
  sidebar: "Sidebar",
  before_conclusion: "Before conclusion",
  after_conclusion: "After conclusion",
  footer: "Footer",
};
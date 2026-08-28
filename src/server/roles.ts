/**
 * Autonoblog — role + permission definitions (shared).
 */

export const ROLES = [
  "owner",
  "administrator",
  "editor",
  "author",
  "contributor",
] as const;
export type RoleName = (typeof ROLES)[number];

export const ROLE_PERMISSIONS: Record<RoleName, string[]> = {
  owner: ["*"], // wildcard: all permissions
  administrator: [
    "blog.manage",
    "post.manage",
    "page.manage",
    "media.manage",
    "comment.moderate",
    "plugin.manage",
    "automation.manage",
    "agent.manage",
    "integration.manage",
    "member.manage",
  ],
  editor: [
    "post.manage",
    "page.manage",
    "media.manage",
    "comment.moderate",
    "post.publish",
    "seo.manage",
  ],
  author: ["post.create", "post.edit", "media.upload", "post.publish"],
  contributor: ["post.create", "post.edit"],
};

export const ALL_PERMISSIONS = [
  "blog.manage",
  "post.manage",
  "post.create",
  "post.edit",
  "post.publish",
  "page.manage",
  "media.manage",
  "media.upload",
  "comment.moderate",
  "seo.manage",
  "plugin.manage",
  "automation.manage",
  "agent.manage",
  "integration.manage",
  "member.manage",
];

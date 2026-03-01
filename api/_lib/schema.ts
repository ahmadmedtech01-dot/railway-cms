import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  boolean,
  integer,
  real,
  jsonb,
  timestamp,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const videos = pgTable("videos", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  publicId: text("public_id").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").default(""),
  author: text("author").default(""),
  tags: text("tags").array().default(sql`'{}'::text[]`),
  thumbnailUrl: text("thumbnail_url"),
  thumbnailAssetId: uuid("thumbnail_asset_id"),
  thumbnailUpdatedAt: timestamp("thumbnail_updated_at"),
  status: text("status").notNull().default("uploading"),
  available: boolean("available").notNull().default(true),
  sourceType: text("source_type").notNull().default("upload"),
  sourceUrl: text("source_url"),
  rawS3Key: text("raw_s3_key"),
  hlsS3Prefix: text("hls_s3_prefix"),
  qualities: integer("qualities").array().default(sql`'{}'::int[]`),
  duration: integer("duration"),
  fileSize: integer("file_size"),
  lastError: text("last_error"),
  lastErrorCode: text("last_error_code"),
  lastErrorHints: jsonb("last_error_hints").default(sql`'[]'::jsonb`),
  storageConnectionId: uuid("storage_connection_id"),
  encryptionKid: text("encryption_kid"),
  encryptionKeyPath: text("encryption_key_path"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const videoPlayerSettings = pgTable("video_player_settings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  videoId: uuid("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  allowSpeed: boolean("allow_speed").notNull().default(true),
  allowQuality: boolean("allow_quality").notNull().default(true),
  allowFullscreen: boolean("allow_fullscreen").notNull().default(true),
  allowSkip: boolean("allow_skip").notNull().default(true),
  allowBrightness: boolean("allow_brightness").notNull().default(true),
  resumeEnabled: boolean("resume_enabled").notNull().default(true),
  autoplayAllowed: boolean("autoplay_allowed").notNull().default(false),
  startTime: integer("start_time").notNull().default(0),
  endTime: integer("end_time"),
  logoEnabled: boolean("logo_enabled").notNull().default(false),
  logoAssetId: uuid("logo_asset_id"),
  logoPlacement: text("logo_placement").notNull().default("top-right"),
  logoSizePercent: integer("logo_size_percent").notNull().default(12),
  logoOpacity: real("logo_opacity").notNull().default(0.9),
  overlayEnabled: boolean("overlay_enabled").notNull().default(false),
  overlayAssetId: uuid("overlay_asset_id"),
  overlayOpacity: real("overlay_opacity").notNull().default(0.6),
  overlayMode: text("overlay_mode").notNull().default("full"),
  qrEnabled: boolean("qr_enabled").notNull().default(false),
  qrTitle: text("qr_title"),
  qrUrl: text("qr_url"),
  qrPlacement: text("qr_placement").notNull().default("top-left"),
  qrSizePercent: integer("qr_size_percent").notNull().default(14),
  qrOpacity: real("qr_opacity").notNull().default(1.0),
  qrBgEnabled: boolean("qr_bg_enabled").notNull().default(true),
  qrBgOpacity: real("qr_bg_opacity").notNull().default(0.5),
  introAssetId: uuid("intro_asset_id"),
  outroAssetId: uuid("outro_asset_id"),
  loopEnabled: boolean("loop_enabled").notNull().default(false),
  loopMode: text("loop_mode").notNull().default("main-only"),
  brandColor: text("brand_color").notNull().default("#ffc42c"),
  theme: text("theme").notNull().default("classic"),
  showDisplayNames: boolean("show_display_names").notNull().default(true),
  showHeadlines: boolean("show_headlines").notNull().default(true),
  displayNameText: text("display_name_text").notNull().default(""),
  headlineText: text("headline_text").notNull().default(""),
  displayNamePosition: text("display_name_position").notNull().default("bottom-left"),
  displayNameBgEnabled: boolean("display_name_bg_enabled").notNull().default(true),
  displayNameBgColor: text("display_name_bg_color").notNull().default("#000000"),
  displayNameBgOpacity: real("display_name_bg_opacity").notNull().default(0.35),
  displayNameTextColor: text("display_name_text_color").notNull().default("#ffffff"),
  displayNameFontSize: integer("display_name_font_size").notNull().default(18),
  headlinePosition: text("headline_position").notNull().default("bottom-left"),
  headlineBgEnabled: boolean("headline_bg_enabled").notNull().default(true),
  headlineBgColor: text("headline_bg_color").notNull().default("#000000"),
  headlineBgOpacity: real("headline_bg_opacity").notNull().default(0.35),
  headlineTextColor: text("headline_text_color").notNull().default("#ffffff"),
  headlineFontSize: integer("headline_font_size").notNull().default(18),
  fontFamily: text("font_family").notNull().default("system"),
});

export const videoBanners = pgTable("video_banners", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  videoId: uuid("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  type: text("type").notNull().default("ticker"),
  position: text("position").notNull().default("bottom"),
  speed: integer("speed").notNull().default(18),
  backgroundColor: text("background_color").notNull().default("#0b3a66"),
  textColor: text("text_color").notNull().default("#ffffff"),
  fontSize: integer("font_size").notNull().default(18),
  opacity: real("opacity").notNull().default(1.0),
  paddingY: integer("padding_y").notNull().default(10),
  paddingX: integer("padding_x").notNull().default(16),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const videoWatermarkSettings = pgTable("video_watermark_settings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  videoId: uuid("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  logoEnabled: boolean("logo_enabled").notNull().default(false),
  logoUrl: text("logo_url"),
  logoPosition: text("logo_position").notNull().default("top-right"),
  logoOpacity: real("logo_opacity").notNull().default(0.8),
  tickerEnabled: boolean("ticker_enabled").notNull().default(false),
  tickerText: text("ticker_text").default(""),
  tickerSpeed: integer("ticker_speed").notNull().default(50),
  tickerOpacity: real("ticker_opacity").notNull().default(0.7),
  popEnabled: boolean("pop_enabled").notNull().default(false),
  popInterval: integer("pop_interval").notNull().default(30),
  popDuration: integer("pop_duration").notNull().default(3),
  popMode: text("pop_mode").notNull().default("random"),
  popOpacity: real("pop_opacity").notNull().default(0.8),
  popText: text("pop_text").default("{DOMAIN}"),
  tickerTextColor: text("ticker_text_color").notNull().default("#FFFFFF"),
  tickerFontSizePx: integer("ticker_font_size_px").notNull().default(14),
  tickerBgColor: text("ticker_bg_color").notNull().default("#000000"),
  authorEnabled: boolean("author_enabled").notNull().default(false),
  authorName: text("author_name").default(""),
  authorFontSizePx: integer("author_font_size_px").notNull().default(14),
  authorTextColor: text("author_text_color").notNull().default("#FFFFFF"),
  authorOpacity: real("author_opacity").notNull().default(0.8),
  authorBgColor: text("author_bg_color").notNull().default("transparent"),
  authorTextStyle: text("author_text_style").notNull().default("normal"),
});

export const videoSecuritySettings = pgTable("video_security_settings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  videoId: uuid("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  signedUrls: boolean("signed_urls").notNull().default(true),
  signedUrlTtl: integer("signed_url_ttl").notNull().default(120),
  domainWhitelistEnabled: boolean("domain_whitelist_enabled").notNull().default(false),
  allowedDomains: text("allowed_domains").array().default(sql`'{}'::text[]`),
  referrerStrict: boolean("referrer_strict").notNull().default(false),
  tokenRequired: boolean("token_required").notNull().default(true),
  tokenTtl: integer("token_ttl").notNull().default(86400),
  concurrentLimit: integer("concurrent_limit").notNull().default(5),
  rateLimitEnabled: boolean("rate_limit_enabled").notNull().default(false),
  hotlinkProtection: boolean("hotlink_protection").notNull().default(true),
  drmMode: boolean("drm_mode").notNull().default(false),
});

export const embedTokens = pgTable("embed_tokens", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  videoId: uuid("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  label: text("label").default(""),
  allowedDomain: text("allowed_domain"),
  expiresAt: timestamp("expires_at"),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  userId: text("user_id"),
});

export const playbackSessions = pgTable("playback_sessions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  videoId: uuid("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  tokenId: uuid("token_id"),
  sessionCode: text("session_code").notNull(),
  domain: text("domain"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
  secondsWatched: integer("seconds_watched").notNull().default(0),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  action: text("action").notNull(),
  meta: jsonb("meta"),
  ip: text("ip"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const systemSettings = pgTable("system_settings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(),
  value: text("value"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const videoClientSecurity = pgTable("video_client_security", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  videoId: uuid("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  useGlobal: boolean("use_global").notNull().default(true),
  blockVideoRecording: boolean("block_video_recording").notNull().default(false),
  blockScreenshots: boolean("block_screenshots").notNull().default(false),
  disableRightClick: boolean("disable_right_click").notNull().default(false),
  blockDevTools: boolean("block_dev_tools").notNull().default(true),
  enableFocusMode: boolean("enable_focus_mode").notNull().default(false),
  disableDownloads: boolean("disable_downloads").notNull().default(false),
  requireFullscreen: boolean("require_fullscreen").notNull().default(false),
  antiScreenSharing: boolean("anti_screen_sharing").notNull().default(false),
  suspiciousDetectionEnabled: boolean("suspicious_detection_enabled").notNull().default(true),
  violationLimit: integer("violation_limit").notNull().default(3),
  allowedBrowsers: text("allowed_browsers").array().default(sql`'{}'::text[]`),
});

export const storageConnections = pgTable("storage_connections", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  provider: text("provider").notNull(), // 'aws_s3' | 'backblaze_b2'
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const mediaAssets = pgTable("media_assets", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  type: text("type").notNull(),
  bucketKey: text("bucket_key").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  storageConnectionId: uuid("storage_connection_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertVideoSchema = createInsertSchema(videos).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertEmbedTokenSchema = createInsertSchema(embedTokens).omit({
  id: true,
  createdAt: true,
  token: true,
});

export const insertStorageConnectionSchema = createInsertSchema(storageConnections).omit({ id: true, createdAt: true });

export type InsertUser = { email: string; passwordHash: string };
export type AdminUser = typeof adminUsers.$inferSelect;
export type Video = typeof videos.$inferSelect;
export type VideoPlayerSettings = typeof videoPlayerSettings.$inferSelect;
export type VideoBanner = typeof videoBanners.$inferSelect;
export type VideoWatermarkSettings = typeof videoWatermarkSettings.$inferSelect;
export type VideoSecuritySettings = typeof videoSecuritySettings.$inferSelect;
export type EmbedToken = typeof embedTokens.$inferSelect;
export type PlaybackSession = typeof playbackSessions.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type SystemSetting = typeof systemSettings.$inferSelect;
export type StorageConnection = typeof storageConnections.$inferSelect;
export type VideoClientSecurity = typeof videoClientSecurity.$inferSelect;
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type InsertStorageConnection = z.infer<typeof insertStorageConnectionSchema>;

export type InsertVideo = z.infer<typeof insertVideoSchema>;
export type InsertEmbedToken = z.infer<typeof insertEmbedTokenSchema>;

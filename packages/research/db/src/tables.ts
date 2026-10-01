import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

/**
 * The research document's tables. Engine tables (jobs, sessions, meters) come
 * from `@samsara/db` and are never redeclared here.
 *
 * Receipts are append-only: nothing in this package updates or deletes one. A
 * fact points at the receipt it was read from, so a receipt that could change
 * would make every fact that cites it a claim about something else.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow()

export const docs = pgTable(
  "docs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    title: text("title").notNull(),
    /** Tiptap JSON. Blocks appear in it as atoms holding an id and nothing else. */
    content: jsonb("content").notNull(),
    /** Optimistic concurrency: a save names the version it was made against. */
    version: integer("version").notNull().default(1),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("docs_owner_idx").on(t.ownerId, t.updatedAt)],
)

export const blocks = pgTable(
  "blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    params: jsonb("params").notNull(),
    status: text("status").notNull().default("idle"),
    lastRunId: uuid("last_run_id"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("blocks_doc_idx").on(t.docId)],
)

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    blockId: uuid("block_id")
      .notNull()
      .references(() => blocks.id, { onDelete: "cascade" }),
    /** The kernel job that did the work. Opaque: engine rows are not referenced. */
    jobId: uuid("job_id"),
    outcome: text("outcome").notNull().default("running"),
    /** The question this run answered: the block's parameters when it started. */
    params: jsonb("params").notNull().default({}),
    runtimes: jsonb("runtimes").notNull().default([]),
    stats: jsonb("stats").notNull(),
    note: text("note"),
    startedAt: ts("started_at"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("runs_block_idx").on(t.blockId, t.startedAt)],
)

export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    runtime: text("runtime").notNull(),
    url: text("url").notNull(),
    sha256: text("sha256").notNull(),
    bytes: integer("bytes").notNull(),
    contentType: text("content_type").notNull(),
    ref: text("ref").notNull(),
    viewpoint: text("viewpoint"),
    profile: text("profile"),
    sessionId: uuid("session_id"),
    /** The HTML captured in the same page load, for a screenshot or a replay. */
    pairedWith: uuid("paired_with"),
    capturedAt: ts("captured_at"),
  },
  (t) => [
    index("receipts_run_idx").on(t.runId),
    uniqueIndex("receipts_run_sha_url_uq").on(t.runId, t.sha256, t.url),
  ],
)

export const facts = pgTable(
  "facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    blockId: uuid("block_id")
      .notNull()
      .references(() => blocks.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    key: text("key").notNull(),
    value: jsonb("value"),
    locator: jsonb("locator").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => [index("facts_run_idx").on(t.runId, t.subject), index("facts_block_idx").on(t.blockId)],
)

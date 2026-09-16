#!/usr/bin/env bash
#
# Run a command against the **hosted** database, and only when asked.
#
# `DATABASE_URL` in `.env` points at local Docker, and it must keep doing so. The
# repository's thirteen Postgres tests begin by truncating the tables they are
# about to use — correct in isolation, and the reason `@samsara/db/testing` holds
# an advisory lock so three packages do not truncate each other. None of that
# distinguishes "the disposable dev database" from "the database with a running
# seven-day experiment in it". `pnpm check` with a hosted `DATABASE_URL` in `.env`
# would report green and delete the week.
#
# So the hosted connection string lives in `.env.supabase`, which nothing loads by
# default, and reaches a command only through this wrapper:
#
#   ./tools/with-hosted-env.sh pnpm --filter @dt/db db:migrate
#
# STATUS has carried the note that the test suite truncates the same database
# `pnpm dev` drains since P0.8, as an architect's call that was "harmless while the
# dev data is disposable, and not the day it is not". This is that day, and this
# file is the smallest thing that keeps it harmless.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
envfile="$root/.env.supabase"

if [ ! -f "$envfile" ]; then
  echo "with-hosted-env: $envfile does not exist." >&2
  echo "It holds DATABASE_URL for the hosted database and is gitignored; see this file's header." >&2
  exit 1
fi

# `set -a` exports everything the file defines, so a child process that reads
# `process.env` sees it. Sourced rather than parsed, because a Postgres password
# is allowed to contain the characters that break a naive `xargs`.
set -a
# shellcheck source=/dev/null
. "$envfile"
set +a

if [ "${DATABASE_URL:-}" = "" ]; then
  echo "with-hosted-env: $envfile does not define DATABASE_URL." >&2
  exit 1
fi

# Never the value: a connection string in a terminal is a connection string in a
# scrollback, a screenshot and an agent's transcript. The host is enough to know
# which database is about to be written to.
echo "with-hosted-env: running against ${DATABASE_URL#*@}" >&2

exec "$@"

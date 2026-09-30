# OpenStreetMap snapshot

`bangkok.json.gz` is one Overpass API response for Bangkok's named places, taken
with `tools/load-osm.ts` on 29 September 2026 (`timestamp_osm_base`
2026-09-29T16:46:58Z). It is committed so a fresh clone can load the place index
without querying the public Overpass servers, which answer 504 when busy:

```bash
npx tsx --env-file=.env tools/load-osm.ts --from data/osm/bangkok.json.gz --commit
```

To refresh it, run `tools/load-osm.ts` without `--from`. The response lands in
`.osm/` (gitignored); gzip it over this file.

Data © OpenStreetMap contributors, available under the
[Open Database License](https://opendatacommons.org/licenses/odbl/1-0/).
See <https://www.openstreetmap.org/copyright>.

import { getDb } from "../../../lib/appDb";
import {
  EXPORT_ENTITIES,
  buildExportBundle,
  bundleToJson,
  exportEntityCsv,
  type ExportEntity,
} from "../../../lib/exportData";

/** Spec §79 data export, served straight from the dashboard so research isn't locked inside the
 * UI. `?format=json` returns the full bundle; `?format=csv&entity=<name>` returns one entity's
 * CSV (CSV can't cleanly hold five differently-shaped tables in one file, so each entity is its
 * own download — see the /settings page's per-entity links). */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "json";
  const db = getDb();
  const bundle = buildExportBundle(db);
  const timestamp = new Date().toISOString().slice(0, 10);

  if (format === "csv") {
    const entity = url.searchParams.get("entity") as ExportEntity | null;
    if (!entity || !EXPORT_ENTITIES.includes(entity)) {
      return new Response(`?entity must be one of: ${EXPORT_ENTITIES.join(", ")}`, { status: 400 });
    }
    return new Response(exportEntityCsv(bundle, entity), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${entity}-${timestamp}.csv"`,
      },
    });
  }

  return new Response(bundleToJson(bundle), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="aoh-export-${timestamp}.json"`,
    },
  });
}

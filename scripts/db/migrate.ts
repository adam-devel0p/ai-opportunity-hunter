import { runMigrations } from "../../src/db/migrate.js";

const dbPath = process.env.AOH_DB_PATH ?? "./data/aoh.db";
runMigrations(dbPath);
console.log(`Migrations applied to ${dbPath}`);

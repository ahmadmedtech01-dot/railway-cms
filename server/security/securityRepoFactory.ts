import type { SecurityRepo } from "./securityRepo";
import { PostgresSecurityRepo } from "./securityRepo.postgres";

let _instance: SecurityRepo | null = null;

export function getSecurityRepo(): SecurityRepo {
  if (_instance) return _instance;

  const driver = process.env.STORAGE_DRIVER ?? "postgres";

  if (driver === "postgres" || driver === "replitdb") {
    _instance = new PostgresSecurityRepo();
  } else {
    _instance = new PostgresSecurityRepo();
  }

  return _instance;
}

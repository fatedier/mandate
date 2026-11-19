import { buildManagerScope, type ManagerScopeDeps } from "../../runtime/scopes/manager-scope.js";
import { scopePack, type ScopePack } from "../../runtime/scope-packs.js";

export function buildManagerScopePack(deps: ManagerScopeDeps): ScopePack {
  return scopePack("manager", () => buildManagerScope(deps));
}

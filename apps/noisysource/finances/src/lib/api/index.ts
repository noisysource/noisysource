import { makeCompaniesDomain, type Company } from "./domains/companies";
import { makePeopleDomain, type Person } from "./domains/people";
import { makeAccountsDomain } from "./domains/accounts";
import { makeContractsDomain } from "./domains/contracts";
import { makePlannedDomain } from "./domains/planned";
import { makeCategoriesDomain } from "./domains/categories";
import { makeTemplatesDomain } from "./domains/templates";
import { makeFunctionsDomain } from "./domains/functions";
import { makeBackupDomain } from "./domains/backups";


export const api = (() => {
  let _orgId = "personal";
  const getOrgId = () => _orgId;

  return {
    get orgId() { return _orgId; },
    setOrg(orgId: string) { _orgId = orgId; },

    companies: makeCompaniesDomain(getOrgId),
    people: makePeopleDomain(getOrgId),
    accounts: makeAccountsDomain(getOrgId),
    contracts: makeContractsDomain(getOrgId),
    planned: makePlannedDomain(getOrgId),
    categories: makeCategoriesDomain(getOrgId),
    templates: makeTemplatesDomain(getOrgId),
    functions: makeFunctionsDomain(getOrgId),
    backup: makeBackupDomain(getOrgId),
  };
})();

export type { Company, Person };
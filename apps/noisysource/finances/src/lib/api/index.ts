import { makeCompaniesDomain, type Company } from "./domains/companies";
import { makePeopleDomain, type Person } from "./domains/people";
import { makeAccountsDomain } from "./domains/accounts";
import { makeContractsDomain } from "./domains/contracts";
import { makeCategoriesDomain } from "./domains/categories";
import { makeBackupDomain } from "./domains/backups";
import { makeEcContractsDomain } from "./domains/ecContracts";
import { makePayrollRunsDomain } from "./domains/payrollRuns";
import { makeRecurringDomain } from "./domains/recurring";
import { makeForecastEventsDomain } from "./domains/forecastEvents";
import { makeIRSConfigDomain } from "./domains/irsConfig";

export const api = (() => {
  let _entityId = "private";
  const getEntityId = () => _entityId;

  return {
    get entityId() { return _entityId; },
    setEntity(entityId: string) { _entityId = entityId; },

    companies: makeCompaniesDomain(),
    people: makePeopleDomain(),
    accounts: makeAccountsDomain(getEntityId),
    contracts: makeContractsDomain(getEntityId),
    categories: makeCategoriesDomain(getEntityId),
    backup: makeBackupDomain(getEntityId),
    ecContracts: makeEcContractsDomain(getEntityId),
    payrollRuns: makePayrollRunsDomain(getEntityId),
    recurring: makeRecurringDomain(getEntityId),
    forecastEvents: makeForecastEventsDomain(getEntityId),
    irsConfig: makeIRSConfigDomain(getEntityId),
  };
})();

export type { Company, Person };

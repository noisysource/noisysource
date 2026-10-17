import { makeCompaniesDomain, type Company } from "./domains/companies";
import { makePeopleDomain, type Person } from "./domains/people";
import { makeAccountsDomain } from "./domains/accounts";
import { makeContractsDomain } from "./domains/contracts";
import { makeCategoriesDomain } from "./domains/categories";
import { makeEcContractsDomain } from "./domains/ecContracts";
import { makePayrollRunsDomain } from "./domains/payrollRuns";
import { makeRecurringDomain } from "./domains/recurring";
import { makeForecastEventsDomain } from "./domains/forecastEvents";
import { makeIRSConfigDomain } from "./domains/irsConfig";
import { makeFinanceEventsDomain } from "./domains/financeEvents";
import { makeIncomeSourcesDomain } from "./domains/incomeSources";
import { makeCreditsDomain } from "./domains/credits";
import { makeKidclubDomain } from "./domains/kidclub";
import { makeCostSummaryDomain } from "./domains/costSummary";
import { makeLoansDomain } from "./domains/loans";
import { makeInsurancesDomain } from "./domains/insurances";
import { makeNotificationsDomain } from "./domains/notifications";
import { makeBankTransactionsDomain } from "./domains/bankTransactions";
import { makeMovementRulesDomain } from "./domains/movementRules";

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
    ecContracts: makeEcContractsDomain(getEntityId),
    payrollRuns: makePayrollRunsDomain(getEntityId),
    recurring: makeRecurringDomain(getEntityId),
    forecastEvents: makeForecastEventsDomain(getEntityId),
    irsConfig: makeIRSConfigDomain(getEntityId),
    financeEvents: makeFinanceEventsDomain(),
    incomeSources: makeIncomeSourcesDomain(getEntityId),
    credits: makeCreditsDomain(getEntityId),
    loans: makeLoansDomain(getEntityId),
    insurances: makeInsurancesDomain(getEntityId),
    notifications: makeNotificationsDomain(),
    bankTransactions: makeBankTransactionsDomain(),
    movementRules: makeMovementRulesDomain(getEntityId),
    kidclub: makeKidclubDomain(),
    costSummary: makeCostSummaryDomain(),
  };
})();

export type { Company, Person };

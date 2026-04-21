export interface PartyType {
  id: string;
  name: string;
  description: string;
  basePrice: number;
  includedKids: number;
  pricePerExtraChild: number;
}

export interface ExtraItem {
  id: string;
  name: string;
  price: number;
  description?: string;
  themes?: string[];
}

export interface PartyConfig {
  partyTypes: PartyType[];
  extras: ExtraItem[];
}
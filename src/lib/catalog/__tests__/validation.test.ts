import { predefinedCardsData } from "../../static-catalog";
import type { StaticPredefinedCard } from "../../static-catalog";
import { validateStaticCatalog } from "../validation";

function copyCatalog(): StaticPredefinedCard[] {
  return JSON.parse(JSON.stringify(predefinedCardsData)) as StaticPredefinedCard[];
}

describe("global static catalog validation", () => {
  it("validates every explicit identity and preserves AMEX invariants", () => {
    expect(validateStaticCatalog(predefinedCardsData)).toEqual({
      cards: 38,
      benefits: 135,
      amexCards: 12,
      amexBenefits: 56,
      amexWritableBenefits: 47,
    });
  });

  it("keeps identity stable when mutable terms and source ordering change", () => {
    const catalog = copyCatalog();
    const card = catalog.find((candidate) => candidate.catalogKey === "card:csp")!;
    const originalCardKey = card.catalogKey;
    const originalBenefitKeys = card.benefits.map((benefit) => benefit.catalogKey).sort();
    card.name = "Renamed product terms";
    card.benefits[0].description = "Rewritten current benefit terms";
    card.benefits = [...card.benefits].reverse();

    expect(validateStaticCatalog(catalog)).toEqual(expect.objectContaining({ cards: 38, benefits: 135 }));
    expect(card.catalogKey).toBe(originalCardKey);
    expect(card.benefits.map((benefit) => benefit.catalogKey).sort()).toEqual(originalBenefitKeys);
  });

  it("matches AMEX rows by key after source order changes", () => {
    const catalog = copyCatalog();
    const platinum = catalog.find((card) => card.catalogKey === "card:american-express-platinum-card")!;
    platinum.benefits = [...platinum.benefits].reverse();
    expect(validateStaticCatalog(catalog).amexBenefits).toBe(56);
  });

  it("models the finite Ink Business Unlimited Instacart promotion as a conditional monthly credit", () => {
    expect(predefinedCardsData.find((card) => card.catalogKey === "card:ink-business-unlimited")).toEqual({
      catalogKey: "card:ink-business-unlimited",
      name: "Ink Business Unlimited Credit Card",
      issuer: "Chase",
      annualFee: 0,
      imageUrl: "/images/cards/ink-business-unlimited-credit-card.png",
      benefits: [{
        catalogKey: "benefit:ink-business-unlimited:20-monthly-instacart-credit-through-2027",
        parentCatalogKey: "card:ink-business-unlimited",
        description: "$20 Monthly Instacart Credit (active Instacart+ membership required; through 12/31/2027)",
        category: "Food Delivery",
        maxAmount: 20,
        frequency: "MONTHLY",
        cycleAlignment: "CALENDAR_FIXED",
        percentage: 0,
      }],
    });
  });

  it.each([
    ["missing", (catalog: StaticPredefinedCard[]) => { (catalog[0] as { catalogKey?: string }).catalogKey = undefined; }],
    ["duplicate key", (catalog: StaticPredefinedCard[]) => { catalog[1].catalogKey = catalog[0].catalogKey; }],
    ["duplicate persisted name", (catalog: StaticPredefinedCard[]) => { catalog[1].name = catalog[0].name; }],
    ["positional", (catalog: StaticPredefinedCard[]) => { catalog[0].benefits[0].catalogKey = "benefit:csp:1"; }],
    ["parent", (catalog: StaticPredefinedCard[]) => { catalog[0].benefits[0].parentCatalogKey = "card:wrong-parent"; }],
    ["partial AMEX", (catalog: StaticPredefinedCard[]) => { delete catalog.find((card) => card.issuer === "American Express")!.benefits[0].periodKey; }],
    ["registry", (catalog: StaticPredefinedCard[]) => { catalog.find((card) => card.issuer === "American Express")!.benefits[0].catalogKey += "-changed"; }],
  ])("rejects %s identity drift", (_label, mutate) => {
    const catalog = copyCatalog();
    mutate(catalog);
    expect(() => validateStaticCatalog(catalog)).toThrow();
  });
});

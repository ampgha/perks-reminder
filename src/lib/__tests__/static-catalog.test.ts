import { americanExpressCardCatalog } from '../american-express-card-catalog';
import { AMEX_CATALOG_IDENTITY_REGISTRY, AMEX_WRITABLE_DESTINATIONS } from '../amex-catalog/catalog-registry';
import {
  benefitUsageWays,
  calculateAnnualBenefitValue,
  getPublicStaticCardByName,
  getPublicStaticCards,
  getStaticSearchSuggestions,
  predefinedCardsData,
} from '../static-catalog';

describe('static catalog', () => {
  it('projects predefined cards with stable public ids and usage-guide links', () => {
    const cards = getPublicStaticCards();

    expect(cards.length).toBe(predefinedCardsData.length);
    expect(cards[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      name: expect.any(String),
      benefits: expect.any(Array),
    }));
    expect(cards.flatMap((card) => card.benefits).every((benefit) => benefit.id.length > 0)).toBe(true);
    expect(cards.flatMap((card) => card.benefits).every((benefit) => benefit.usageWay?.slug)).toBe(true);
  });

  it('reuses every shared Amex card without changing its website catalog data', () => {
    expect(predefinedCardsData.filter((card) => card.issuer === 'American Express')).toEqual(
      Object.values(americanExpressCardCatalog),
    );
  });

  it('keys and classifies all 12 Amex cards and 56 benefits without duplicate destination tuples', () => {
    const cards = Object.values(americanExpressCardCatalog);
    const benefits = cards.flatMap((card) => card.benefits);
    expect(cards).toHaveLength(12);
    expect(benefits).toHaveLength(56);
    expect(Object.keys(AMEX_CATALOG_IDENTITY_REGISTRY)).toHaveLength(12);
    expect(cards.every((card) => Boolean(card.productKey))).toBe(true);
    expect(benefits.every((benefit) => Boolean(
      benefit.productKey && benefit.creditFamilyKey && benefit.periodKey && benefit.sourceSemantics,
    ))).toBe(true);
    const tuples = benefits.map((benefit) => `${benefit.productKey}|${benefit.creditFamilyKey}|${benefit.periodKey}`);
    expect(new Set(tuples).size).toBe(tuples.length);
    expect(benefits.filter((benefit) => benefit.sourceSemantics !== 'usage').every((benefit) => benefit.sourceCreditKey === null)).toBe(true);
    expect(AMEX_WRITABLE_DESTINATIONS).toHaveLength(benefits.filter((benefit) => benefit.sourceSemantics === 'usage').length);
  });

  it('finds cards by public route name', () => {
    expect(getPublicStaticCardByName('American Express Gold Card')).toEqual(expect.objectContaining({
      issuer: 'American Express',
    }));
  });

  it('publishes the Marriott Bonvoy Bold limited-time delivery benefits', () => {
    const card = predefinedCardsData.find(
      (candidate) => candidate.catalogKey === 'card:marriott-bonvoy-bold',
    );

    expect(card).toEqual(expect.objectContaining({
      name: 'Marriott Bonvoy Bold Credit Card',
      issuer: 'Chase',
      annualFee: 0,
      imageUrl: '/images/cards/chase-marriott-bonvoy-bold.png',
    }));
    expect(card?.benefits).toEqual([
      expect.objectContaining({
        catalogKey: 'benefit:marriott-bonvoy-bold:10-quarterly-doordash-non-restaurant-discount-through-2027',
        parentCatalogKey: 'card:marriott-bonvoy-bold',
        maxAmount: 10,
        frequency: 'QUARTERLY',
        cycleAlignment: 'CALENDAR_FIXED',
      }),
      expect.objectContaining({
        catalogKey: 'benefit:marriott-bonvoy-bold:10-monthly-instacart-credit-through-2027',
        parentCatalogKey: 'card:marriott-bonvoy-bold',
        maxAmount: 10,
        frequency: 'MONTHLY',
        cycleAlignment: 'CALENDAR_FIXED',
      }),
    ]);
  });

  it('keeps annual value and suggestions available without a database', () => {
    expect(calculateAnnualBenefitValue(10, 'MONTHLY')).toBe(120);
    expect(getStaticSearchSuggestions()).toEqual(expect.arrayContaining(['American Express', 'Dining', 'amex']));
    expect(benefitUsageWays.length).toBeGreaterThan(0);
  });
});

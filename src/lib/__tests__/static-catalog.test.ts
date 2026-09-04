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

  it('publishes both World of Hyatt Category 1–4 certificate cycles', () => {
    const card = predefinedCardsData.find(
      (candidate) => candidate.catalogKey === 'card:world-of-hyatt',
    );

    expect(card).toEqual(expect.objectContaining({
      name: 'World of Hyatt Credit Card',
      issuer: 'Chase',
      annualFee: 95,
      imageUrl: '/images/cards/chase-world-of-hyatt.png',
    }));
    expect(card?.benefits).toEqual([
      expect.objectContaining({
        catalogKey: 'benefit:world-of-hyatt:annual-category-1-4-free-night-award',
        parentCatalogKey: 'card:world-of-hyatt',
        maxAmount: 0,
        frequency: 'YEARLY',
        cycleAlignment: 'CARD_ANNIVERSARY',
      }),
      expect.objectContaining({
        catalogKey: 'benefit:world-of-hyatt:category-1-4-free-night-award-after-15k-calendar-year-spend',
        parentCatalogKey: 'card:world-of-hyatt',
        maxAmount: 0,
        frequency: 'YEARLY',
        cycleAlignment: 'CALENDAR_FIXED',
        fixedCycleStartMonth: 1,
        fixedCycleDurationMonths: 12,
      }),
    ]);
    expect(
      getPublicStaticCardByName('World of Hyatt Credit Card')?.benefits
        .map((benefit) => benefit.usageWay?.slug),
    ).toEqual(['benefit-checklist', 'benefit-checklist']);
  });

  it('keeps annual value and suggestions available without a database', () => {
    expect(calculateAnnualBenefitValue(10, 'MONTHLY')).toBe(120);
    expect(getStaticSearchSuggestions()).toEqual(expect.arrayContaining(['American Express', 'Dining', 'amex']));
    expect(benefitUsageWays.length).toBeGreaterThan(0);
  });
});

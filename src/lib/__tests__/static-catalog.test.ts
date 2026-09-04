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

  it('defines the Citi Strata Premier annual hotel benefit as a calendar-year credit', () => {
    const card = getPublicStaticCardByName('Citi Strata Premier® Card');

    expect(card).toEqual(expect.objectContaining({
      catalogKey: 'card:citi-strata-premier',
      issuer: 'Citi',
      annualFee: 95,
      imageUrl: '/images/cards/citi-strata-premier-card.webp',
    }));
    expect(card?.benefits).toEqual([
      expect.objectContaining({
        catalogKey: 'benefit:citi-strata-premier:up-to-100-annual-hotel-benefit-500-stay-through-citi-travel',
        parentCatalogKey: 'card:citi-strata-premier',
        maxAmount: 100,
        frequency: 'YEARLY',
        cycleAlignment: 'CALENDAR_FIXED',
        fixedCycleStartMonth: 1,
        fixedCycleDurationMonths: 12,
        usageWay: {
          slug: 'citi-travel-hotel-benefit',
          title: 'How to Use Citi Travel Hotel Benefits',
        },
      }),
    ]);
  });

  it('documents the Citi Strata Premier payment and cancellation rules without applying them to other Citi cards', () => {
    const guide = benefitUsageWays.find(({ slug }) => slug === 'citi-travel-hotel-benefit');

    expect(guide?.content).toContain(
      'prepay the complete stay with the card, ThankYou Points, or a combination of both',
    );
    expect(guide?.content).toContain(
      'the cancellation is processed within the same calendar year, the benefit remains available',
    );
    expect(guide?.content).toContain(
      'the cancellation is processed in a later calendar year, the benefit from the prior calendar year is forfeited',
    );
    expect(guide?.content).toContain(
      'Do not assume another Citi card, including Citi Strata Elite, has identical payment or cancellation terms',
    );
    expect(guide?.content).not.toContain('Pay with the eligible Citi card.');
  });

  it('keeps annual value and suggestions available without a database', () => {
    expect(calculateAnnualBenefitValue(10, 'MONTHLY')).toBe(120);
    expect(getStaticSearchSuggestions()).toEqual(expect.arrayContaining(['American Express', 'Dining', 'amex']));
    expect(benefitUsageWays.length).toBeGreaterThan(0);
  });
});

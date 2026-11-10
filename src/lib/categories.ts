/** Ledger expense categories. The Clocked Decide endpoint picks one per line item. */
export const CATEGORIES = [
  "Groceries",
  "Food & Dining",
  "Transport & Fuel",
  "Utilities",
  "Office & Supplies",
  "Inventory / Stock",
  "Rent",
  "Health",
  "Entertainment",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** One-line description per category, used as the `criteria` map for Clocked
 *  Decide `choice` questions (the SDK's ChoiceQuestion requires `criteria`,
 *  not `options`). */
export const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  Groceries: "Everyday food and household grocery items bought for home or shop use",
  "Food & Dining": "Meals, drinks, and food eaten out at a restaurant, cafe, or food stall",
  "Transport & Fuel": "Travel, vehicle fuel, rides, parking, and tolls",
  Utilities: "Electricity, water, gas, internet, and phone bills",
  "Office & Supplies": "Stationery, office equipment, and workplace supplies",
  "Inventory / Stock": "Goods bought in bulk or wholesale to resell in the shop",
  Rent: "Rent or lease payments for a shop, office, or property",
  Health: "Medicine, pharmacy, clinic, and medical expenses",
  Entertainment: "Movies, games, concerts, tickets, and subscriptions for fun",
  Other: "Anything that does not fit the other categories",
};

/** Deterministic keyword fallback for categorisation (used only when Clocked
 *  returns no category for a line, and for the clearly-labelled demo parser).
 *  The live path prefers the Clocked Decide answer with its probability. */
const KEYWORDS: Array<{ re: RegExp; category: Category }> = [
  { re: /\b(rice|flour|atta|sugar|oil|ghee|milk|bread|egg|vegetable|fruit|grocery|mart|store|supermarket|karyana)\b/i, category: "Groceries" },
  { re: /\b(restaurant|cafe|coffee|tea|chai|burger|pizza|lunch|dinner|food|bakery|samosa)\b/i, category: "Food & Dining" },
  { re: /\b(petrol|diesel|fuel|uber|careem|taxi|bus|metro|parking|toll|rickshaw)\b/i, category: "Transport & Fuel" },
  { re: /\b(electricity|water|gas bill|internet|wifi|mobile|phone bill|lesco|wapda)\b/i, category: "Utilities" },
  { re: /\b(paper|pen|printer|ink|stationery|notebook|office|desk|chair)\b/i, category: "Office & Supplies" },
  { re: /\b(stock|wholesale|inventory|supplier|carton|bulk)\b/i, category: "Inventory / Stock" },
  { re: /\b(rent|lease)\b/i, category: "Rent" },
  { re: /\b(pharmacy|medicine|doctor|clinic|hospital|medical)\b/i, category: "Health" },
  { re: /\b(movie|cinema|game|concert|ticket|netflix|spotify)\b/i, category: "Entertainment" },
];

export function guessCategory(description: string): Category {
  for (const { re, category } of KEYWORDS) {
    if (re.test(description)) return category;
  }
  return "Other";
}

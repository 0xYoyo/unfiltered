/**
 * Colour vocabulary shared across the engine and its consumers.
 *
 * CLASSIFIER_COLOR_WORDS is the classifier's own list (YOY-61): a colour
 * next to anything else makes a query constraint-shaped. It stays
 * deliberately small so an unlisted colour never blocks the classic fast
 * path, and it is not extended here — routing behaviour is pinned by the
 * eval goldens.
 *
 * The product-family rule reads two sets (YOY-117 AC-1, split on YOY-125
 * AC-11). COLORWAY_COLORS holds the words that are a colour ON THEIR OWN —
 * the classifier list plus the common colourway vocabulary of fashion
 * catalogues, finishes and patterns included ("floral", "multi") because a
 * catalogue really does sell "Dress - Floral" as a variant. COLORWAY_MODIFIERS
 * holds the shade and finish adjectives that only ever qualify a colour
 * ("dusty pink", "washed indigo", "soft", "natural"): a designator made of a
 * modifier alone names the product, not its colourway. `print` sits with the
 * colours, not the modifiers (YOY-125 AC-17): it is a TERMINAL colourway word
 * — "Leopard Print", "Ditsy Print", and the bare "- Print" a catalogue really
 * does sell — so treating it as a leading modifier split one product family
 * into a card per pattern.
 *
 * A trailing title designator (`in <Colour>`, `- <Colour>`, `/ <Colour>`,
 * `(<Colour>)`) is a colourway when `isColorwayDesignator` accepts it: one
 * word that is a colour, or two words whose LAST word is a colour. Before the
 * split, the rule tested only the designator's last word against the union,
 * so "Jacket - Soft", "Sofa (Natural)" and "Tee / Light" collapsed with
 * "Jacket", "Sofa" and "Tee" of the same vendor and type — hiding a different
 * product behind a colourway that was never one.
 */
export const CLASSIFIER_COLOR_WORDS: ReadonlySet<string> = new Set([
  "black",
  "white",
  "red",
  "blue",
  "green",
  "yellow",
  "pink",
  "purple",
  "orange",
  "brown",
  "grey",
  "gray",
  "beige",
  "gold",
  "silver",
  "navy",
  "שחור",
  "שחורה",
  "לבן",
  "לבנה",
  "אדום",
  "אדומה",
  "כחול",
  "כחולה",
  "ירוק",
  "ירוקה",
  "צהוב",
  "צהובה",
  "ורוד",
  "ורודה",
  "סגול",
  "סגולה",
  "כתום",
  "כתומה",
  "חום",
  "חומה",
  "אפור",
  "אפורה",
  "בז'",
  "זהב",
  "כסף",
]);

export const COLORWAY_COLORS: ReadonlySet<string> = new Set([
  ...CLASSIFIER_COLOR_WORDS,
  "ivory",
  "cream",
  "off-white",
  "ecru",
  "tan",
  "camel",
  "khaki",
  "olive",
  "sage",
  "teal",
  "turquoise",
  "aqua",
  "mint",
  "lime",
  "coral",
  "peach",
  "blush",
  "rose",
  "fuchsia",
  "magenta",
  "lavender",
  "lilac",
  "violet",
  "indigo",
  "cobalt",
  "burgundy",
  "maroon",
  "wine",
  "rust",
  "terracotta",
  "mustard",
  "charcoal",
  "graphite",
  "slate",
  "stone",
  "sand",
  "taupe",
  "nude",
  "chocolate",
  "espresso",
  "denim",
  "multi",
  "multicolour",
  "multicolor",
  "floral",
  "print",
  "striped",
  "bronze",
  "copper",
  "platinum",
  "pearl",
  "oat",
  "oatmeal",
  "forest",
  "emerald",
  "ruby",
  "sapphire",
  "plum",
  "berry",
  "cherry",
  "lemon",
  "mocha",
  "cognac",
  "mauve",
  "petrol",
  "bordeaux",
  "anthracite",
  "heather",
  "marl",
  "ochre",
  "saffron",
  "apricot",
  "tangerine",
  "scarlet",
  "crimson",
  "cyan",
]);

/**
 * Words allowed only as the FIRST word of a two-word designator: each
 * qualifies a colour and is never a colourway on its own.
 */
export const COLORWAY_MODIFIERS: ReadonlySet<string> = new Set([
  "light",
  "dark",
  "pale",
  "deep",
  "bright",
  "dusty",
  "soft",
  "washed",
  "vintage",
  "faded",
  "heathered",
  "mottled",
  "metallic",
  "matte",
  "glossy",
  "natural",
  "royal",
]);

/** The committed colourway vocabulary: colours plus their modifiers. */
export const COLORWAY_WORDS: ReadonlySet<string> = new Set([
  ...COLORWAY_COLORS,
  ...COLORWAY_MODIFIERS,
]);

/**
 * Whether a designator's words (lowercased, punctuation-trimmed) name a
 * colourway: one word that is a colour on its own, or two words whose LAST
 * word is a colour — the first may be anything, so an unlisted shade name
 * ("Meteorite Black") still reads as a colourway. Longer designators are
 * product names, never colourways.
 */
export function isColorwayDesignator(words: readonly string[]): boolean {
  const cleaned = words.map((word) => word.trim().toLowerCase()).filter((word) => word !== "");
  if (cleaned.length === 0 || cleaned.length > 2) {
    return false;
  }
  return COLORWAY_COLORS.has(cleaned[cleaned.length - 1]!);
}

import { expect, test, type Page } from "@playwright/test";

/**
 * The widget's negated chips (YOY-123 AC-4).
 *
 * "Not black" and "black" are opposite instructions, and until now the
 * label alone carried the whole difference on both widget surfaces. The
 * playground marks an exclusion with an accent tint (P-9); the widget
 * cannot — **W-3 forbids it any hue the host page does not already have** —
 * so it marks one achromatically: a heavier border and the excluded VALUE
 * struck through, both drawn in the theme's own inherited colour, with the
 * negator word left upright so the chip does not read as a double negative.
 *
 * These assertions are the durable form of that claim. `negation-chips`
 * baselines in the Dawn-shaped harness (desktop + mobile, EN + HE) are the
 * design evidence beside them.
 */

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };

const themeInput = (page: Page) =>
  page.locator('input[type="search"]').first();
const nativeChips = (page: Page) =>
  page.getByTestId("unfiltered-native-chip");
const overlayChips = (page: Page) => page.getByTestId("unfiltered-widget-chip");

async function submitQuery(page: Page, query: string): Promise<void> {
  await themeInput(page).fill(query);
  await themeInput(page).press("Enter");
}

/** The skin a chip actually paints, for comparing an exclusion to a plain one. */
async function skinOf(locator: ReturnType<Page["locator"]>): Promise<{
  borderWidth: string;
  borderColor: string;
  background: string;
  color: string;
}> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderWidth: style.borderTopWidth,
      borderColor: style.borderTopColor,
      background: style.backgroundColor,
      color: style.color,
    };
  });
}

/** True when a colour is a grey/black/white — no hue of its own. */
function isAchromatic(color: string): boolean {
  const parts = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  if (parts.length < 3) {
    return true; // transparent / a keyword with no channels
  }
  const [r, g, b] = parts;
  return Math.max(r, g, b) - Math.min(r, g, b) <= 2;
}

test.describe("theme-native mirror", () => {
  test("an excluded constraint is marked, and marked without a hue (W-3)", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/theme-native.html?native=A&fixture=ai-negation");
    await submitQuery(page, "dress not black not wool");
    await expect(nativeChips(page)).toHaveCount(3);

    const plain = nativeChips(page).filter({ hasText: "dress" });
    const excluded = page.locator("[data-chip-negated='true']");
    await expect(excluded).toHaveCount(2);

    // Marked: the border is heavier than a plain chip's.
    const plainSkin = await skinOf(plain);
    const excludedSkin = await skinOf(excluded.first());
    expect(Number.parseFloat(excludedSkin.borderWidth)).toBeGreaterThan(
      Number.parseFloat(plainSkin.borderWidth),
    );

    // …and marked with NOTHING else: same colour, same border colour, no
    // fill appeared. Whatever the theme paints, the exclusion paints too.
    expect(excludedSkin.borderColor).toBe(plainSkin.borderColor);
    expect(excludedSkin.background).toBe(plainSkin.background);
    expect(excludedSkin.color).toBe(plainSkin.color);

    // No hue of ours anywhere on the chip.
    for (const [role, value] of Object.entries(excludedSkin)) {
      if (role === "borderWidth") {
        continue;
      }
      expect(isAchromatic(value), `${role} is ${value}`).toBe(true);
    }
  });

  test("the excluded value is struck and the negator is not", async ({
    page,
  }) => {
    await page.goto("/theme-native.html?native=A&fixture=ai-negation");
    await submitQuery(page, "dress not black not wool");
    await expect(nativeChips(page)).toHaveCount(3);

    const chip = page.locator("[data-chip-field='colorsExclude']");
    await expect(chip.locator(".unfiltered-native__chip-negator")).toHaveText(
      "Not",
    );
    await expect(chip.locator(".unfiltered-native__chip-value")).toHaveText(
      "black",
    );

    const struck = await chip
      .locator(".unfiltered-native__chip-value")
      .evaluate((element) => getComputedStyle(element).textDecorationLine);
    expect(struck).toContain("line-through");

    const negator = await chip
      .locator(".unfiltered-native__chip-negator")
      .evaluate((element) => getComputedStyle(element).textDecorationLine);
    expect(negator).not.toContain("line-through");

    // A plain chip has neither part and no strike at all.
    const plain = nativeChips(page).filter({ hasText: "dress" });
    await expect(
      plain.locator(".unfiltered-native__chip-value"),
    ).toHaveCount(0);
  });

  test("the accessible name is the whole label, unstruck", async ({ page }) => {
    await page.goto("/theme-native.html?native=A&fixture=ai-negation");
    await submitQuery(page, "dress not black not wool");
    await expect(nativeChips(page)).toHaveCount(3);

    // The strike is a visual mark; a screen reader still hears the filter.
    await expect(
      page.locator("[data-chip-field='colorsExclude']"),
    ).toHaveAttribute("aria-label", "Remove filter: Not black");
    await expect(
      page.locator("[data-chip-field='attributesExclude']"),
    ).toHaveAttribute("aria-label", "Remove filter: Not wool");
  });

  test("an exclusion is still a removable filter (W-7)", async ({ page }) => {
    await page.goto("/theme-native.html?native=A&fixture=ai-negation");
    await submitQuery(page, "dress not black not wool");
    await expect(nativeChips(page)).toHaveCount(3);

    await page.locator("[data-chip-field='colorsExclude']").click();
    await expect(nativeChips(page)).toHaveCount(2);
  });

  test("Hebrew strikes the value and leaves לא upright", async ({ page }) => {
    await page.goto(
      "/theme-native.html?native=A&fixture=ai-negation&locale=he&lang=he",
    );
    await submitQuery(page, "שמלה לא שחורה");
    await expect(nativeChips(page)).toHaveCount(3);

    const chip = page.locator("[data-chip-field='colorsExclude']");
    await expect(chip.locator(".unfiltered-native__chip-negator")).toHaveText(
      "לא",
    );
    await expect(chip.locator(".unfiltered-native__chip-value")).toHaveText(
      "שחור",
    );
  });
});

test.describe("shadow-DOM overlay", () => {
  test("an excluded constraint is marked achromatically there too", async ({
    page,
  }) => {
    await page.goto("/?fixture=ai&lang=en");
    await themeInput(page).fill("blue dress");
    await themeInput(page).press("Enter");
    await expect(overlayChips(page)).toHaveCount(3);
    const plainSkin = await skinOf(overlayChips(page).first());

    await page.goto("/?fixture=ai-color-exclude&lang=en");
    await themeInput(page).fill("dress not black");
    await themeInput(page).press("Enter");
    await expect(overlayChips(page)).toHaveCount(1);

    const chip = overlayChips(page).first();
    await expect(chip).toHaveAttribute("data-chip-negated", "true");
    const excludedSkin = await skinOf(chip);
    expect(Number.parseFloat(excludedSkin.borderWidth)).toBeGreaterThan(
      Number.parseFloat(plainSkin.borderWidth),
    );
    expect(excludedSkin.borderColor).toBe(plainSkin.borderColor);
    expect(excludedSkin.background).toBe(plainSkin.background);
    for (const [role, value] of Object.entries(excludedSkin)) {
      if (role === "borderWidth") {
        continue;
      }
      expect(isAchromatic(value), `${role} is ${value}`).toBe(true);
    }

    const struck = await chip
      .locator(".chip-value")
      .evaluate((element) => getComputedStyle(element).textDecorationLine);
    expect(struck).toContain("line-through");
  });
});

/**
 * Dawn-mirror evidence (AC-4): the negation chips as they render inside the
 * Dawn-shaped theme's own search-results page, desktop and mobile, EN and
 * HE. Per-OS like every other baseline in this lane.
 */
test.describe("Dawn-mirror baselines", () => {
  for (const [device, viewport] of [
    ["desktop", DESKTOP],
    ["mobile", MOBILE],
  ] as const) {
    for (const [locale, suffix, query] of [
      ["en", "", "dress not black not wool"],
      ["he", "&locale=he&lang=he", "שמלה לא שחורה"],
    ] as const) {
      test(`negation chips — ${locale} ${device}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(
          `/theme-native.html?native=A&fixture=ai-negation${suffix}`,
        );
        await submitQuery(page, query);
        await expect(nativeChips(page)).toHaveCount(3);
        await page.getByTestId("unfiltered-native-item").nth(2).waitFor();
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(
          `native-negation-${locale}-${device}.png`,
        );
      });
    }
  }
});

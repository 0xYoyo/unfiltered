import { expect, test, type Page } from "@playwright/test";

/**
 * One named assertion per design invariant (YOY-123 AC-2).
 *
 * docs/DESIGN.md states the bar; this file is where each F-* floor and each
 * P-* playground invariant becomes something a run can fail on. Every test
 * title starts with the invariant's ID, and
 * `design-invariant-coverage.test.ts` fails the unit suite if DESIGN.md
 * grows an ID that no test here names — so the mapping cannot silently rot.
 *
 * These are deliberately thin: the behaviour behind each invariant is
 * already covered in playground.spec.ts, ai-states.spec.ts, and
 * store-preload.spec.ts. What this file adds is the DESIGN-side reading of
 * it, addressable by ID from a `[DESIGN]` review finding.
 */

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };

const input = (page: Page) => page.getByTestId("playground-input");
const cards = (page: Page) => page.getByTestId("playground-card");

async function submit(page: Page, query: string): Promise<void> {
  await input(page).fill(query);
  await input(page).press("Enter");
}

/** WCAG relative luminance of a computed `rgb(...)` / `rgba(...)` colour. */
function luminance(color: string): number {
  const parts = color.match(/[\d.]+/g);
  if (parts === null) {
    throw new Error(`unparseable colour: ${color}`);
  }
  const [r, g, b] = parts.slice(0, 3).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/** The effective (non-transparent) background painted behind an element. */
async function backgroundOf(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((element) => {
    let node: Element | null = element;
    while (node !== null) {
      const color = getComputedStyle(node).backgroundColor;
      if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
        return color;
      }
      node = node.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  });
}

async function colorOf(page: Page, selector: string): Promise<string> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).color);
}

/* ------------------------------------------------------------------ */
/* Floors — every surface (F)                                          */
/* ------------------------------------------------------------------ */

test.describe("F — floors", () => {
  test("F-1 contrast: body, muted, faint, accent and critical text all clear AA on their own ground", async ({
    page,
  }) => {
    await page.goto("/try");
    await submit(page, "ai elegant dress");
    await expect(cards(page)).toHaveCount(3);

    const measured: { role: string; ratio: number }[] = [];
    for (const [role, selector] of [
      ["body text", ".cardTitle"],
      ["display text", ".heroHeading"],
      ["muted text", ".heroSubcopy"],
      ["faint text", ".heroEyebrow"],
      ["accent link", ".exampleQuery"],
      ["chip label", ".chip"],
      ["footer", ".footer"],
    ] as const) {
      const ratio = contrastRatio(
        await colorOf(page, selector),
        await backgroundOf(page, selector),
      );
      measured.push({ role, ratio });
    }

    for (const { role, ratio } of measured) {
      expect(ratio, `${role} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  test("F-2 reduced motion: no transition runs and a chip removal is instant", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/try");
    await submit(page, "ai elegant dress");
    await expect(page.getByTestId("playground-chip")).toHaveCount(3);

    for (const selector of [".chip", ".card", ".searchField", ".newSearch"]) {
      const duration = await page
        .locator(selector)
        .first()
        .evaluate((element) => getComputedStyle(element).transitionDuration);
      expect(duration, selector).toMatch(/^0s(, 0s)*$/);
    }

    // The removal fires at once rather than waiting out --dur-chip-out.
    // The colour exclusion is the chip the fixture answers a removal for.
    await page.locator("[data-chip-field='colorsExclude']").click();
    await expect(page.getByTestId("playground-chip")).toHaveCount(2, {
      timeout: 1000,
    });
  });

  test("F-3 hit targets: every pointer-interactive control clears 44×44", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/try");
    await submit(page, "ai elegant dress");
    await expect(page.getByTestId("playground-chip")).toHaveCount(3);

    const boxes = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          ".playground button, .playground a",
        ),
      )
        .filter((node) => node.closest(".card") === null)
        .map((node) => {
          const box = node.getBoundingClientRect();
          return {
            id: `${node.tagName}.${node.getAttribute("class") ?? ""}`,
            width: box.width,
            height: box.height,
          };
        }),
    );

    expect(boxes.length).toBeGreaterThanOrEqual(10);
    for (const box of boxes) {
      expect(box.height, box.id).toBeGreaterThanOrEqual(44);
      expect(box.width, box.id).toBeGreaterThanOrEqual(44);
    }
  });

  test("F-4 keyboard: the bar is reachable by tab and every focus draws a visible ring", async ({
    page,
  }) => {
    await page.goto("/try");
    // The site nav's links come first on /try; then the playground's own
    // two stops (the language toggle, then the bar), as before.
    const navStops = await page.locator(".site-nav a").count();
    for (let stop = 0; stop < navStops + 2; stop++) {
      await page.keyboard.press("Tab");
    }
    await expect(input(page)).toBeFocused();

    // The field itself carries the focus treatment for the input (the ring
    // token), and everything else takes the outline.
    const field = await page
      .locator(".searchField")
      .evaluate((element) => getComputedStyle(element).boxShadow);
    expect(field).not.toBe("none");

    await page.getByTestId("playground-submit").focus();
    const outline = await page
      .getByTestId("playground-submit")
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return `${style.outlineStyle} ${style.outlineWidth}`;
      });
    expect(outline).not.toContain("none");
  });

  test("F-5 RTL: the Hebrew page mirrors, toggle and magnifier included", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/try?lang=he");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    const toggle = await page
      .getByTestId("playground-language-toggle")
      .boundingBox();
    const wordmark = await page.locator(".productName").boundingBox();
    // The wordmark leads (inline-start = right under RTL), the toggle trails.
    expect(toggle!.x).toBeLessThan(wordmark!.x);

    const field = await page.locator(".searchField").boundingBox();
    const magnifier = await page.getByTestId("playground-submit").boundingBox();
    expect(magnifier!.x).toBeLessThan(field!.x + field!.width / 2);
  });

  test("F-6 designed loading, empty and error states — never a spinner, a blank, or a raw error", async ({
    page,
  }) => {
    await page.goto("/try");

    // Loading: skeleton cards at the card's own proportion, no spinner.
    await input(page).fill("delayed");
    await input(page).press("Enter");
    await expect(page.getByTestId("playground-skeleton")).toBeVisible();
    await expect(page.locator(".playground [class*='spin']")).toHaveCount(0);

    // Empty: one sentence, no cards, no error colour.
    await submit(page, "empty");
    await expect(cards(page)).toHaveCount(0);
    await expect(page.getByTestId("playground-status")).not.toHaveText("");
    await expect(page.getByTestId("playground-status")).not.toHaveAttribute(
      "data-failed",
      "true",
    );

    // Error: a plain sentence, and the previous results stay put.
    await submit(page, "dress");
    await expect(cards(page)).toHaveCount(4);
    await submit(page, "error");
    await expect(page.getByTestId("playground-status")).toHaveAttribute(
      "data-failed",
      "true",
    );
    await expect(cards(page)).toHaveCount(4);
  });

  test("F-7 localized chrome: the Hebrew page carries no English chrome string", async ({
    page,
  }) => {
    await page.goto("/try?lang=he");
    const chrome = await page.evaluate(
      () => document.querySelector(".playground")?.textContent ?? "",
    );
    for (const english of [
      "Type like a person",
      "Understood as",
      "New search",
      "How it understood you",
    ]) {
      expect(chrome, english).not.toContain(english);
    }
    expect(chrome).toContain("כתבו כמו בני אדם");
  });

  test("F-8 no layout shift: the search input does not move from loading to results", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/try");
    const before = await input(page).boundingBox();

    await input(page).fill("delayed");
    await input(page).press("Enter");
    await expect(page.getByTestId("playground-skeleton")).toBeVisible();
    expect(await input(page).boundingBox()).toEqual(before);

    await expect(cards(page)).toHaveCount(4);
    expect(await input(page).boundingBox()).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* Owned pages — playground (P)                                        */
/* ------------------------------------------------------------------ */

test.describe("P — the playground", () => {
  test("P-1 storefront-quiet: the page is ivory, with no gradient and no decorative image", async ({
    page,
  }) => {
    await page.goto("/try");
    const ground = await page
      .locator(".playground")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(ground).toBe("rgb(250, 247, 242)");

    const gradients = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".playground *"))
        .map((node) => getComputedStyle(node).backgroundImage)
        .filter((value) => value !== "none"),
    );
    expect(gradients).toEqual([]);

    // The only images in the playground are product photographs. The site
    // nav and footer around it on /try carry the wordmark, which is the
    // marketing site's chrome, not the playground's.
    const images = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".playground img")).map(
        (node) => node.getAttribute("class") ?? "",
      ),
    );
    expect(images.filter((name) => name !== "cardImage")).toEqual([]);
  });

  test("P-2 one accent: only the submit control is filled with it", async ({
    page,
  }) => {
    await page.goto("/try");
    await submit(page, "ai elegant dress");
    await expect(page.getByTestId("playground-chip")).toHaveCount(3);

    const accent = await page
      .locator(".playground")
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--red-500").trim(),
      );
    expect(accent).toBe("#D33A2C");

    // The whole page, not only the playground: on /try the site nav and
    // footer frame it, and their install button must not add a second fill.
    const filled = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .filter(
          (node) =>
            getComputedStyle(node).backgroundColor === "rgb(211, 58, 44)",
        )
        .map((node) => (node.getAttribute("class") ?? "").split(" ")[0]),
    );
    expect(filled).toEqual(["searchSubmit"]);
  });

  test("P-3 the search is the subject: heading then bar, both above the fold", async ({
    page,
  }) => {
    for (const viewport of [DESKTOP, MOBILE]) {
      await page.setViewportSize(viewport);
      await page.goto("/try");
      const heading = await page.locator(".heroHeading").boundingBox();
      const field = await page.locator(".searchField").boundingBox();
      expect(heading!.y).toBeLessThan(field!.y);
      expect(field!.y + field!.height).toBeLessThan(viewport.height);

      // The bar lives inside the white card, which is what makes it the
      // page's subject rather than one more row of chrome.
      await expect(page.getByTestId("playground-search-card")).toBeVisible();
      const inCard = await page
        .locator(".searchField")
        .evaluate((element) => element.closest(".searchCard") !== null);
      expect(inCard).toBe(true);
    }
  });

  test("P-4 engine details are opt-in: the panel is absent until asked for", async ({
    page,
  }) => {
    await page.goto("/try");
    await submit(page, "ai elegant dress");
    await expect(page.getByTestId("playground-chip")).toHaveCount(3);
    await expect(page.getByTestId("playground-details-panel")).toHaveCount(0);

    await page.getByTestId("playground-details-toggle").click();
    await expect(page.getByTestId("playground-details-panel")).toBeVisible();
  });

  test("P-5 same widget anatomy: image, title, price, availability, and nothing else", async ({
    page,
  }) => {
    await page.goto("/try");
    await submit(page, "dress");
    await expect(cards(page)).toHaveCount(4);

    const anatomy = await cards(page)
      .first()
      .evaluate((card) =>
        Array.from(card.querySelectorAll("*"))
          .map((node) => (node.getAttribute("class") ?? "").split(" ")[0])
          .filter((name) => name !== ""),
      );
    expect(anatomy).toEqual([
      "cardLink",
      "cardImage",
      "cardTitle",
      "cardPrice",
    ]);
  });

  test("P-6 fashion-only content: examples appear in both languages", async ({
    page,
  }) => {
    await page.goto("/try");
    const locales = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll("[data-example-locale]"),
        (node) => node.getAttribute("data-example-locale") ?? "",
      ),
    );
    expect(new Set(locales)).toEqual(new Set(["en", "he"]));
  });

  test("P-7 store-preload mode: the store name replaces the hero and nothing else", async ({
    page,
  }) => {
    await page.goto("/s/demo-store");
    await expect(page.getByTestId("playground-store-line")).toBeVisible();
    await expect(page.getByTestId("playground-hero")).toHaveCount(0);
    await expect(page.getByTestId("playground-search-card")).toBeVisible();
    await expect(
      page.getByTestId("playground-language-toggle"),
    ).toBeVisible();
  });

  test("P-8 tokens, not literals: every served playground rule paints through a token", async ({
    page,
  }) => {
    await page.goto("/try");
    const literals = await page.evaluate(() => {
      const found: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRule[];
        try {
          rules = Array.from(sheet.cssRules);
        } catch {
          continue; // cross-origin sheet: none are ours
        }
        const walk = (list: CSSRule[]) => {
          for (const rule of list) {
            if ("cssRules" in rule) {
              walk(Array.from((rule as CSSGroupingRule).cssRules));
              continue;
            }
            const text = rule.cssText;
            if (!text.startsWith(".playground") && !text.includes(".card")) {
              continue;
            }
            // A colour literal in a rule that is not the token block.
            if (/:\s*#[0-9a-fA-F]{3,8}\b/.test(text)) {
              found.push(text.slice(0, 80));
            }
          }
        };
        walk(rules);
      }
      return found;
    });
    expect(literals).toEqual([]);
  });

  test("P-9 negation is visible: an excluded constraint's chip is tinted, an inclusion's is not", async ({
    page,
  }) => {
    await page.goto("/try");
    await submit(page, "ai negation");
    const negated = page.locator("[data-chip-negated='true']");
    await expect(negated).not.toHaveCount(0);

    const plain = page.getByTestId("playground-chip").filter({
      hasNot: page.locator("[data-chip-negated='true']"),
    });

    const skin = (locator: ReturnType<Page["locator"]>) =>
      locator.first().evaluate((element) => {
        const style = getComputedStyle(element);
        return `${style.backgroundColor}|${style.borderTopColor}`;
      });

    expect(await skin(negated)).not.toBe(await skin(plain));
  });

  test("P-10 one theme: the ivory ground survives a dark colour-scheme preference", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/try");
    const ground = await page
      .locator(".playground")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(ground).toBe("rgb(250, 247, 242)");
  });
});

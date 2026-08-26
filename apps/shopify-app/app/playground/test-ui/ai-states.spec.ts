import { expect, test, type Page } from "@playwright/test";

import { PLAYGROUND_STRING_CATALOG, type PlaygroundLocale } from "../strings";

/**
 * The playground's AI states (YOY-93): chips as removable output,
 * refinement carried in the bar, the zero-hit rescue, degraded silence, the
 * opt-in engine-details panel, and the example queries. Every assertion here
 * is one of the issue's "How to verify" steps, driven against the built app
 * in fixture mode.
 */

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 360, height: 640 };

const input = (page: Page) => page.getByTestId("playground-input");
const chips = (page: Page) => page.getByTestId("playground-chip");
const cards = (page: Page) => page.getByTestId("playground-card");
const status = (page: Page) => page.getByTestId("playground-status");
const strings = (locale: PlaygroundLocale) =>
  PLAYGROUND_STRING_CATALOG[locale];

/** Every playground search request the page issues, in order. */
function recordSearchRequests(page: Page): URL[] {
  const urls: URL[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/playground/search")) {
      urls.push(new URL(request.url()));
    }
  });
  return urls;
}

async function submit(page: Page, query: string): Promise<void> {
  await input(page).fill(query);
  await input(page).press("Enter");
}

/** The submitted requests only — previews are noise for these assertions. */
const submitted = (urls: URL[]) =>
  urls.filter((url) => url.searchParams.get("mode") !== "preview");

test.describe("chips are the applied constraints (AC-1, verify 1)", () => {
  test("an AI response renders one removable pill per constraint", async ({
    page,
  }) => {
    await page.goto("/");
    await submit(page, "ai elegant dress");
    await expect(chips(page)).toHaveCount(3);
    // The remove glyph is part of the chip's text content, hence the ×.
    await expect(chips(page)).toHaveText(["dress×", "Under 400×", "Not black×"]);

    // The whole chip is the remove control, and it says so (F-3, F-4).
    await expect(chips(page).nth(2)).toHaveAttribute(
      "aria-label",
      strings("en").removeFilter.replace("{label}", "Not black"),
    );
    await expect(page.getByTestId("playground-chips")).toHaveAttribute(
      "aria-label",
      strings("en").appliedFilters,
    );
  });

  test("chip labels are localized to the chrome language (Hebrew parity)", async ({
    page,
  }) => {
    await page.goto("/?lang=he");
    await submit(page, "ai elegant dress");
    await expect(chips(page)).toHaveCount(3);
    // The currency rides the label exactly as it does in the widget, because
    // both surfaces call the same `chipLabel`.
    await expect(chips(page).nth(0)).toContainText("שמלה");
    await expect(chips(page).nth(1)).toContainText("עד 400");
    await expect(chips(page).nth(2)).toContainText("לא שחור");
  });

  test("chips never render on a preview or a classic response (W-7)", async ({
    page,
  }) => {
    await page.goto("/");

    // Preview: typing only, never submitted.
    await input(page).fill("ai elegant dress");
    await expect(cards(page)).toHaveCount(2);
    await expect(chips(page)).toHaveCount(0);

    // Classic-routed submit.
    await submit(page, "dress");
    await expect(cards(page)).toHaveCount(4);
    await expect(chips(page)).toHaveCount(0);
  });
});

test.describe("refinement (AC-2, AC-3, verify 2 and 3)", () => {
  test("removing a chip re-requests with the held intent and removeChip", async ({
    page,
  }) => {
    const urls = recordSearchRequests(page);
    await page.goto("/");
    await submit(page, "ai elegant dress");
    await expect(chips(page)).toHaveCount(3);
    await expect(cards(page)).toHaveCount(3);

    await chips(page).nth(2).click();

    await expect.poll(() => submitted(urls).length).toBe(2);
    const removal = submitted(urls)[1];
    expect(
      JSON.parse(removal.searchParams.get("removeChip") ?? "null"),
    ).toEqual({ field: "colorsExclude", value: "black" });
    const previous = JSON.parse(
      removal.searchParams.get("previousIntent") ?? "null",
    );
    expect(previous.colorsExclude).toEqual(["black"]);

    // Re-rendered from the response, not from local surgery: the chip is
    // gone AND the products it excluded are back.
    await expect(chips(page)).toHaveCount(2);
    await expect(cards(page)).toHaveCount(4);
  });

  test("a follow-up rides the held intent as previousIntent", async ({
    page,
  }) => {
    const urls = recordSearchRequests(page);
    await page.goto("/");
    await submit(page, "ai elegant dress");
    await expect(chips(page)).toHaveCount(3);

    await submit(page, "ai cheaper");
    await expect.poll(() => submitted(urls).length).toBe(2);

    const followUp = submitted(urls)[1];
    const previous = JSON.parse(
      followUp.searchParams.get("previousIntent") ?? "null",
    );
    expect(previous).toMatchObject({
      category: "dress",
      priceMax: 400,
      colorsExclude: ["black"],
    });
    expect(followUp.searchParams.get("removeChip")).toBeNull();
  });

  test("a follow-up typed at human speed still rides the held intent", async ({
    page,
  }) => {
    // Regression: previews echo `intent: null`, and replacing the held
    // intent on every response erased the refinement memory between two
    // keystrokes — so a follow-up anyone actually types (any pause ≥200ms
    // fires a preview) went out with no `previousIntent` at all. The
    // original spec missed it because fill() + immediate Enter never lets
    // the debounce fire.
    const urls = recordSearchRequests(page);
    await page.goto("/");
    await submit(page, "ai elegant dress");
    await expect(chips(page)).toHaveCount(3);

    await input(page).fill("");
    await input(page).pressSequentially("ai cheaper", { delay: 120 });
    // At least one preview has fired by now — that is the point.
    await expect
      .poll(() =>
        urls.filter((url) => url.searchParams.get("mode") === "preview")
          .length,
      )
      .toBeGreaterThan(0);
    // And the way out of the search is still offered while typing.
    await expect(page.getByTestId("playground-new-search")).toBeVisible();

    await input(page).press("Enter");
    await expect.poll(() => submitted(urls).length).toBe(2);
    const followUp = submitted(urls)[1];
    expect(
      JSON.parse(followUp.searchParams.get("previousIntent") ?? "null"),
    ).toMatchObject({ colorsExclude: ["black"] });
  });

  test("the first submitted search carries no previousIntent", async ({
    page,
  }) => {
    const urls = recordSearchRequests(page);
    await page.goto("/");
    await submit(page, "ai elegant dress");
    await expect(chips(page)).toHaveCount(3);
    expect(submitted(urls)[0].searchParams.get("previousIntent")).toBeNull();
  });

  test("New search clears everything and drops the held intent", async ({
    page,
  }) => {
    const urls = recordSearchRequests(page);
    await page.goto("/");

    // Not offered until there is an understanding to drop.
    await expect(page.getByTestId("playground-new-search")).toHaveCount(0);

    await submit(page, "ai elegant dress");
    await expect(chips(page)).toHaveCount(3);
    await expect(page.getByTestId("playground-new-search")).toBeVisible();

    await page.getByTestId("playground-new-search").click();

    await expect(input(page)).toHaveValue("");
    await expect(chips(page)).toHaveCount(0);
    await expect(cards(page)).toHaveCount(0);
    await expect(status(page)).toHaveText(strings("en").initialHint);

    await submit(page, "ai elegant dress");
    await expect.poll(() => submitted(urls).length).toBe(2);
    expect(submitted(urls)[1].searchParams.get("previousIntent")).toBeNull();
  });

  test("it is the only secondary button on the page (P-2)", async ({
    page,
  }) => {
    await page.goto("/");
    await submit(page, "ai elegant dress");
    await expect(page.getByTestId("playground-new-search")).toBeVisible();

    // The magnifier is the one primary action; every other button on the
    // page is a chip, an example link, or this.
    const buttons = await page
      .locator(".playground button")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.className.split(" ")[0]),
      );
    for (const className of buttons) {
      expect([
        "searchSubmit",
        "chip",
        "exampleQuery",
        "newSearch",
      ]).toContain(className);
    }
    expect(buttons.filter((name) => name === "newSearch")).toHaveLength(1);
  });
});

test.describe("zero hit, degraded, and colorUnknown (AC-4, verify 4)", () => {
  test("an AI zero hit names what did not match and offers close matches", async ({
    page,
  }) => {
    await page.goto("/");
    await submit(page, "ai zero hit");

    await expect(status(page)).toHaveText(strings("en").zeroHit);
    // The chips stay, and stay removable: the way out of a zero hit is to
    // drop a constraint.
    await expect(chips(page)).toHaveCount(3);
    await expect(
      page.getByRole("heading", { name: strings("en").closeMatchesHeading }),
    ).toBeVisible();
    await expect(cards(page)).toHaveCount(2);
  });

  test("a degraded response is plain classic cards with no chips and no error language", async ({
    page,
  }) => {
    await page.goto("/");
    await submit(page, "degraded");

    await expect(cards(page)).toHaveCount(3);
    await expect(chips(page)).toHaveCount(0);
    // Nothing announces the degradation to the visitor (W-8, X-4).
    await expect(status(page)).toHaveText("");
    await expect(page.getByTestId("playground-new-search")).toHaveCount(0);
  });

  test("a colorUnknown card is labelled and de-emphasised (widget parity)", async ({
    page,
  }) => {
    await page.goto("/");
    await submit(page, "ai color beige");

    const first = cards(page).nth(0);
    await expect(
      first.getByTestId("playground-card-color-unknown"),
    ).toHaveText(strings("en").colorNotConfirmed);
    await expect(first).toHaveAttribute("data-color-unknown", "true");

    const opacity = await first.evaluate(
      (element) => getComputedStyle(element).opacity,
    );
    expect(Number.parseFloat(opacity)).toBeLessThan(1);

    // Only that card is dimmed.
    await expect(
      cards(page).nth(1).getByTestId("playground-card-color-unknown"),
    ).toHaveCount(0);
  });
});

test.describe("engine details (AC-5, verify 5)", () => {
  test("is off by default and absent from the DOM", async ({ page }) => {
    await page.goto("/");
    await submit(page, "ai elegant dress");
    await expect(chips(page)).toHaveCount(3);

    await expect(page.getByTestId("playground-details-toggle")).toBeVisible();
    await expect(page.locator("[data-engine-details]")).toHaveCount(0);
  });

  test("opens onto the answer already on screen, without re-searching", async ({
    page,
  }) => {
    // Regression: the toggle was a plain link, so clicking it reloaded the
    // page — discarding the response, the chips, and the memory-only held
    // intent, and showing an empty panel until the visitor searched again.
    const urls = recordSearchRequests(page);
    await page.goto("/");
    await submit(page, "ai elegant dress");
    await expect(chips(page)).toHaveCount(3);

    await page.getByTestId("playground-details-toggle").click();

    await expect(page).toHaveURL(/details=1/);
    const opened = page.getByTestId("playground-details-panel");
    await expect(opened).toBeVisible();
    await expect(opened).toContainText("812 ms");
    await expect(
      page.getByTestId("playground-details-intent"),
    ).toContainText('"category": "dress"');
    // The answer it explains is untouched, and nothing was re-fetched.
    await expect(chips(page)).toHaveCount(3);
    expect(submitted(urls)).toHaveLength(1);

    // Clicking again closes it and takes the parameter back out.
    await page.getByTestId("playground-details-toggle").click();
    await expect(opened).toHaveCount(0);
    await expect(page).not.toHaveURL(/details=1/);
  });

  test("shows route, reason, latency, and the intent", async ({ page }) => {
    await page.goto("/?details=1");
    await submit(page, "ai elegant dress");
    const panel = page.getByTestId("playground-details-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("ai");
    await expect(panel).toContainText("model");
    await expect(panel).toContainText("812 ms");

    const intent = page.getByTestId("playground-details-intent");
    await expect(intent).toContainText('"category": "dress"');
    await expect(intent).toContainText('"priceMax": 400');
  });

  test("lists one row per stage the search ran, in pipeline order (YOY-114 AC-2)", async ({
    page,
  }) => {
    await page.goto("/?details=1");
    await submit(page, "ai elegant dress");
    const rows = page.getByTestId("playground-details-stages").locator("li");
    // The AI fixture ran classify → intent → embed → retrieve → hydrate; no
    // classic and no closeMatches row, because those stages did not run.
    await expect(rows).toHaveText([
      "classify · 38 ms",
      "intent · 412 ms",
      "embed · 96 ms",
      "retrieve · 57 ms",
      "hydrate · 9 ms",
    ]);

    // A classic search shows only the stages a keyword search runs — the
    // absent intent/embed/retrieve rows are the proof of zero LLM calls, and
    // the absent hydrate row is the one-statement search (YOY-115 AC-3):
    // `classify`, `classic`, and nothing else.
    await submit(page, "dress");
    await expect(rows).toHaveText(["classify · 1 ms", "classic · 28 ms"]);
    await expect(rows.filter({ hasText: "hydrate" })).toHaveCount(0);

    // Every row is numeric milliseconds in the `<stage> · <ms> ms` form.
    for (const text of await rows.allTextContents()) {
      expect(text).toMatch(/^[a-zA-Z]+ · \d+ ms$/);
    }
  });

  test("names the intent tier: lite on the AI fixture, none on a classic response (YOY-116 AC-3)", async ({
    page,
  }) => {
    await page.goto("/?details=1");
    await submit(page, "ai elegant dress");
    const panel = page.getByTestId("playground-details-panel");
    await expect(panel).toContainText(`${strings("en").detailsIntentTier}lite`);

    await submit(page, "dress");
    await expect(panel).toContainText(
      `${strings("en").detailsIntentTier}${strings("en").detailsNone}`,
    );
    await expect(panel).not.toContainText("accuracy");
  });

  test("a reused intent reads reason intent-reuse with no classify or intent row (YOY-64 AC-4)", async ({
    page,
  }) => {
    await page.goto("/?details=1");
    await submit(page, "ai reuse elegant dress");
    const panel = page.getByTestId("playground-details-panel");
    await expect(panel).toContainText("intent-reuse");
    const rows = page.getByTestId("playground-details-stages").locator("li");
    await expect(rows).toHaveText(["embed · 1 ms", "retrieve · 52 ms", "hydrate · 8 ms"]);
    await expect(rows.filter({ hasText: "classify" })).toHaveCount(0);
    await expect(rows.filter({ hasText: "intent" })).toHaveCount(0);
    // Still the AI answer: chips and results as on any AI response.
    await expect(chips(page)).toHaveCount(3);
  });

  test("the stage rows exist only while the panel is open", async ({ page }) => {
    await page.goto("/");
    await submit(page, "ai elegant dress");
    await expect(chips(page)).toHaveCount(3);
    await expect(page.getByTestId("playground-details-stages")).toHaveCount(0);

    await page.getByTestId("playground-details-toggle").click();
    await expect(page.getByTestId("playground-details-stages")).toBeVisible();

    await page.getByTestId("playground-details-toggle").click();
    await expect(page.getByTestId("playground-details-stages")).toHaveCount(0);
  });

  test("a zero-hit response adds the closeMatches row last", async ({
    page,
  }) => {
    await page.goto("/?details=1");
    await submit(page, "ai zero hit dress");
    const rows = page.getByTestId("playground-details-stages").locator("li");
    await expect(rows).toHaveCount(5);
    await expect(rows.last()).toHaveText("closeMatches · 63 ms");
  });

  test("the intent block is the only monospace on the page (DESIGN §2)", async ({
    page,
  }) => {
    await page.goto("/?details=1");
    await submit(page, "ai elegant dress");
    await expect(page.getByTestId("playground-details-panel")).toBeVisible();

    const monospaced = await page.evaluate(() => {
      const found: string[] = [];
      document.querySelectorAll<HTMLElement>(".playground *").forEach((node) => {
        if (node.childElementCount > 0) {
          return;
        }
        const family = getComputedStyle(node).fontFamily.toLowerCase();
        if (family.includes("mono")) {
          found.push(node.tagName);
        }
      });
      return found;
    });
    expect(monospaced).toEqual(["CODE"]);
  });

  test("a reload keeps the panel open", async ({ page }) => {
    await page.goto("/?details=1");
    await submit(page, "ai elegant dress");
    await expect(page.getByTestId("playground-details-panel")).toBeVisible();

    await page.reload();
    await submit(page, "ai elegant dress");
    await expect(page.getByTestId("playground-details-panel")).toBeVisible();
  });

  test("switching language keeps it open", async ({ page }) => {
    await page.goto("/?details=1");
    await page.getByTestId("playground-language-toggle").click();
    await expect(page).toHaveURL(/lang=he/);
    await expect(page).toHaveURL(/details=1/);
  });
});

test.describe("example queries (AC-6, verify 6)", () => {
  test("shows six — four in the chrome language, two in the other", async ({
    page,
  }) => {
    await page.goto("/");
    const examples = page.getByTestId("playground-example");
    await expect(examples).toHaveCount(6);

    const locales = await examples.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-example-locale")),
    );
    expect(locales.filter((locale) => locale === "en")).toHaveLength(4);
    expect(locales.filter((locale) => locale === "he")).toHaveLength(2);

    // Each carries its own direction, so a Hebrew example inside English
    // chrome renders right (X-7).
    await expect(examples.nth(4)).toHaveAttribute("dir", "rtl");
    await expect(examples.nth(4)).toHaveAttribute("lang", "he");
    await expect(examples.nth(0)).toHaveAttribute("dir", "ltr");
  });

  test("mirrors the split under Hebrew chrome", async ({ page }) => {
    await page.goto("/?lang=he");
    const locales = await page
      .getByTestId("playground-example")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-example-locale")),
      );
    expect(locales.filter((locale) => locale === "he")).toHaveLength(4);
    expect(locales.filter((locale) => locale === "en")).toHaveLength(2);
  });

  test("clicking one fills the input and submits it", async ({ page }) => {
    const urls = recordSearchRequests(page);
    await page.goto("/");

    const first = page.getByTestId("playground-example").nth(0);
    const text = (await first.textContent()) ?? "";
    await first.click();

    await expect(input(page)).toHaveValue(text);
    await expect.poll(() => submitted(urls).length).toBeGreaterThan(0);
    expect(submitted(urls)[0].searchParams.get("query")).toBe(text);
  });

  test("a clicked example is not overridden by its own debounced preview", async ({
    page,
  }) => {
    // Regression: `pickExample` set the query and submitted, and the
    // query-change effect then scheduled a preview for the same text that
    // aborted the in-flight submitted search 200ms later — replacing a real
    // AI answer with classic preview cards. Any search slower than the
    // debounce lost, which is every AI search the examples exist to show.
    const urls = recordSearchRequests(page);
    await page.goto("/");

    await page.getByTestId("playground-example").nth(0).click();
    await expect.poll(() => submitted(urls).length).toBe(1);
    await expect(cards(page)).toHaveCount(4);

    // Well past the debounce: nothing may follow the submit.
    await page.waitForTimeout(500);
    expect(
      urls.filter((url) => url.searchParams.get("mode") === "preview"),
    ).toHaveLength(0);
    await expect(cards(page)).toHaveCount(4);
  });

  test("collapses to a single Try: row once a search has run", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/");
    const examples = page.getByTestId("playground-examples");
    await expect(examples).toHaveAttribute("data-collapsed", "false");

    await submit(page, "ai elegant dress");
    await expect(chips(page)).toHaveCount(3);
    await expect(examples).toHaveAttribute("data-collapsed", "true");
    await expect(examples).toContainText(strings("en").examplesLead);
  });

  test("the collapsed Try: row stays one row on a narrow viewport and the chips stay above the fold (YOY-96 AC-15)", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/");
    const examples = page.getByTestId("playground-examples");
    await submit(page, "ai elegant dress");
    await expect(chips(page)).toHaveCount(3);
    await expect(examples).toHaveAttribute("data-collapsed", "true");

    // One row: the six 44px controls no longer wrap into a ~260px stack.
    const box = await examples.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThanOrEqual(56);
    // Every example keeps its hit target (F-3) inside the scrolling row.
    for (const example of await page.getByTestId("playground-example").all()) {
      const target = await example.boundingBox();
      expect(target!.height).toBeGreaterThanOrEqual(44);
    }
    // The answer is above the fold: the chip row starts inside the viewport.
    const chipRow = await page.getByTestId("playground-chips").boundingBox();
    expect(chipRow).not.toBeNull();
    expect(chipRow!.y).toBeLessThan(640);
  });

  test("they are links, never pills (P-2)", async ({ page }) => {
    await page.goto("/");
    const radius = await page
      .getByTestId("playground-example")
      .nth(0)
      .evaluate((element) => getComputedStyle(element).borderTopLeftRadius);
    // A pill would carry the pill radius; these are underlined text.
    expect(radius).toBe("0px");
  });
});

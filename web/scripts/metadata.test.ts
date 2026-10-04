import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
if (!match) throw new Error("Application structured data is missing");
const app = JSON.parse(match[1]!);

test("free browser app declares its actual zero-price offer", () => {
  expect(app["@type"]).toBe("WebApplication");
  expect(app.isAccessibleForFree).toBe(true);
  expect(app.offers).toEqual({
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    url: "https://stratastudio.jonathanrreed.com/",
  });
});

test("application modification date agrees with its sitemap entry", () => {
  const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  expect(sitemap).toContain(`<lastmod>${app.dateModified}</lastmod>`);
});

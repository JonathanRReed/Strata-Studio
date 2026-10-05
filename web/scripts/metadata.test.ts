import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const origin = "https://stratastudio.jonathanrreed.com/";
const description = "Turn any place on Earth into poster art. Real terrain and OpenStreetMap data rendered as contours, ridgelines, waveforms, and flow fields. Free, in your browser, with no account.";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
if (!match) throw new Error("Site structured data is missing");
const data = JSON.parse(match[1]!);
const nodes = data["@graph"] ?? [data];
const website = nodes.find((node: Record<string, unknown>) => node["@type"] === "WebSite");
const page = nodes.find((node: Record<string, unknown>) => node["@type"] === "WebPage");

function assertNoUnsupportedClaims(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoUnsupportedClaims);
  } else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const types = Array.isArray(object["@type"]) ? object["@type"] : [object["@type"]];
    for (const type of types) {
      assert.ok(!["SoftwareApplication", "WebApplication", "MobileApplication"].includes(String(type)));
    }
    for (const key of ["aggregateRating", "review", "ratingValue", "ratingCount", "reviewCount", "offers"]) {
      assert.equal(Object.hasOwn(object, key), false, `Unsupported ${key} claim`);
    }
    Object.values(object).forEach(assertNoUnsupportedClaims);
  }
}

test("an unrated site retains truthful website and webpage metadata", () => {
  assert.equal(data["@context"], "https://schema.org");
  assert.ok(website, "WebSite metadata must remain");
  assert.ok(page, "WebPage metadata must remain");
  for (const node of [website, page]) {
    assert.equal(node.name, "Strata Studio");
    assert.equal(node.url, origin);
    assert.equal(node.description, description);
    assert.equal(node.isAccessibleForFree, true);
  }
});

test("site metadata contains no unsupported software, rating, review, or offer claims", () => {
  assertNoUnsupportedClaims(data);
});

test("the webpage connects to the website and the real creator", () => {
  assert.ok(website, "WebSite metadata must remain");
  assert.ok(page, "WebPage metadata must remain");
  assert.equal(website["@id"], `${origin}#website`);
  assert.equal(page["@id"], `${origin}#webpage`);
  assert.deepEqual(page.isPartOf, { "@id": website["@id"] });
  assert.deepEqual(page.creator, {
    "@type": "Person",
    name: "Jonathan R. Reed",
    url: "https://jonathanrreed.com/",
  });
  assert.deepEqual(page.primaryImageOfPage, {
    "@type": "ImageObject",
    url: `${origin}og.png`,
  });
});

test("page modification date agrees with its sitemap entry", () => {
  assert.ok(page, "WebPage metadata must remain");
  assert.match(page.dateModified, /^\d{4}-\d{2}-\d{2}$/);
  const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  assert.ok(sitemap.includes(`<lastmod>${page.dateModified}</lastmod>`));
});

test("canonical and social metadata stay on the branded public origin", () => {
  assert.ok(html.includes(`<link rel="canonical" href="${origin}" />`));
  assert.ok(html.includes(`<meta property="og:url" content="${origin}" />`));
  assert.ok(html.includes(`<meta property="og:image" content="${origin}og.png" />`));
  assert.ok(html.includes(`<meta name="twitter:image" content="${origin}og.png" />`));
});

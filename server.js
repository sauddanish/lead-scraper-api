import express from "express";
import cors from "cors";
import { PlaywrightCrawler } from "crawlee";
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";

// Activate open-source stealth patches
chromium.use(stealthPlugin());

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// -------------------- BUILD SEARCH URL --------------------
function buildTargetUrl({ query, country, city, industry, jobTitle }) {
  const searchParts = [query, industry, jobTitle, city, country]
    .filter(Boolean)
    .join(" ");

  return `https://www.google.com/search?q=${encodeURIComponent(searchParts)}&num=10`;
}

// -------------------- BLOCKED DOMAINS --------------------
function isValidBusinessLink(url) {
  const blocked = [
    "google.com", "facebook.com", "linkedin.com", "instagram.com",
    "twitter.com", "x.com", "youtube.com", "maps.google", "support.google"
  ];
  return !blocked.some((d) => url.includes(d));
}

function extractBusinessLinks(html) {
  const links = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
  return links.filter(
    (link) => isValidBusinessLink(link) && !link.includes("search?")
  );
}

function extractEmails(text) {
  return [...new Set(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])];
}

function extractPhones(text) {
  return [...new Set(text.match(/(\+?\d[\d\s().-]{7,}\d)/g) || [])];
}

// -------------------- SCRAPER ENGINE --------------------
async function scrapeLeadWebsite(startUrl, maxPages = 3) {
  const safeMaxPages = Math.min(Number(maxPages) || 3, 3);
  const visited = new Set();
  const queued = new Set();

  const pages = [];
  const emailsSet = new Set();
  const phonesSet = new Set();
  const businessLinksSet = new Set();

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: safeMaxPages,
    minConcurrency: 1,
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 60000,

    // ✅ FIXED PERMANENTLY: Launcher positioned correctly for Crawlee standard formats
    launchContext: {
      launcher: chromium,
      launchOptions: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-blink-features=AutomationControlled"
        ],
      },
    },

    preNavigationHooks: [
      async ({ page }) => {
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        );
      },
    ],

    async requestHandler({ request, page }) {
      const currentUrl = request.url;
      if (visited.has(currentUrl)) return;
      visited.add(currentUrl);

      await page.waitForTimeout(Math.floor(Math.random() * 2000) + 2000);

      if (page.url().includes("sorry/index")) {
        console.error("⚠️ Caught by Google Bot Detection.");
        return;
      }

      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const html = await page.content().catch(() => "");

      const emails = extractEmails(bodyText + " " + html);
      emails.forEach((e) => emailsSet.add(e));

      const phones = extractPhones(bodyText);
      phones.forEach((p) => phonesSet.add(p));

      const businessLinks = extractBusinessLinks(html);
      businessLinks.forEach((l) => businessLinksSet.add(l));

      pages.push({ url: currentUrl, title, emails, phones });

      const newRequests = [];
      for (const link of businessLinks.slice(0, 5)) {
        try {
          const clean = link.split("#")[0];
          if (!visited.has(clean) && !queued.has(clean)) {
            queued.add(clean);
            newRequests.push({ url: clean });
          }
        } catch {}
      }

      if (newRequests.length > 0) {
        await crawler.addRequests(newRequests.slice(0, 2));
      }
    },
  });

  // ✅ FIXED PERMANENTLY: Add initial target directly as a string array parameter
  await crawler.addRequests([startUrl]);
  await crawler.run();

  return {
    scrapedDomain: new URL(startUrl).origin,
    totalPagesScraped: pages.length,
    emails: [...emailsSet],
    phones: [...phonesSet],
    businessLinks: [...businessLinksSet],
    pages,
  };
}

// -------------------- MAIN API --------------------
app.post("/scrape", async (req, res) => {
  try {
    const { url, query, country, city, industry, jobTitle, maxPages } = req.body;

    let targetUrl = url;
    if (!targetUrl) {
      targetUrl = buildTargetUrl({ query, country, city, industry, jobTitle });
    }

    console.log(`Starting execution sequence for: ${targetUrl}`);
    const result = await scrapeLeadWebsite(targetUrl, maxPages || 3);

    res.json({
      success: true,
      filtersUsed: { url, query, country, city, industry, jobTitle },
      meta: {
        emailsFound: result.emails.length,
        phonesFound: result.phones.length,
        businessLinksFound: result.businessLinks.length,
        pagesScraped: result.totalPagesScraped,
      },
      data: result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/", (req, res) => res.json({ success: true, message: "API running" }));
app.get("/health", (req, res) => res.json({ success: true, status: "healthy" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Scraper running on port ${PORT}`);
});

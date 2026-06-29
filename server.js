import express from "express";
import cors from "cors";
import { PlaywrightCrawler } from "crawlee";

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
    "google.com",
    "facebook.com",
    "linkedin.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "youtube.com",
    "maps.google",
    "support.google",
  ];

  return !blocked.some((d) => url.includes(d));
}

// -------------------- EXTRACT BUSINESS LINKS FROM HTML --------------------
function extractBusinessLinks(html) {
  const links = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);

  return links.filter(
    (link) =>
      isValidBusinessLink(link) &&
      !link.includes("google.com") &&
      !link.includes("search?")
  );
}

// -------------------- EMAIL EXTRACTION --------------------
function extractEmails(text) {
  return [
    ...new Set(
      text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []
    ),
  ];
}

// -------------------- PHONE EXTRACTION --------------------
function extractPhones(text) {
  return [
    ...new Set(text.match(/(\+?\d[\d\s().-]{7,}\d)/g) || []),
  ];
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

    launchContext: {
      launchOptions: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--single-process",
          "--no-zygote",
          "--disable-gpu",
        ],
      },
    },

    async requestHandler({ request, page }) {
      const currentUrl = request.url;

      if (visited.has(currentUrl)) return;
      visited.add(currentUrl);

      await page.goto(currentUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      }).catch(() => null);

      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const html = await page.content().catch(() => "");

      // ---------------- EMAILS ----------------
      const emails = extractEmails(bodyText + " " + html);
      emails.forEach((e) => emailsSet.add(e));

      // ---------------- PHONES ----------------
      const phones = extractPhones(bodyText);
      phones.forEach((p) => phonesSet.add(p));

      // ---------------- LINKS ----------------
      const links = await page.$$eval("a[href]", (a) =>
        a.map((x) => x.href)
      ).catch(() => []);

      const businessLinks = extractBusinessLinks(html);

      businessLinks.forEach((l) => businessLinksSet.add(l));

      pages.push({
        url: currentUrl,
        title,
        emails,
        phones,
      });

      // ---------------- EXPAND ONLY REAL BUSINESS LINKS ----------------
      const newRequests = [];

      for (const link of businessLinks.slice(0, 5)) {
        try {
          const clean = link.split("#")[0];

          if (
            !visited.has(clean) &&
            !queued.has(clean)
          ) {
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

  await crawler.run([{ url: startUrl }]);

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
    const {
      url,
      query,
      country,
      city,
      industry,
      jobTitle,
      maxPages,
    } = req.body;

    let targetUrl = url;

    // AUTO BUILD SEARCH QUERY
    if (!targetUrl) {
      targetUrl = buildTargetUrl({
        query,
        country,
        city,
        industry,
        jobTitle,
      });
    }

    const result = await scrapeLeadWebsite(targetUrl, maxPages || 3);

    res.json({
      success: true,

      filtersUsed: {
        url,
        query,
        country,
        city,
        industry,
        jobTitle,
      },

      meta: {
        emailsFound: result.emails.length,
        phonesFound: result.phones.length,
        businessLinksFound: result.businessLinks.length,
        pagesScraped: result.totalPagesScraped,
      },

      data: result,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// -------------------- HEALTH ROUTES --------------------
app.get("/", (req, res) => {
  res.json({ success: true, message: "API running" });
});

app.get("/health", (req, res) => {
  res.json({ success: true, status: "healthy" });
});

// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Scraper running on port ${PORT}`);
});

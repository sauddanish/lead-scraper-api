import express from "express";
import cors from "cors";
import { PlaywrightCrawler } from "crawlee";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// -------------------- URL BUILDER (NEW) --------------------
function buildTargetUrl({ query, country, city, industry }) {
  const searchParts = [query, industry, city, country]
    .filter(Boolean)
    .join(" ");

  return `https://www.google.com/search?q=${encodeURIComponent(searchParts)}`;
}

// -------------------- SCRAPER --------------------
async function scrapeLeadWebsite(startUrl, maxPages = 3) {
  const origin = new URL(startUrl).origin;

  const safeMaxPages = Math.min(Number(maxPages) || 3, 3);

  const visited = new Set();
  const queued = new Set();

  const pages = [];
  const emailsSet = new Set();
  const phonesSet = new Set();
  const socialLinks = [];

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
          "--disable-gpu"
        ],
      },
    },

    async requestHandler({ request, page }) {
      const currentUrl = request.url;

      if (visited.has(currentUrl)) return;
      visited.add(currentUrl);

      try {
        await page.goto(currentUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
      } catch {
        return;
      }

      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const html = await page.content().catch(() => "");

      const emails = [...new Set(
        (bodyText + " " + html).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []
      )];

      const phones = [...new Set(
        bodyText.match(/(\+?\d[\d\s().-]{7,}\d)/g) || []
      )];

      emails.forEach(e => emailsSet.add(e));
      phones.forEach(p => phonesSet.add(p));

      const links = await page.$$eval("a[href]", a => a.map(x => x.href)).catch(() => []);
      socialLinks.push(...links);

      pages.push({
        url: currentUrl,
        title,
        emails,
        phones,
      });

      // LIMIT EXPANSION
      const newRequests = [];

      for (const link of links.slice(0, 10)) {
        try {
          const clean = link.split("#")[0];
          const parsed = new URL(clean);

          if (
            parsed.origin === origin &&
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
    scrapedDomain: origin,
    totalPagesScraped: pages.length,
    emails: [...emailsSet],
    phones: [...phonesSet],
    socials: socialLinks,
    pages,
  };
}

// -------------------- MAIN API (UPDATED) --------------------
app.post("/scrape", async (req, res) => {
  try {
    const {
      url,
      query,
      country,
      city,
      industry,
      jobTitle,
      source,
      maxPages
    } = req.body;

    let targetUrl = url;

    // 🔥 AUTO GENERATE URL FROM FILTERS (IMPORTANT)
    if (!targetUrl) {
      targetUrl = buildTargetUrl({
        query,
        country,
        city,
        industry,
        jobTitle
      });
    }

    const result = await scrapeLeadWebsite(
      targetUrl,
      maxPages || 3
    );

    res.json({
      success: true,
      filtersUsed: {
        url,
        query,
        country,
        city,
        industry,
        jobTitle,
        source
      },
      data: result
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// -------------------- ROUTES --------------------
app.get("/", (req, res) => {
  res.json({ success: true, message: "API running" });
});

app.get("/health", (req, res) => {
  res.json({ success: true, status: "healthy" });
});

// -------------------- START --------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Scraper running on port ${PORT}`);
});

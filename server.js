import express from "express";
import cors from "cors";
import { PlaywrightCrawler } from "crawlee";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// -------------------- URL NORMALIZER --------------------
function normalizeUrl(input) {
  if (!input) throw new Error("URL is required");

  let url = input.trim();

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  return new URL(url).toString();
}

// -------------------- EXTRACTORS --------------------
function extractEmails(text) {
  return [...new Set(
    text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []
  )];
}

function extractPhones(text) {
  return [...new Set(
    text.match(/(\+?\d[\d\s().-]{7,}\d)/g) || []
  )];
}

function isPriorityPage(url) {
  const lower = url.toLowerCase();

  return (
    lower.includes("contact") ||
    lower.includes("about") ||
    lower.includes("team") ||
    lower.includes("staff") ||
    lower.includes("people") ||
    lower.includes("leadership")
  );
}

function extractSocialLinks(links) {
  const unique = [...new Set(links)];

  return {
    linkedin: unique.filter(l => l.includes("linkedin.com")),
    facebook: unique.filter(l => l.includes("facebook.com")),
    instagram: unique.filter(l => l.includes("instagram.com")),
    twitter: unique.filter(l =>
      l.includes("twitter.com") || l.includes("x.com")
    ),
  };
}

// -------------------- MAIN SCRAPER --------------------
async function scrapeLeadWebsite(startUrl, maxPages = 3) {
  const url = normalizeUrl(startUrl);
  const origin = new URL(url).origin;

  const safeMaxPages = Math.min(Number(maxPages) || 3, 3);

  const visited = new Set();
  const queued = new Set();

  const pages = [];
  const emailsSet = new Set();
  const phonesSet = new Set();
  const socialLinks = [];

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: safeMaxPages,

    // 🔥 CRITICAL FIX: VPS STABILITY
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
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-sync",
          "--mute-audio",
          "--no-first-run"
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

      const emails = extractEmails(bodyText + " " + html);
      const phones = extractPhones(bodyText);

      emails.forEach(e => emailsSet.add(e));
      phones.forEach(p => phonesSet.add(p));

      const links = await page.$$eval("a[href]", a =>
        a.map(x => x.href)
      ).catch(() => []);

      socialLinks.push(...links);

      pages.push({
        url: currentUrl,
        title,
        emails,
        phones,
      });

      // 🔥 LIMIT LINK EXPANSION (IMPORTANT FIX)
      const newRequests = [];

      for (const link of links.slice(0, 15)) {
        try {
          const clean = link.split("#")[0];
          const parsed = new URL(clean);

          if (
            parsed.origin === origin &&
            !visited.has(clean) &&
            !queued.has(clean) &&
            isPriorityPage(clean)
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

    failedRequestHandler({ request }) {
      pages.push({
        url: request.url,
        error: "Scrape failed",
      });
    },
  });

  await crawler.run([{ url }]);

  return {
    inputUrl: startUrl,
    scrapedDomain: origin,
    totalPagesScraped: pages.length,
    emails: [...emailsSet],
    phones: [...phonesSet],
    socials: extractSocialLinks(socialLinks),
    pages,
  };
}

// -------------------- ROUTES --------------------
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Lead Scraper API is running",
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
  });
});

app.post("/scrape", async (req, res) => {
  try {
    const { url, maxPages } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: "URL is required",
      });
    }

    const result = await scrapeLeadWebsite(url, maxPages || 3);

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// -------------------- SERVER --------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Lead Scraper API running on port ${PORT}`);
});
